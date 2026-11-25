import { readFileSync } from 'node:fs';
import { plural } from './text.ts';
import type { Finding, FindingGroup, RuleId, Unverified } from './types.ts';

/** What every report format is rendered from (a `CheckResult` fits). */
export interface Report {
  checked: number;
  findings: Finding[];
  unverified: Unverified[];
  /** Coverage gaps such as lockfiles that were not checked. */
  warnings?: string[];
  /** Attribution gaps (`usedBy` may be incomplete); informational only. */
  notes?: string[];
  /** Lockfiles that were checked. */
  lockfiles?: string[];
  /** Git ref compared against; unset for a full scan. */
  base?: string;
  /** Allowlisted findings with their reasons. */
  suppressed?: Finding[];
  /** Findings that share one publish event; members carry the same `group` id. */
  groups?: FindingGroup[];
}

export interface RenderOptions {
  /** Timestamp shown in SARIF, JUnit and HTML reports. Default: now. */
  generatedAt?: string;
}

export const TOOL_NAME = 'provenance-guard';
export const TOOL_URL = 'https://github.com/amittkSharma/provenance-guard';
export const TOOL_VERSION: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

/** Headline when there are no findings: ✅ only if every package and every lockfile was checked. */
export function cleanHeadline({ checked, unverified, warnings = [] }: Report): string {
  if (unverified.length) {
    return `⚠️ no trust regressions found, but ${unverified.length} of ${plural(checked, 'package')} could not be verified`;
  }
  if (warnings.length) {
    return `⚠️ no trust regressions in ${plural(checked, 'package')}, but not every lockfile was checked`;
  }
  return `✅ ${plural(checked, 'package')} checked, no trust regressions`;
}

interface RuleDoc {
  title: string;
  summary: string;
  description: string;
  /** What to do when the rule fires. */
  action: string;
  level: 'error' | 'warning' | 'note';
  /** GitHub code scanning severity score (0–10). */
  securitySeverity?: string;
}

/** Rule documentation shared by the SARIF and HTML reports. */
export const RULE_DOCS: Record<RuleId | 'unverified', RuleDoc> = {
  'trust-downgrade': {
    title: 'Trust downgrade',
    summary: 'Published with weaker trust than earlier releases',
    description:
      'This version was published with weaker trust than earlier releases of the same package (trusted publisher → provenance → none). Attackers with a stolen npm token publish by hand, which drops the provenance a CI build would add.',
    action:
      'Check the package’s repository and release notes for an announced change of CI. If there is none, pin the previous version and contact the maintainers. If it is explained, add an allowlist entry with the reason.',
    level: 'error',
    securitySeverity: '8.0',
  },
  'source-repo-changed': {
    title: 'Source repository changed',
    summary: 'Built from a different repository than before',
    description:
      'The provenance attestation says this version was built from a different source repository than the previous attested release. A fork or a hijacked CI can produce valid provenance from the wrong repository.',
    action:
      'Confirm the project officially moved repositories. If not, pin the previous version and report it to the maintainers and to npm.',
    level: 'error',
    securitySeverity: '9.0',
  },
  'install-script-added': {
    title: 'Install script added',
    summary: 'Runs code on install, unlike the previous release',
    description:
      'This version adds a preinstall, install or postinstall script (or a native build) that the previous release did not have. Worms such as Shai-Hulud spread through newly added install scripts.',
    action:
      'Read the script in the published package. Install with --ignore-scripts until it is reviewed, and allowlist it once you trust it.',
    level: 'warning',
    securitySeverity: '6.0',
  },
  'publisher-changed': {
    title: 'Publisher changed',
    summary: 'Published by hand by a different npm account',
    description:
      'This version was published without a trusted publisher by a different npm account than the previous release. It can be a new maintainer, or a hijacked account.',
    action:
      'Check that the account is a listed maintainer and that the change was announced. Turn the rule off if your dependencies change publishers often.',
    level: 'warning',
    securitySeverity: '5.0',
  },
  unverified: {
    title: 'Not verified',
    summary: 'The package could not be checked',
    description:
      'The registry did not return this package or version (for example a private package missing from the public registry), or its provenance attestation could not be read.',
    action: 'Point `registry` and `headers` at a registry that serves this package, or verify it manually.',
    level: 'note',
  },
};

/** A row in a human-readable report: one finding, or one group of findings from the same publish event. */
type Row = { kind: 'finding'; finding: Finding } | { kind: 'group'; group: FindingGroup; members: Finding[] };

/** Errors and warnings as rows (groups collapsed to one row each), in finding order. Info findings are excluded. */
export function actionableRows(report: Report): Row[] {
  const groups = new Map((report.groups ?? []).map((g) => [g.id, g]));
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const finding of report.findings) {
    if (finding.severity === 'info') continue;
    const group = finding.group ? groups.get(finding.group) : undefined;
    if (!group) {
      rows.push({ kind: 'finding', finding });
    } else if (!seen.has(group.id)) {
      seen.add(group.id);
      rows.push({ kind: 'group', group, members: report.findings.filter((f) => f.group === group.id) });
    }
  }
  return rows;
}

/** Counts by severity; groups count every member. */
export function severityCounts(report: Report): { errors: number; warnings: number; infos: number } {
  const count = (s: string) => report.findings.filter((f) => f.severity === s).length;
  return { errors: count('error'), warnings: count('warn'), infos: count('info') };
}
