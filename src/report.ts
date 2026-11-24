import type { Finding, Unverified } from './types.ts';

export type OutputFormat = 'text' | 'json' | 'markdown';

export interface Report {
  checked: number;
  findings: Finding[];
  unverified: Unverified[];
}

const ICON = { error: '❌', warn: '⚠️' } as const;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** Headline when there are no findings: ✅ only if every package was actually checked. */
const clean = (checked: number, unverified: number) =>
  unverified
    ? `⚠️ no trust regressions found, but ${unverified} of ${plural(checked, 'package')} could not be verified`
    : `✅ ${plural(checked, 'package')} checked, no trust regressions`;
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function text({ checked, findings, unverified }: Report): string {
  const lines = findings.length
    ? [`provenance-guard: ${plural(findings.length, 'finding')} in ${plural(checked, 'package')}`]
    : [clean(checked, unverified.length)];
  for (const f of findings) lines.push(`${ICON[f.severity]} ${f.severity.padEnd(5)} ${f.rule.padEnd(20)} ${f.message}`);
  for (const u of unverified) lines.push(`?  unverified ${u.name}@${u.version} (${u.reason})`);
  return `${lines.join('\n')}\n`;
}

function markdown({ checked, findings, unverified }: Report): string {
  const out = ['### provenance-guard', ''];
  if (findings.length) {
    out.push('| Severity | Package | Rule | Detail |', '|---|---|---|---|');
    for (const f of findings) {
      out.push(
        `| ${ICON[f.severity]} ${f.severity} | \`${f.name}@${f.version}\` | \`${f.rule}\` | ${cell(f.message)} |`,
      );
    }
    out.push('', `${plural(checked, 'package')} checked.`);
  } else {
    out.push(clean(checked, unverified.length));
  }
  if (unverified.length) {
    const noun = unverified.length === 1 ? 'package' : 'packages';
    out.push('', `<details><summary>${unverified.length} ${noun} could not be verified</summary>`, '');
    for (const u of unverified) out.push(`- \`${u.name}@${u.version}\`: ${u.reason}`);
    out.push('', '</details>');
  }
  return `${out.join('\n')}\n`;
}

/** Formats a result for humans (`text`), machines (`json`) or PR summaries (`markdown`). */
export function render(format: OutputFormat, report: Report): string {
  if (format === 'json') {
    const { checked, findings, unverified } = report;
    return `${JSON.stringify({ checked, findings, unverified }, null, 2)}\n`;
  }
  return format === 'markdown' ? markdown(report) : text(report);
}
