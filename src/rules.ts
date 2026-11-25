import type { History } from './registry.ts';
import type { Change, Evidence, Finding, RuleId, Trust, VersionFacts } from './types.ts';

/** Every rule, in report order. */
export const RULE_IDS: readonly RuleId[] = [
  'trust-downgrade',
  'source-repo-changed',
  'install-script-added',
  'publisher-changed',
];

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

interface EvaluateOptions {
  /** Reference time for release ages. Default: now. */
  now?: Date;
  /**
   * Minimum age (days) before a release published without provenance can be rated `info`; other conditions apply,
   * see `evaluate`. Default 90.
   */
  oldReleaseDays?: number;
}

/** Release line of a version: `5.x`, or `0.4.x` before 1.0 (where each minor can break). */
function releaseLine(version: string): string {
  const [major, minor] = version.split('.');
  return major === '0' ? `0.${minor}.x` : `${major}.x`;
}

/** Orders release lines: 1.x < 2.x, and 0.3.x < 0.4.x < 1.x. */
const lineOrder = (version: string): number => {
  const [major, minor] = version.split('.').map(Number);
  return major > 0 ? major * 1_000_000 : minor;
};

const strongest = (versions: VersionFacts[]) =>
  versions.reduce<Trust>((top, v) => (RANK[v.trust] > RANK[top] ? v.trust : top), 'none');

/** Compares the version a change introduces with the package's own earlier releases. */
export function evaluate(change: Change, history: History, options: EvaluateOptions = {}): Finding[] {
  const ctx = context(change, history);
  if (!ctx) return [];
  const { now = new Date(), oldReleaseDays = 90 } = options;
  const { target, earlier, previous, previousAttested } = ctx;
  const id = `${change.name}@${change.to}`;
  const line = releaseLine(target.version);
  const lineEarlier = earlier.filter((v) => releaseLine(v.version) === line);
  const best = strongest(earlier);
  const bestLine = strongest(lineEarlier);
  // Stronger trust that only ever appeared in newer lines doesn't make an older line's maintenance release weaker.
  const bestUpToLine = strongest(earlier.filter((v) => lineOrder(v.version) <= lineOrder(target.version)));
  // Clamped: a CI clock behind the registry would otherwise give a negative age.
  const ageDays = Math.max(0, Math.floor((now.getTime() - Date.parse(target.publishedAt)) / 86_400_000));
  const maintainers = history.maintainers ?? [];

  const evidence: Evidence = {
    publishedAt: target.publishedAt,
    ageDays,
    trust: target.trust,
    publisher: target.publisher,
    publisherIsMaintainer: target.publisher !== undefined && maintainers.includes(target.publisher),
    previousVersion: previous?.version,
    previousPublisher: previous?.publisher,
    line,
    bestEarlierTrust: best,
    bestLineTrust: bestLine,
    lastAttestedVersion: previousAttested?.version,
    ...(target.sourceRepo ? { sourceRepo: target.sourceRepo, previousSourceRepo: previousAttested?.sourceRepo } : {}),
  };
  for (const key of Object.keys(evidence) as (keyof Evidence)[]) if (evidence[key] === undefined) delete evidence[key];

  const findings: Finding[] = [];
  const add = (rule: Finding['rule'], severity: Finding['severity'], message: string, why?: string) =>
    findings.push({
      rule,
      severity,
      name: change.name,
      version: change.to,
      message,
      evidence,
      ...(why ? { context: why } : {}),
    });

  if (RANK[target.trust] < RANK[best]) {
    const message = `${id} has ${target.trust}; earlier releases had ${best}`;
    // `info` needs positive evidence the release is legitimate, never just the absence of an attack:
    // continuity — a listed maintainer who already published this line — plus either a verified CI build (provenance
    // whose source repo was read) or an old release after which the line went back to attested publishing.
    const isMaintainer = evidence.publisherIsMaintainer === true;
    const old = ageDays >= oldReleaseDays;
    const laterAttested = history.versions.find(
      (v) => releaseLine(v.version) === line && v.trust !== 'none' && v.publishedAt > target.publishedAt,
    );
    const verifiedBuild = target.trust !== 'none' && target.sourceRepo !== undefined;
    const backOnTrack = old && laterAttested !== undefined;

    if (RANK[target.trust] >= RANK[bestUpToLine]) {
      // A maintenance release of an older line, compared with newer lines that adopted stronger publishing.
      const continuity = isMaintainer && lineEarlier.some((v) => v.publisher === target.publisher);
      if (continuity && (verifiedBuild || backOnTrack)) {
        add(
          'trust-downgrade',
          'info',
          message,
          `Newer release lines use ${best}; the ${line} line never had better than ${bestLine}, so this release is not weaker than its own line.`,
        );
      } else {
        add('trust-downgrade', 'error', message);
      }
    } else {
      // A real drop inside the line. A stolen maintainer token publishes as that maintainer, so continuity alone
      // proves nothing: also require age and that the line later went back to attested publishing.
      const continuity =
        isMaintainer && lineEarlier.some((v) => v.trust !== 'none' && v.publisher === target.publisher);
      if (continuity && backOnTrack && laterAttested) {
        add(
          'trust-downgrade',
          'info',
          message,
          `Published ${ageDays} days ago by ${target.publisher}, a listed maintainer who also published earlier ${line} releases with ${bestLine}; later ${line} releases (${laterAttested.version}) went back to ${laterAttested.trust}.`,
        );
      } else {
        add('trust-downgrade', 'error', message);
      }
    }
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
