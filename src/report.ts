import type { Finding, Unverified } from './types.ts';

export type OutputFormat = 'text' | 'json' | 'markdown';

export interface Report {
  checked: number;
  findings: Finding[];
  unverified: Unverified[];
  /** Coverage gaps such as lockfiles that were not checked. */
  warnings?: string[];
  /** Attribution gaps (`usedBy` may be incomplete); informational only. */
  notes?: string[];
}

const ICON = { error: '❌', warn: '⚠️' } as const;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** Headline when there are no findings: ✅ only if every package and every lockfile was checked. */
const clean = (checked: number, unverified: number, warnings: number) => {
  if (unverified)
    return `⚠️ no trust regressions found, but ${unverified} of ${plural(checked, 'package')} could not be verified`;
  if (warnings) return `⚠️ no trust regressions in ${plural(checked, 'package')}, but not every lockfile was checked`;
  return `✅ ${plural(checked, 'package')} checked, no trust regressions`;
};
const shortList = (items: string[]) =>
  items.length > 5 ? `${items.slice(0, 5).join(', ')} +${items.length - 5} more` : items.join(', ');
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
/** Inline code for a table cell; a backtick in the value would end the code span, so it becomes a quote. */
const code = (s: string) => `\`${cell(s).replace(/`/g, "'")}\``;

function text({ checked, findings, unverified, warnings = [], notes = [] }: Report): string {
  const lines = findings.length
    ? [`provenance-guard: ${plural(findings.length, 'finding')} in ${plural(checked, 'package')}`]
    : [clean(checked, unverified.length, warnings.length)];
  const users = (usedBy?: string[]) => (usedBy?.length ? ` — used by ${shortList(usedBy)}` : '');
  for (const f of findings) {
    lines.push(`${ICON[f.severity]} ${f.severity.padEnd(5)} ${f.rule.padEnd(20)} ${f.message}${users(f.usedBy)}`);
  }
  for (const u of unverified) lines.push(`?  unverified ${u.name}@${u.version} (${u.reason})${users(u.usedBy)}`);
  for (const w of warnings) lines.push(`⚠️ ${w}`);
  for (const n of notes) lines.push(`ℹ️ ${n}`);
  return `${lines.join('\n')}\n`;
}

function markdown({ checked, findings, unverified, warnings = [], notes = [] }: Report): string {
  const out = ['### provenance-guard', ''];
  if (findings.length) {
    const withUsage = findings.some((f) => f.usedBy?.length);
    out.push(
      `| Severity | Package | Rule | Detail |${withUsage ? ' Used by |' : ''}`,
      `|---|---|---|---|${withUsage ? '---|' : ''}`,
    );
    for (const f of findings) {
      const usage = withUsage ? ` ${shortList((f.usedBy ?? []).map(code))} |` : '';
      out.push(
        `| ${ICON[f.severity]} ${f.severity} | \`${f.name}@${f.version}\` | \`${f.rule}\` | ${cell(f.message)} |${usage}`,
      );
    }
    out.push('', `${plural(checked, 'package')} checked.`);
  } else {
    out.push(clean(checked, unverified.length, warnings.length));
  }
  for (const w of warnings) out.push('', `> ⚠️ ${cell(w)}`);
  for (const n of notes) out.push('', `> ℹ️ ${cell(n)}`);
  if (unverified.length) {
    const noun = unverified.length === 1 ? 'package' : 'packages';
    out.push('', `<details><summary>${unverified.length} ${noun} could not be verified</summary>`, '');
    for (const u of unverified) {
      const users = u.usedBy?.length ? ` — used by ${shortList(u.usedBy.map(code))}` : '';
      out.push(`- ${code(`${u.name}@${u.version}`)}: ${cell(u.reason)}${users}`);
    }
    out.push('', '</details>');
  }
  return `${out.join('\n')}\n`;
}

/** Formats a result for humans (`text`), machines (`json`) or PR summaries (`markdown`). */
export function render(format: OutputFormat, report: Report): string {
  if (format === 'json') {
    const { checked, findings, unverified, warnings = [], notes = [] } = report;
    return `${JSON.stringify({ checked, findings, unverified, warnings, notes }, null, 2)}\n`;
  }
  return format === 'markdown' ? markdown(report) : text(report);
}
