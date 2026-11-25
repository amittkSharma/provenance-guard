import { createHash } from 'node:crypto';
import { type RenderOptions, type Report, RULE_DOCS, TOOL_NAME, TOOL_URL, TOOL_VERSION } from './report-common.ts';
import { packageId } from './text.ts';
import type { Finding, Location } from './types.ts';

/** Rules plus the `unverified` pseudo-rule; `ruleIndex` points into this list. */
const RULES = Object.keys(RULE_DOCS) as (keyof typeof RULE_DOCS)[];
const LEVEL = { error: 'error', warn: 'warning', info: 'note' } as const;

/** Stable across runs, so code-scanning dashboards track one alert instead of opening a new one per build. */
const fingerprint = (...parts: string[]) => createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32);

/** SARIF `correlationGuid` must be a GUID; derive a stable one from the group id. */
const guid = (id: string) => {
  const h = createHash('sha256').update(id).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

/** SARIF 2.1.0 log for GitHub code scanning, Azure DevOps (SARIF SAST Scans Tab) and other SARIF viewers. */
export function sarif(report: Report, { generatedAt = new Date().toISOString() }: RenderOptions = {}): string {
  const fallback: Location[] = report.lockfiles?.length ? [{ file: report.lockfiles[0], line: 1 }] : [];
  const locations = (list: Location[] | undefined) =>
    (list?.length ? list : fallback).map(({ file, line }) => ({
      physicalLocation: { artifactLocation: { uri: file }, region: { startLine: line } },
    }));
  const properties = (name: string, version: string, usedBy?: string[]) => ({
    package: name,
    version,
    ...(usedBy?.length ? { usedBy } : {}),
  });

  const findingResult = (f: Finding) => ({
    ruleId: f.rule,
    ruleIndex: RULES.indexOf(f.rule),
    level: LEVEL[f.severity],
    message: { text: f.context ? `${f.message}. ${f.context}` : f.message },
    locations: locations(f.locations),
    partialFingerprints: { 'provenanceGuard/v1': fingerprint(f.rule, f.name, f.version, f.message) },
    // Members of one publish event stay separate results (each package keeps its alert) but share a GUID.
    ...(f.group ? { correlationGuid: guid(f.group) } : {}),
    ...(f.suppressed
      ? { suppressions: [{ kind: 'external', status: 'accepted', justification: f.suppressed.reason }] }
      : {}),
    properties: {
      ...properties(f.name, f.version, f.usedBy),
      ...(f.context ? { context: f.context } : {}),
      ...(f.evidence ? { evidence: f.evidence } : {}),
    },
  });

  const results = [
    ...report.findings.map(findingResult),
    ...(report.suppressed ?? []).map(findingResult),
    ...report.unverified.map((u) => ({
      ruleId: 'unverified',
      ruleIndex: RULES.indexOf('unverified'),
      level: 'note',
      message: { text: `${packageId(u)} could not be verified: ${u.reason}` },
      locations: locations(u.locations),
      partialFingerprints: { 'provenanceGuard/v1': fingerprint('unverified', u.name, u.version, u.reason) },
      properties: properties(u.name, u.version, u.usedBy),
    })),
  ];

  const log = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: TOOL_NAME,
            version: TOOL_VERSION,
            informationUri: TOOL_URL,
            rules: RULES.map((id) => {
              const doc = RULE_DOCS[id];
              return {
                id,
                name: doc.title.replace(/\s+/g, ''),
                shortDescription: { text: doc.summary },
                fullDescription: { text: doc.description },
                help: {
                  text: doc.action,
                  markdown: `**${doc.title}.** ${doc.description}\n\n**What to do:** ${doc.action}`,
                },
                helpUri: `${TOOL_URL}#readme`,
                defaultConfiguration: { level: doc.level },
                properties: {
                  tags: ['security', 'supply-chain'],
                  ...(doc.securitySeverity ? { 'security-severity': doc.securitySeverity } : {}),
                },
              };
            }),
          },
        },
        invocations: [
          {
            executionSuccessful: true,
            endTimeUtc: generatedAt,
            toolExecutionNotifications: [
              ...(report.warnings ?? []).map((text) => ({ level: 'warning', message: { text } })),
              ...(report.notes ?? []).map((text) => ({ level: 'note', message: { text } })),
            ],
          },
        ],
        results,
      },
    ],
  };
  return `${JSON.stringify(log, null, 2)}\n`;
}
