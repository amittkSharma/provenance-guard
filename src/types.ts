/** How strongly a published version is tied to a CI build. Ordered weakest → strongest. */
export type Trust = 'none' | 'provenance' | 'trusted-publisher';

export type RuleId = 'trust-downgrade' | 'source-repo-changed' | 'install-script-added' | 'publisher-changed';

export type Severity = 'error' | 'warn';

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

export interface Finding {
  rule: RuleId;
  severity: Severity;
  name: string;
  version: string;
  message: string;
}

/** A package that could not be checked, e.g. a private package missing from the public registry. */
export interface Unverified {
  name: string;
  version: string;
  reason: string;
}
