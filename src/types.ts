/** How strongly a published version is tied to a CI build. Ordered weakest → strongest. */
export type Trust = 'none' | 'provenance' | 'trusted-publisher';

export type RuleId = 'trust-downgrade' | 'source-repo-changed' | 'install-script-added' | 'publisher-changed';

/** `error` fails CI, `warn` needs review, `info` is true but low-risk context (never fails CI). */
export type Severity = 'error' | 'warn' | 'info';

/** Package name → every version of it in a lockfile. */
export type Packages = Map<string, Set<string>>;

/** A version that a lockfile change introduced. `from` is unset for packages that are new. */
export interface Change {
  name: string;
  from?: string;
  to: string;
}

/** What the npm registry says about one published version. */
export interface VersionFacts {
  version: string;
  publishedAt: string;
  trust: Trust;
  /** Repository the SLSA provenance says the version was built from, lowercased. */
  sourceRepo?: string;
  /** npm account that published the version. */
  publisher?: string;
  hasInstallScript: boolean;
}

/** Where a package sits in a lockfile, relative to `cwd`. */
export interface Location {
  file: string;
  line: number;
}

/** The facts a finding is based on, so reviewers can judge it without opening npm. */
export interface Evidence {
  publishedAt: string;
  /** Days between publishing and the check. */
  ageDays: number;
  trust: Trust;
  publisher?: string;
  /** Whether `publisher` is in the package's current maintainer list. */
  publisherIsMaintainer?: boolean;
  previousVersion?: string;
  previousPublisher?: string;
  /** Release line the version belongs to, e.g. `5.x` (or `0.4.x` before 1.0). */
  line: string;
  /** Strongest trust of any earlier release, and of earlier releases in the same line. */
  bestEarlierTrust: Trust;
  bestLineTrust: Trust;
  /** Latest earlier release with provenance or better. */
  lastAttestedVersion?: string;
  sourceRepo?: string;
  previousSourceRepo?: string;
}

export interface Finding {
  rule: RuleId;
  severity: Severity;
  name: string;
  version: string;
  message: string;
  /** Workspaces (directories relative to `cwd`) that use the package. Set only when there is more than one. */
  usedBy?: string[];
  /** Lockfile entries for this version. */
  locations?: Location[];
  evidence?: Evidence;
  /** Why a finding was rated `info` instead of `error`. */
  context?: string;
  /** Findings with the same `group` come from one publish event (same rule, version, publisher and detail). */
  group?: string;
  /** Set on allowlisted findings, which are reported as suppressed instead of being dropped. */
  suppressed?: { reason: string };
}

/** Findings from one publish event (same rule, version, publisher and detail), listed once with all packages. */
export interface FindingGroup {
  id: string;
  rule: RuleId;
  severity: Severity;
  version: string;
  /** The shared detail without the package name, e.g. `published by mallory; previously alice`. */
  detail: string;
  packages: string[];
}

/** A package that could not be checked, e.g. a private package missing from the public registry. */
export interface Unverified {
  name: string;
  version: string;
  reason: string;
  /** Workspaces that use the package, as in `Finding.usedBy`. */
  usedBy?: string[];
  /** Lockfile entries for this version. */
  locations?: Location[];
}
