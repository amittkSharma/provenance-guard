import { collect, type Target } from './collect.ts';
import { triage } from './findings.ts';
import { type CheckOptions, DEFAULT_REGISTRY, validateOptions } from './options.ts';
import { createFetchJson, createRegistry } from './registry.ts';
import { evaluate, repoVersionsNeeded } from './rules.ts';
import type { Finding, FindingGroup, Unverified } from './types.ts';

export interface CheckResult {
  /** Number of package versions checked. */
  checked: number;
  findings: Finding[];
  unverified: Unverified[];
  /** Coverage gaps, e.g. lockfiles below `cwd` that were not checked. Withhold the ✅. */
  warnings: string[];
  /** Gaps in workspace attribution only (`usedBy` may be incomplete). Every package was still checked. */
  notes: string[];
  /** Lockfiles that were checked, relative to `cwd`. */
  lockfiles: string[];
  /** Git ref compared against; unset for a full scan. */
  base?: string;
  /** Allowlisted findings, each with `suppressed.reason`. They never affect the exit code. */
  suppressed: Finding[];
  /** Findings from one publish event (same rule, version, publisher and detail), listed once with all packages. */
  groups: FindingGroup[];
  /** 1 when any finding has severity `error`, else 0. */
  exitCode: 0 | 1;
}

/**
 * Checks a project's lockfile(s) against each package's own release history.
 * Throws on tool failures (no lockfile, bad options, registry unreachable) — never passes silently.
 */
export async function check(options: CheckOptions = {}): Promise<CheckResult> {
  validateOptions(options);
  // Built before any lockfile work so invalid HTTP settings fail fast.
  const fetchJson =
    options.fetchJson ??
    createFetchJson({ concurrency: options.concurrency, headers: options.headers, timeoutMs: options.timeoutMs });
  const { lockfiles, targets, workspaces, warnings, notes } = collect(options.cwd ?? process.cwd(), options);
  const registry = createRegistry(fetchJson, options.registry ?? process.env.npm_config_registry ?? DEFAULT_REGISTRY);
  const evaluateOptions = { now: new Date(), oldReleaseDays: options.oldReleaseDays };

  // Map.groupBy needs Node 21; engines allow 20.
  const byName = new Map<string, Target[]>();
  for (const target of targets) byName.set(target.change.name, [...(byName.get(target.change.name) ?? []), target]);
  const findings: Finding[] = [];
  const unverified: Unverified[] = [];
  await Promise.all(
    [...byName].map(async ([name, group]) => {
      const history = await registry.history(name);
      for (const { change, usedBy: users, locations } of group) {
        const usedBy = [...users];
        const unchecked = (reason: string) => unverified.push({ name, version: change.to, reason, usedBy, locations });
        if ('reason' in history) {
          unchecked(history.reason);
        } else if (!history.versions.some((v) => v.version === change.to)) {
          unchecked('version not in registry');
        } else {
          const needed = repoVersionsNeeded(change, history);
          const full = await registry.withSourceRepos(name, history, needed);
          if (full.versions.some((v) => needed.includes(v.version) && !v.sourceRepo)) {
            unchecked('provenance attestation could not be read');
          }
          findings.push(...evaluate(change, full, evaluateOptions).map((f) => ({ ...f, usedBy, locations })));
        }
      }
    }),
  );

  const result = triage(findings, unverified, {
    rules: options.rules,
    allow: options.allow,
    showUsage: workspaces.size > 1,
  });
  return {
    checked: new Set(targets.map((t) => `${t.change.name}@${t.change.to}`)).size,
    ...result,
    warnings,
    notes,
    lockfiles,
    base: options.base,
    exitCode: result.findings.some((f) => f.severity === 'error') ? 1 : 0,
  };
}
