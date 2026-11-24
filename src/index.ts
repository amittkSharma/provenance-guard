import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { compareVersions, diffPackages, readAtRef } from './diff.ts';
import { discoverLockfiles } from './discover.ts';
import { LOCKFILES, parseLockfile } from './lockfile.ts';
import { createFetchJson, createRegistry, type FetchJson } from './registry.ts';
import { evaluate, repoVersionsNeeded } from './rules.ts';
import type { Change, Finding, RuleId, Severity, Unverified } from './types.ts';
import { nodeProjectFiles, workspaceUsage } from './workspaces.ts';

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

export { discoverLockfiles } from './discover.ts';
export { LOCKFILES } from './lockfile.ts';
export type { ProjectFiles, WorkspaceUsage } from './workspaces.ts';
export { nodeProjectFiles, workspaceUsage } from './workspaces.ts';

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
  /** Check every lockfile under `cwd` (monorepos with per-package lockfiles). Can't be combined with `lockfile`. */
  recursive?: boolean;
  /** Paths (relative to `cwd`) whose lockfiles are ignored, e.g. `["test/fixtures"]`. */
  exclude?: string[];
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
  /** Coverage gaps, e.g. lockfiles below `cwd` that were not checked. Withhold the ✅. */
  warnings: string[];
  /** Gaps in workspace attribution only (`usedBy` may be incomplete). Every package was still checked. */
  notes: string[];
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
  if (
    options.exclude !== undefined &&
    !(Array.isArray(options.exclude) && options.exclude.every((e) => typeof e === 'string'))
  ) {
    throw new Error('exclude must be an array of paths');
  }
  if (options.recursive !== undefined && typeof options.recursive !== 'boolean') {
    throw new Error('recursive must be true or false');
  }
  if (options.recursive && options.lockfile) throw new Error('--recursive and --lockfile cannot be combined');
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

/** One version to check, and the workspaces (relative to `cwd`) that use it. */
interface Target {
  change: Change;
  usedBy: Set<string>;
}

/** Changes in one lockfile, each tagged with the workspaces that use it. */
function collect(
  cwd: string,
  lockfile: string,
  base: string | undefined,
  importers: Set<string>,
  notes: string[],
): Target[] {
  const content = readFileSync(join(cwd, lockfile), 'utf8');
  const head = parseLockfile(lockfile, content);
  const before = base === undefined ? undefined : readAtRef(base, lockfile, cwd);
  const changes = diffPackages(before === undefined ? new Map() : parseLockfile(lockfile, before), head);
  const dir = posix.normalize(dirname(lockfile).replace(/\\/g, '/'));
  const usage = workspaceUsage(lockfile, content, nodeProjectFiles(join(cwd, dir)));
  const label = (importer: string) => posix.join(dir, importer);
  // A lockfile without workspace information belongs to its own folder. In a lockfile that has workspaces, a
  // package none of them reaches gets no attribution rather than a guess.
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (usage.unresolvedLinks.length) {
    const n = usage.unresolvedLinks.length;
    notes.push(
      `${lockfile}: ${count(n, 'workspace dependency', 'workspace dependencies')} could not be resolved, so 'used by' doesn't follow ${n === 1 ? 'it' : 'them'}: ${listPaths(usage.unresolvedLinks)}`,
    );
  }
  if (usage.unresolvedRequired.length) {
    const n = usage.unresolvedRequired.length;
    notes.push(
      `${lockfile}: ${count(n, 'required dependency is', 'required dependencies are')} missing from the lockfile, so 'used by' may be incomplete (is the lockfile out of sync?): ${listPaths(usage.unresolvedRequired)}`,
    );
  }
  const hasWorkspaces = usage.importers.length > 0;
  for (const importer of hasWorkspaces ? usage.importers : ['.']) importers.add(label(importer));
  return changes.map((change) => ({
    change,
    usedBy: new Set((hasWorkspaces ? (usage.usedBy.get(`${change.name}@${change.to}`) ?? []) : ['.']).map(label)),
  }));
}

const listPaths = (paths: string[]) =>
  paths.length > 5 ? `${paths.slice(0, 5).join(', ')} +${paths.length - 5} more` : paths.join(', ');

/** Merges items with the same key, taking the union of their `usedBy`. */
function mergeUsage<T extends { usedBy?: string[] }>(items: T[], key: (item: T) => string, show: boolean): T[] {
  const merged = new Map<string, T>();
  for (const item of items) {
    const existing = merged.get(key(item));
    if (existing) existing.usedBy = [...new Set([...(existing.usedBy ?? []), ...(item.usedBy ?? [])])];
    else merged.set(key(item), { ...item });
  }
  return [...merged.values()].map((item) => {
    const { usedBy, ...rest } = item;
    return (show && usedBy?.length ? { ...rest, usedBy: [...usedBy].sort() } : rest) as T;
  });
}

