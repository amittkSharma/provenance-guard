import {
  actionableRows,
  cleanHeadline,
  type RenderOptions,
  type Report,
  RULE_DOCS,
  severityCounts,
  TOOL_NAME,
  TOOL_URL,
  TOOL_VERSION,
} from './report-common.ts';
import { escapeMarkup as esc, packageId, plural } from './text.ts';
import type { Evidence, Finding, Location } from './types.ts';

const list = (items: string[] | undefined) =>
  items?.length ? items.map((i) => `<code>${esc(i)}</code>`).join(', ') : '<span class="muted">—</span>';

function where(locations: Location[] | undefined): string {
  if (!locations?.length) return '<span class="muted">—</span>';
  const items = locations.map((l) => `<code class="path">${esc(`${l.file}:${l.line}`)}</code>`).join('<br>');
  return locations.length > 3
    ? `<details><summary>${plural(locations.length, 'lockfile entry', 'lockfile entries')}</summary>${items}</details>`
    : items;
}

function evidenceList(e: Evidence | undefined): string {
  if (!e) return '<span class="muted">—</span>';
  const items = [
    `published ${esc(e.publishedAt.slice(0, 10))} (${e.ageDays} days ago) with <code>${esc(e.trust)}</code>`,
    e.publisher
      ? `by <code>${esc(e.publisher)}</code>${e.publisherIsMaintainer ? ' (listed maintainer)' : ' (<strong>not</strong> a listed maintainer)'}`
      : '',
    e.previousVersion
      ? `previous <code>${esc(e.previousVersion)}</code>${e.previousPublisher ? ` by <code>${esc(e.previousPublisher)}</code>` : ''}`
      : '',
    `best earlier: <code>${esc(e.bestEarlierTrust)}</code>; in ${esc(e.line)}: <code>${esc(e.bestLineTrust)}</code>`,
    e.lastAttestedVersion ? `last attested <code>${esc(e.lastAttestedVersion)}</code>` : '',
    e.sourceRepo
      ? `repo <code>${esc(e.sourceRepo)}</code> (before: <code>${esc(e.previousSourceRepo ?? '?')}</code>)`
      : '',
  ].filter(Boolean);
  return `<ul class="evidence">${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
}

const SEVERITY_LABEL = { error: '❌ error', warn: '⚠️ warning', info: 'ℹ️ info' } as const;

const STYLE = `
  :root { color-scheme: light dark; --bg: #fff; --fg: #1f2328; --muted: #656d76; --line: #d0d7de; --card: #f6f8fa;
    --error: #cf222e; --warn: #9a6700; --ok: #1a7f37; --note: #0969da; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --fg: #e6edf3; --muted: #8d96a0; --line: #30363d;
    --card: #161b22; --error: #ff7b72; --warn: #d29922; --ok: #3fb950; --note: #4493f8; } }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 2rem; background: var(--bg); color: var(--fg);
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 1200px; margin: 0 auto; }
  h1 { margin: 0 0 .25rem; font-size: 1.6rem; } h2 { margin-top: 2rem; font-size: 1.2rem; }
  .muted, .meta { color: var(--muted); } .meta { margin: 0 0 1rem; }
  .status { padding: .75rem 1rem; border-radius: 8px; border: 1px solid var(--line); background: var(--card);
    font-weight: 600; }
  .status.error { border-color: var(--error); } .status.warn { border-color: var(--warn); }
  .status.ok { border-color: var(--ok); }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: .75rem; margin: 1rem 0; }
  .card { padding: .75rem 1rem; border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
  .card strong { display: block; font-size: 1.6rem; }
  table { width: 100%; border-collapse: collapse; margin: .5rem 0; }
  th, td { text-align: left; vertical-align: top; padding: .5rem .6rem; border-bottom: 1px solid var(--line); }
  th { font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  code { font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
  .sev { font-weight: 600; white-space: nowrap; } .sev.error { color: var(--error); }
  .sev.warn { color: var(--warn); } .sev.note { color: var(--note); }
  ul.messages li { margin: .25rem 0; } dl dt { font-weight: 600; margin-top: .75rem; } dl dd { margin: .25rem 0 0; }
  footer { margin-top: 2.5rem; color: var(--muted); font-size: .85rem; }
  ul.evidence { margin: 0; padding-left: 1rem; font-size: .85rem; } ul.evidence li { margin: .1rem 0; }
  details summary { cursor: pointer; color: var(--note); } code.path { white-space: nowrap; } .context { color: var(--muted); font-size: .9rem; }
`;

/** Standalone HTML report (no scripts, no external assets) for sharing outside CI, e.g. with auditors. */
export function html(report: Report, { generatedAt = new Date().toISOString() }: RenderOptions = {}): string {
  const { errors, warnings, infos } = severityCounts(report);
  const suppressed = report.suppressed ?? [];
  const checked = `${plural(report.checked, 'package')} checked`;
  const status = errors
    ? { kind: 'error', text: `❌ ${plural(errors, 'error')}, ${plural(warnings, 'warning')} · ${checked}` }
    : warnings
      ? { kind: 'warn', text: `⚠️ ${plural(warnings, 'warning')} · ${checked}` }
      : { kind: cleanHeadline(report).startsWith('✅') ? 'ok' : 'warn', text: cleanHeadline(report) };
  const mode = report.base ? `changes since <code>${esc(report.base)}</code>` : 'full scan';

  const sections: string[] = [];
  const rows = actionableRows(report);
  if (rows.length) {
    const body = rows
      .map((row) => {
        if (row.kind === 'group') {
          const { group, members } = row;
          const usedBy = [...new Set(members.flatMap((m) => m.usedBy ?? []))];
          const packages = members.map((m) => `<li><code>${esc(m.name)}</code></li>`).join('');
          return `<tr>
          <td class="sev ${group.severity}">${SEVERITY_LABEL[group.severity]}</td>
          <td><details><summary>${members.length} packages @${esc(group.version)}</summary><ul>${packages}</ul></details></td>
          <td><code>${esc(group.rule)}</code></td>
          <td>${esc(group.detail)}<br><span class="context">One publish event, reported once.</span></td>
          <td>${list(usedBy)}</td>
          <td>${evidenceList(members[0].evidence)}</td>
          <td>${where(members.flatMap((m) => m.locations ?? []))}</td>
        </tr>`;
        }
        const f = row.finding;
        return `<tr>
          <td class="sev ${f.severity}">${SEVERITY_LABEL[f.severity]}</td>
          <td><code>${esc(packageId(f))}</code></td>
          <td><code>${esc(f.rule)}</code></td>
          <td>${esc(f.message)}</td>
          <td>${list(f.usedBy)}</td>
          <td>${evidenceList(f.evidence)}</td>
          <td>${where(f.locations)}</td>
        </tr>`;
      })
      .join('');
    sections.push(`<h2>Findings</h2>
      <table><thead><tr><th>Severity</th><th>Package</th><th>Rule</th><th>Detail</th><th>Used by</th><th>Evidence</th><th>Lockfile</th></tr></thead>
      <tbody>${body}</tbody></table>`);
  }

  const smallTable = (rowsHtml: string, reasonHeader: string) =>
    `<table><thead><tr><th>Package</th><th>Rule</th><th>Detail</th><th>${reasonHeader}</th><th>Evidence</th></tr></thead><tbody>${rowsHtml}</tbody></table>`;
  const smallRow = (f: Finding, reason: string) => `<tr>
          <td><code>${esc(packageId(f))}</code></td><td><code>${esc(f.rule)}</code></td>
          <td>${esc(f.message)}</td><td>${esc(reason)}</td><td>${evidenceList(f.evidence)}</td></tr>`;
  const info = report.findings.filter((f) => f.severity === 'info');
  if (info.length) {
    sections.push(`<h2>Info</h2>
      <p class="muted">True but low-risk. Shown for transparency; never fails CI.</p>
      <details><summary>${plural(info.length, 'info finding')}</summary>
      ${smallTable(info.map((f) => smallRow(f, f.context ?? '')).join(''), 'Why it is low-risk')}</details>`);
  }
  if (suppressed.length) {
    sections.push(`<h2>Allowed</h2>
      <p class="muted">Accepted in the allowlist. Shown with the reason so exceptions stay reviewable.</p>
      <details><summary>${plural(suppressed.length, 'allowed finding')}</summary>
      ${smallTable(suppressed.map((f) => smallRow(f, f.suppressed?.reason ?? '')).join(''), 'Reason')}</details>`);
  }
  if (report.unverified.length) {
    const body = report.unverified
      .map(
        (u) => `<tr>
          <td><code>${esc(packageId(u))}</code></td>
          <td>${esc(u.reason)}</td>
          <td>${list(u.usedBy)}</td>
          <td>${where(u.locations)}</td>
        </tr>`,
      )
      .join('');
    sections.push(`<h2>Could not be verified</h2>
      <table><thead><tr><th>Package</th><th>Reason</th><th>Used by</th><th>Lockfile</th></tr></thead>
      <tbody>${body}</tbody></table>`);
  }
  const messages = [
    ...(report.warnings ?? []).map((w) => `<li><span class="sev warn">⚠️ warning</span> ${esc(w)}</li>`),
    ...(report.notes ?? []).map((n) => `<li><span class="sev note">ℹ️ note</span> ${esc(n)}</li>`),
  ];
  if (messages.length) sections.push(`<h2>Coverage</h2><ul class="messages">${messages.join('')}</ul>`);

  const rules = Object.entries(RULE_DOCS)
    .map(
      ([id, doc]) =>
        `<dt><code>${id}</code> — ${esc(doc.title)}</dt><dd>${esc(doc.description)}</dd><dd><strong>What to do:</strong> ${esc(doc.action)}</dd>`,
    )
    .join('');

  const card = (n: number, one: string, many: string) =>
    `<div class="card"><strong>${n}</strong>${n === 1 ? one : many}</div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${TOOL_NAME} report</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <h1>${TOOL_NAME} report</h1>
  <p class="meta">${mode} · lockfiles: ${list(report.lockfiles)} · generated ${esc(generatedAt)}</p>
  <p class="status ${status.kind}" role="status">${esc(status.text)}</p>
  <div class="cards">
    ${card(report.checked, 'package checked', 'packages checked')}
    ${card(errors, 'error', 'errors')}
    ${card(warnings, 'warning', 'warnings')}
    ${card(infos, 'info', 'info')}
    ${card(suppressed.length, 'allowed', 'allowed')}
    ${card(report.unverified.length, 'unverified', 'unverified')}
  </div>
  ${sections.join('\n  ')}
  <h2>What the rules mean</h2>
  <dl>${rules}</dl>
  <footer>${TOOL_NAME} ${esc(TOOL_VERSION)} · <a href="${TOOL_URL}">${TOOL_URL}</a></footer>
</main>
</body>
</html>
`;
}
