import { type RenderOptions, type Report, severityCounts, TOOL_NAME } from './report-common.ts';
import { packageId, plural, escapeMarkup as xml } from './text.ts';

/**
 * JUnit XML for test-result views (Azure DevOps "Tests" tab, Jenkins, GitLab). Errors fail; warnings, allowed findings and
 * unverified packages are skipped with the reason; info findings pass with their context; one passing test records
 * how many packages were checked.
 */
export function junit(report: Report, { generatedAt = new Date().toISOString() }: RenderOptions = {}): string {
  const cases: string[] = [];
  for (const f of report.findings) {
    const details = [
      f.message,
      f.usedBy?.length ? `Used by: ${f.usedBy.join(', ')}` : '',
      f.locations?.length ? `Location: ${f.locations.map((l) => `${l.file}:${l.line}`).join(', ')}` : '',
    ].filter(Boolean);
    const body =
      f.severity === 'error'
        ? `<failure message="${xml(f.message)}" type="${f.rule}">${xml(details.join('\n'))}</failure>`
        : f.severity === 'warn'
          ? `<skipped message="${xml(`warning: ${f.message}`)}" />`
          : // info: a passing test that still records the finding and why it is low-risk
            `<system-out>${xml(`info: ${f.message}${f.context ? `. ${f.context}` : ''}`)}</system-out>`;
    cases.push(
      `    <testcase classname="${TOOL_NAME}.${f.rule}" name="${xml(packageId(f))}">\n      ${body}\n    </testcase>`,
    );
  }
  for (const f of report.suppressed ?? []) {
    cases.push(
      `    <testcase classname="${TOOL_NAME}.${f.rule}" name="${xml(packageId(f))}">\n      <skipped message="${xml(`allowed: ${f.suppressed?.reason ?? ''}`)}" />\n    </testcase>`,
    );
  }
  for (const u of report.unverified) {
    cases.push(
      `    <testcase classname="${TOOL_NAME}.unverified" name="${xml(packageId(u))}">\n      <skipped message="${xml(`unverified: ${u.reason}`)}" />\n    </testcase>`,
    );
  }
  cases.push(`    <testcase classname="${TOOL_NAME}" name="${plural(report.checked, 'package')} checked" />`);

  const { errors: failures, warnings } = severityCounts(report);
  const skipped = warnings + (report.suppressed?.length ?? 0) + report.unverified.length;
  const counts = `tests="${cases.length}" failures="${failures}" skipped="${skipped}" errors="0"`;
  const messages = [
    ...(report.warnings ?? []).map((w) => `warning: ${w}`),
    ...(report.notes ?? []).map((n) => `note: ${n}`),
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${TOOL_NAME}" ${counts} timestamp="${xml(generatedAt)}">`,
    `  <testsuite name="${TOOL_NAME}" ${counts} timestamp="${xml(generatedAt)}">`,
    ...cases,
    ...(messages.length ? [`    <system-out>${xml(messages.join('\n'))}</system-out>`] : []),
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n');
}
