import { actionableRows, cleanHeadline, type RenderOptions, type Report, severityCounts } from './report-common.ts';
import { html } from './report-html.ts';
import { junit } from './report-junit.ts';
import { sarif } from './report-sarif.ts';
import { packageId, plural, shortList } from './text.ts';

export type { RenderOptions, Report } from './report-common.ts';

export const OUTPUT_FORMATS = ['text', 'json', 'markdown', 'sarif', 'junit', 'html'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

const ICON = { error: '❌', warn: '⚠️', info: 'ℹ️' } as const;
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
/** Inline code for a table cell; a backtick in the value would end the code span, so it becomes a quote. */
const code = (s: string) => `\`${cell(s).replace(/`/g, "'")}\``;

function headline(report: Report): string {
  const { errors, warnings, infos } = severityCounts(report);
  const info = infos ? `, ${infos} info` : '';
  return errors + warnings
    ? `provenance-guard: ${plural(errors + warnings, 'finding')} in ${plural(report.checked, 'package')}${info}`
    : `${cleanHeadline(report)}${info}`;
}

function text(report: Report): string {
  const { unverified, warnings = [], notes = [], suppressed = [] } = report;
  const lines = [headline(report)];
  const users = (usedBy?: string[]) => (usedBy?.length ? ` — used by ${shortList(usedBy)}` : '');
  for (const row of actionableRows(report)) {
    if (row.kind === 'group') {
      const { group, members } = row;
      lines.push(
        `${ICON[group.severity]} ${group.severity.padEnd(5)} ${group.rule.padEnd(20)} ${members.length} packages @${group.version} ${group.detail} — ${shortList(group.packages)}`,
      );
    } else {
      const f = row.finding;
      lines.push(`${ICON[f.severity]} ${f.severity.padEnd(5)} ${f.rule.padEnd(20)} ${f.message}${users(f.usedBy)}`);
    }
  }
  for (const u of unverified) lines.push(`?  unverified ${packageId(u)} (${u.reason})${users(u.usedBy)}`);
  for (const f of report.findings.filter((x) => x.severity === 'info')) {
    lines.push(`ℹ️ info  ${f.rule.padEnd(20)} ${f.message}${f.context ? ` — ${f.context}` : ''}`);
  }
  for (const f of suppressed) {
    lines.push(`✓  allowed ${f.rule.padEnd(20)} ${packageId(f)} — ${f.suppressed?.reason ?? ''}`);
  }
  for (const w of warnings) lines.push(`⚠️ ${w}`);
  for (const n of notes) lines.push(`ℹ️ ${n}`);
  return `${lines.join('\n')}\n`;
}

function markdown(report: Report): string {
  const { checked, findings, unverified, warnings = [], notes = [], suppressed = [] } = report;
  const out = ['### provenance-guard', ''];
  const rows = actionableRows(report);
  if (rows.length) {
    const withUsage = findings.some((f) => f.usedBy?.length);
    out.push(
      `| Severity | Package | Rule | Detail |${withUsage ? ' Used by |' : ''}`,
      `|---|---|---|---|${withUsage ? '---|' : ''}`,
    );
    for (const row of rows) {
      if (row.kind === 'group') {
        const { group, members } = row;
        const usedBy = [...new Set(members.flatMap((m) => m.usedBy ?? []))];
        const usage = withUsage ? ` ${shortList(usedBy.map(code))} |` : '';
        out.push(
          `| ${ICON[group.severity]} ${group.severity} | ${members.length} packages: ${shortList(group.packages.map(code))} @${cell(group.version)} | \`${group.rule}\` | ${cell(group.detail)} |${usage}`,
        );
      } else {
        const f = row.finding;
        const usage = withUsage ? ` ${shortList((f.usedBy ?? []).map(code))} |` : '';
        out.push(
          `| ${ICON[f.severity]} ${f.severity} | ${code(packageId(f))} | \`${f.rule}\` | ${cell(f.message)} |${usage}`,
        );
      }
    }
    out.push('', `${plural(checked, 'package')} checked.`);
  } else {
    out.push(cleanHeadline(report));
  }
  for (const w of warnings) out.push('', `> ⚠️ ${cell(w)}`);
  for (const n of notes) out.push('', `> ℹ️ ${cell(n)}`);
  const details = (summary: string, items: string[]) => {
    if (items.length) out.push('', `<details><summary>${summary}</summary>`, '', ...items, '', '</details>');
  };
  const infos = findings.filter((f) => f.severity === 'info');
  details(
    plural(infos.length, 'info finding'),
    infos.map(
      (f) => `- ${code(packageId(f))} \`${f.rule}\`: ${cell(f.message)}${f.context ? ` — ${cell(f.context)}` : ''}`,
    ),
  );
  details(
    plural(suppressed.length, 'allowed finding'),
    suppressed.map((f) => `- ${code(packageId(f))} \`${f.rule}\`: ${cell(f.suppressed?.reason ?? '')}`),
  );
  details(
    `${plural(unverified.length, 'package')} could not be verified`,
    unverified.map((u) => {
      const users = u.usedBy?.length ? ` — used by ${shortList(u.usedBy.map(code))}` : '';
      return `- ${code(packageId(u))}: ${cell(u.reason)}${users}`;
    }),
  );
  return `${out.join('\n')}\n`;
}

/**
 * Formats a result: `text` for terminals, `json` for scripts, `markdown` for PR summaries, `sarif` for code-scanning
 * dashboards, `junit` for test-result views and `html` for a standalone report.
 */
export function render(format: OutputFormat, report: Report, options: RenderOptions = {}): string {
  switch (format) {
    case 'json': {
      const { checked, findings, unverified, warnings = [], notes = [], lockfiles = [], base } = report;
      const { groups = [], suppressed = [] } = report;
      const body = { checked, findings, groups, suppressed, unverified, warnings, notes, lockfiles, base };
      return `${JSON.stringify(body, null, 2)}\n`;
    }
    case 'markdown':
      return markdown(report);
    case 'sarif':
      return sarif(report, options);
    case 'junit':
      return junit(report, options);
    case 'html':
      return html(report, options);
    default:
      return text(report);
  }
}
