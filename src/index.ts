import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareVersions, diffPackages, readAtRef } from './diff.ts';
import { parseLockfile } from './lockfile.ts';
import { createFetchJson, createRegistry, type FetchJson } from './registry.ts';
import { evaluate, repoVersionsNeeded } from './rules.ts';
import type { Change, Finding, RuleId, Severity, Unverified } from './types.ts';

export type { FetchJson, FetchJsonOptions, History } from './registry.ts';
export { createFetchJson, RegistryError } from './registry.ts';
export type { OutputFormat } from './report.ts';
export { render } from './report.ts';
export type * from './types.ts';

export const RULE_IDS: readonly RuleId[] = [
  'trust-downgrade',
  'source-repo-changed',
  'install-script-added',
  'publisher-changed',
];

export const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'] as const;

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/** Accept a finding on purpose. `reason` is required so every exception is explained in review. */
export interface AllowEntry {
  name: string;
  rule: RuleId;
  /** Only this exact version. Omit to allow every version of the package for this rule. */
  version?: string;
  reason: string;
}

export interface CheckOptions {
  /** Project directory. Default `process.cwd()`. */
  cwd?: string;
  /** Lockfile path relative to `cwd`. Default: the first of `LOCKFILES` that exists. */
  lockfile?: string;
  /** Git ref to compare against (e.g. `origin/main`). Set → only changed packages are checked; unset → all. */
  base?: string;
  /** Change a rule's severity or turn it off. */
  rules?: Partial<Record<RuleId, Severity | 'off'>>;
  allow?: AllowEntry[];
  /** Registry base URL. Default `$npm_config_registry`, else `https://registry.npmjs.org`. */
  registry?: string;
  /** Extra registry request headers, e.g. auth for a private mirror. Ignored when `fetchJson` is given. */
  headers?: Record<string, string>;
  /** Parallel registry requests. Default 8. Ignored when `fetchJson` is given. */
  concurrency?: number;
  /** Replace the HTTP layer entirely (tests, proxies, caching). */
  fetchJson?: FetchJson;
}

export interface CheckResult {
  /** Number of package versions checked. */
  checked: number;
  findings: Finding[];
  unverified: Unverified[];
  /** 1 when any finding has severity `error`, else 0. */
  exitCode: 0 | 1;
}

function validate(options: CheckOptions): void {
  for (const [rule, level] of Object.entries(options.rules ?? {})) {
    if (!RULE_IDS.includes(rule as RuleId)) throw new Error(`unknown rule "${rule}" (expected ${RULE_IDS.join(', ')})`);
    if (!['error', 'warn', 'off'].includes(level as string)) {
      throw new Error(`rule ${rule}: severity must be "error", "warn" or "off", got "${level}"`);
    }
  }
  for (const entry of options.allow ?? []) {
    if (!entry?.name) throw new Error('allowlist entry needs a name');
    if (!RULE_IDS.includes(entry.rule))
      throw new Error(`allowlist entry for ${entry.name} has unknown rule "${entry.rule}"`);
    if (!entry.reason?.trim()) throw new Error(`allowlist entry for ${entry.name} needs a reason`);
  }
}

function findLockfile(cwd: string, lockfile?: string): string {
  if (lockfile) {
    if (!existsSync(join(cwd, lockfile))) throw new Error(`lockfile not found: ${join(cwd, lockfile)}`);
    return lockfile;
  }
  const found = LOCKFILES.find((name) => existsSync(join(cwd, name)));
  if (!found) throw new Error(`no lockfile found in ${cwd} (looked for ${LOCKFILES.join(', ')})`);
  return found;
}

function listChanges(cwd: string, lockfile: string, base?: string): Change[] {
  const head = parseLockfile(lockfile, readFileSync(join(cwd, lockfile), 'utf8'));
  if (base === undefined) return diffPackages(new Map(), head);
  const before = readAtRef(base, lockfile, cwd);
  return diffPackages(before === undefined ? new Map() : parseLockfile(lockfile, before), head);
}

/**
 * Checks a project's lockfile against each package's own release history.
 * Throws on tool failures (no lockfile, bad options, registry unreachable) — never passes silently.
 */
export async function check(options: CheckOptions = {}): Promise<CheckResult> {
  validate(options);
  const cwd = options.cwd ?? process.cwd();
  const changes = listChanges(cwd, findLockfile(cwd, options.lockfile), options.base);
  const fetchJson =
    options.fetchJson ?? createFetchJson({ concurrency: options.concurrency, headers: options.headers });
  const registry = createRegistry(fetchJson, options.registry ?? process.env.npm_config_registry ?? DEFAULT_REGISTRY);

  const byName = new Map<string, Change[]>();
  for (const change of changes) byName.set(change.name, [...(byName.get(change.name) ?? []), change]);
  const findings: Finding[] = [];
  const unverified: Unverified[] = [];
  await Promise.all(
    [...byName].map(async ([name, group]) => {
      const history = await registry.history(name);
      for (const change of group) {
        if ('reason' in history) {
          unverified.push({ name, version: change.to, reason: history.reason });
        } else if (!history.versions.some((v) => v.version === change.to)) {
          unverified.push({ name, version: change.to, reason: 'version not in registry' });
        } else {
          const needed = repoVersionsNeeded(change, history);
          const full = await registry.withSourceRepos(name, history, needed);
          if (full.versions.some((v) => needed.includes(v.version) && !v.sourceRepo)) {
            unverified.push({ name, version: change.to, reason: 'provenance attestation could not be read' });
          }
          findings.push(...evaluate(change, full));
        }
      }
    }),
  );

  const kept = findings
    .map((f) => ({ ...f, severity: options.rules?.[f.rule] ?? f.severity }))
    .filter((f): f is Finding => f.severity !== 'off')
    .filter(
      (f) =>
        !options.allow?.some((a) => a.name === f.name && a.rule === f.rule && (!a.version || a.version === f.version)),
    )
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) ||
        compareVersions(a.version, b.version) ||
        RULE_IDS.indexOf(a.rule) - RULE_IDS.indexOf(b.rule),
    );
  unverified.sort((a, b) => a.name.localeCompare(b.name) || compareVersions(a.version, b.version));

  return {
    checked: changes.length,
    findings: kept,
    unverified,
    exitCode: kept.some((f) => f.severity === 'error') ? 1 : 0,
  };
}
