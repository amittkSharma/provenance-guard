import type { History } from './registry.ts';
import type { Change, Finding, Trust, VersionFacts } from './types.ts';

const RANK: Record<Trust, number> = { none: 0, provenance: 1, 'trusted-publisher': 2 };

interface Context {
  target: VersionFacts;
  /** Releases published before the target, oldest first. */
  earlier: VersionFacts[];
  /** `change.from` if it is in the history, otherwise the release just before the target. */
  previous?: VersionFacts;
  /** Latest earlier release that has provenance. */
  previousAttested?: VersionFacts;
}

function context(change: Change, history: History): Context | undefined {
  const target = history.versions.find((v) => v.version === change.to);
  if (!target) return undefined;
  const earlier = history.versions.filter((v) => v.publishedAt < target.publishedAt);
  return {
    target,
    earlier,
    previous: history.versions.find((v) => v.version === change.from) ?? earlier.at(-1),
    previousAttested: earlier.findLast((v) => v.trust !== 'none'),
  };
}

/** Versions whose provenance source repo the rules need: the target and the previous attested release. */
export function repoVersionsNeeded(change: Change, history: History): string[] {
  const ctx = context(change, history);
  if (!ctx || ctx.target.trust === 'none' || !ctx.previousAttested) return [];
  return [ctx.target.version, ctx.previousAttested.version];
}

/** Compares the version a change introduces with the package's own earlier releases. */
export function evaluate(change: Change, history: History): Finding[] {
  const ctx = context(change, history);
  if (!ctx) return [];
  const { target, earlier, previous, previousAttested } = ctx;
  const id = `${change.name}@${change.to}`;
  const findings: Finding[] = [];
  const add = (rule: Finding['rule'], severity: Finding['severity'], message: string) =>
    findings.push({ rule, severity, name: change.name, version: change.to, message });

  const best = earlier.reduce<Trust>((top, v) => (RANK[v.trust] > RANK[top] ? v.trust : top), 'none');
  if (RANK[target.trust] < RANK[best]) {
    add('trust-downgrade', 'error', `${id} has ${target.trust}; earlier releases had ${best}`);
  }

  const before = previousAttested?.sourceRepo;
  if (target.sourceRepo && before && target.sourceRepo.toLowerCase() !== before.toLowerCase()) {
    add('source-repo-changed', 'error', `${id} built from ${target.sourceRepo}; previously ${before}`);
  }

  if (target.hasInstallScript && !previous?.hasInstallScript) {
    add('install-script-added', 'warn', `${id} adds an install script`);
  }

  if (target.trust === 'none' && previous?.publisher && target.publisher !== previous.publisher) {
    add('publisher-changed', 'warn', `${id} published by ${target.publisher}; previously ${previous.publisher}`);
  }

  return findings;
}
