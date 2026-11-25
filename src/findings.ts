import { createHash } from 'node:crypto';
import { compareVersions } from './diff.ts';
import type { AllowEntry, CheckOptions } from './options.ts';
import { RULE_IDS } from './rules.ts';
import { packageId } from './text.ts';
import type { Finding, FindingGroup, Location, Unverified } from './types.ts';

/** Merges items with the same key, taking the union of their `usedBy` and `locations`. */
function mergeUsage<T extends { usedBy?: string[]; locations?: Location[] }>(
  items: T[],
  key: (item: T) => string,
  showUsage: boolean,
): T[] {
  const merged = new Map<string, T>();
  for (const item of items) {
    const existing = merged.get(key(item));
    if (existing) {
      existing.usedBy = [...new Set([...(existing.usedBy ?? []), ...(item.usedBy ?? [])])];
      const seen = new Set((existing.locations ?? []).map((l) => `${l.file}:${l.line}`));
      existing.locations = [
        ...(existing.locations ?? []),
        ...(item.locations ?? []).filter((l) => !seen.has(`${l.file}:${l.line}`)),
      ];
    } else {
      merged.set(key(item), { ...item });
    }
  }
  return [...merged.values()].map((item) => {
    const { usedBy, ...rest } = item;
    return (showUsage && usedBy?.length ? { ...rest, usedBy: [...usedBy].sort() } : rest) as T;
  });
}

/** Text of a finding without its leading `name@version `, e.g. `published by mallory; previously alice`. */
const detailOf = (f: Finding) => f.message.slice(`${packageId(f)} `.length);

/**
 * Tags findings that come from one publish event — same rule, version, publisher and detail — with a shared
 * `group` id, and returns one summary per group of two or more. No finding is removed.
 */
function groupFindings(findings: Finding[]): FindingGroup[] {
  const buckets = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = [f.rule, f.version, f.evidence?.publisher ?? '', detailOf(f), f.severity].join('\0');
    buckets.set(key, [...(buckets.get(key) ?? []), f]);
  }
  const groups: FindingGroup[] = [];
  for (const [key, members] of buckets) {
    if (members.length < 2) continue;
    const id = `${members[0].rule}:${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
    for (const f of members) f.group = id;
    groups.push({
      id,
      rule: members[0].rule,
      severity: members[0].severity,
      version: members[0].version,
      detail: detailOf(members[0]),
      packages: members.map((f) => f.name).sort(),
    });
  }
  return groups;
}

const byPackage = (a: { name: string; version: string }, b: { name: string; version: string }) =>
  a.name.localeCompare(b.name) || compareVersions(a.version, b.version);

const byOrder = (a: Finding, b: Finding) =>
  byPackage(a, b) || RULE_IDS.indexOf(a.rule) - RULE_IDS.indexOf(b.rule) || a.message.localeCompare(b.message);

const isAllowed = (a: AllowEntry, f: Finding) =>
  a.name === f.name && a.rule === f.rule && (!a.version || a.version === f.version);

export interface TriageOptions extends Pick<CheckOptions, 'rules' | 'allow'> {
  /** Keep `usedBy`; only worth showing when there is more than one workspace to tell apart. */
  showUsage: boolean;
}

/**
 * Turns raw rule output into the reported lists: exact duplicates merged (so no lockfile's detail is hidden),
 * severity overrides applied, allowlisted findings moved to `suppressed`, publish events grouped, all sorted.
 */
export function triage(findings: Finding[], unverified: Unverified[], { rules, allow, showUsage }: TriageOptions) {
  const rated = mergeUsage(findings, (f) => `${f.rule}\0${f.name}\0${f.version}\0${f.message}`, showUsage)
    .map((f) => ({ ...f, severity: rules?.[f.rule] ?? f.severity }))
    .filter((f): f is Finding => f.severity !== 'off');
  const kept: Finding[] = [];
  const suppressed: Finding[] = [];
  for (const f of rated) {
    const allowed = allow?.find((a) => isAllowed(a, f));
    if (allowed) suppressed.push({ ...f, suppressed: { reason: allowed.reason } });
    else kept.push(f);
  }
  kept.sort(byOrder);
  suppressed.sort(byOrder);
  return {
    findings: kept,
    suppressed,
    groups: groupFindings(kept),
    unverified: mergeUsage(unverified, (u) => `${u.name}\0${u.version}\0${u.reason}`, showUsage).sort(byPackage),
  };
}
