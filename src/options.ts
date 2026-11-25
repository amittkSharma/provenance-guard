import type { FetchJson } from './registry.ts';
import { RULE_IDS } from './rules.ts';
import type { RuleId, Severity } from './types.ts';

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
  /** Lockfile path relative to `cwd`. Default: the first supported lockfile that exists. */
  lockfile?: string;
  /** Check every lockfile under `cwd` (monorepos with per-package lockfiles). Can't be combined with `lockfile`. */
  recursive?: boolean;
  /** Paths (relative to `cwd`) whose lockfiles are ignored, e.g. `["test/fixtures"]`. */
  exclude?: string[];
  /** Git ref to compare against (e.g. `origin/main`). Set → only changed packages are checked; unset → all. */
  base?: string;
  /** Change a rule's severity (`info` reports without ever failing) or turn it off. */
  rules?: Partial<Record<RuleId, Severity | 'off'>>;
  /** Accepted findings. They are reported as `suppressed` with their reason, not dropped. */
  allow?: AllowEntry[];
  /** Minimum age in days before a release without provenance can be rated `info` (7 or more). Default 90. */
  oldReleaseDays?: number;
  /** Registry base URL. Default `$npm_config_registry`, else `https://registry.npmjs.org`. */
  registry?: string;
  /** Extra registry request headers, e.g. auth for a private mirror. Ignored when `fetchJson` is given. */
  headers?: Record<string, string>;
  /** Parallel registry requests. Default 8. Ignored when `fetchJson` is given. */
  concurrency?: number;
  /** Replace the HTTP layer entirely (tests, proxies, caching). */
  fetchJson?: FetchJson;
}

/** Options often come from a JSON config file, so their shape is checked at runtime. */
export function validateOptions(options: CheckOptions): void {
  for (const [rule, level] of Object.entries(options.rules ?? {})) {
    if (!RULE_IDS.includes(rule as RuleId)) throw new Error(`unknown rule "${rule}" (expected ${RULE_IDS.join(', ')})`);
    if (!['error', 'warn', 'info', 'off'].includes(level as string)) {
      throw new Error(`rule ${rule}: severity must be "error", "warn", "info" or "off", got "${level}"`);
    }
  }
  if (
    options.exclude !== undefined &&
    !(Array.isArray(options.exclude) && options.exclude.every((e) => typeof e === 'string'))
  ) {
    throw new Error('exclude must be an array of paths');
  }
  if (
    options.oldReleaseDays !== undefined &&
    !(typeof options.oldReleaseDays === 'number' && options.oldReleaseDays >= 7)
  ) {
    // A floor, so a config change can't quietly turn the age protection off.
    throw new Error('oldReleaseDays must be a number of days (7 or more)');
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