/**
 * Checks a project's lockfile(s) against each package's own release history.
 * Throws on tool failures (no lockfile, bad options, registry unreachable) — never passes silently.
 */
export async function check(options: CheckOptions = {}): Promise<CheckResult> {
  validate(options);
  const cwd = options.cwd ?? process.cwd();
  const { lockfiles: discovered, unreadable } = discoverLockfiles(cwd, options.exclude);
  const lockfiles = options.recursive ? discovered : [findLockfile(cwd, options.lockfile)];
  if (lockfiles.length === 0) throw new Error(`no lockfile found in ${cwd} (looked for ${LOCKFILES.join(', ')})`);

  const warnings: string[] = [];
  if (unreadable.length) {
    const n = unreadable.length;
    warnings.push(
      `could not read ${n} folder${n === 1 ? '' : 's'}: ${listPaths(unreadable)} (lockfiles inside were not checked)`,
    );
  }
  if (!options.recursive) {
    const checkedPath = posix.normalize(lockfiles[0].replace(/\\/g, '/'));
    const others = discovered.filter((path) => posix.normalize(path) !== checkedPath);
    if (others.length) {
      const n = others.length;
      warnings.push(
        `${n} more lockfile${n === 1 ? '' : 's'} not checked: ${listPaths(others)} (use --recursive or exclude ${n === 1 ? 'it' : 'them'})`,
      );
    }
  }

  // The same name/from/to in several lockfiles is checked once, used by all their workspaces.
  const importers = new Set<string>();
  const notes: string[] = [];
  const targets = new Map<string, Target>();
  for (const lockfile of lockfiles) {
    for (const target of collect(cwd, lockfile, options.base, importers, notes)) {
      const key = `${target.change.name}\0${target.change.from ?? ''}\0${target.change.to}`;
      const existing = targets.get(key);
      if (existing) for (const label of target.usedBy) existing.usedBy.add(label);
      else targets.set(key, target);
    }
  }

  const fetchJson =
    options.fetchJson ?? createFetchJson({ concurrency: options.concurrency, headers: options.headers });
  const registry = createRegistry(fetchJson, options.registry ?? process.env.npm_config_registry ?? DEFAULT_REGISTRY);

  const byName = new Map<string, Target[]>();
  for (const target of targets.values()) {
    byName.set(target.change.name, [...(byName.get(target.change.name) ?? []), target]);
  }
  const findings: Finding[] = [];
  const unverified: Unverified[] = [];
  await Promise.all(
    [...byName].map(async ([name, group]) => {
      const history = await registry.history(name);
      for (const { change, usedBy: users } of group) {
        const usedBy = [...users];
        if ('reason' in history) {
          unverified.push({ name, version: change.to, reason: history.reason, usedBy });
        } else if (!history.versions.some((v) => v.version === change.to)) {
          unverified.push({ name, version: change.to, reason: 'version not in registry', usedBy });
        } else {
          const needed = repoVersionsNeeded(change, history);
          const full = await registry.withSourceRepos(name, history, needed);
          if (full.versions.some((v) => needed.includes(v.version) && !v.sourceRepo)) {
            unverified.push({ name, version: change.to, reason: 'provenance attestation could not be read', usedBy });
          }
          findings.push(...evaluate(change, full).map((f) => ({ ...f, usedBy })));
        }
      }
    }),
  );

  // Merge only exact duplicates (same rule, package, version and message), so no lockfile's detail is hidden.
  // Show "used by" only when there is more than one workspace to tell apart.
  const showUsage = importers.size > 1;
  const kept = mergeUsage(findings, (f) => `${f.rule}\0${f.name}\0${f.version}\0${f.message}`, showUsage)
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
        RULE_IDS.indexOf(a.rule) - RULE_IDS.indexOf(b.rule) ||
        a.message.localeCompare(b.message),
    );
  const unchecked = mergeUsage(unverified, (u) => `${u.name}\0${u.version}\0${u.reason}`, showUsage).sort(
    (a, b) => a.name.localeCompare(b.name) || compareVersions(a.version, b.version),
  );

  return {
    checked: new Set([...targets.values()].map((t) => `${t.change.name}@${t.change.to}`)).size,
    findings: kept,
    unverified: unchecked,
    warnings,
    notes,
    exitCode: kept.some((f) => f.severity === 'error') ? 1 : 0,
  };
}
