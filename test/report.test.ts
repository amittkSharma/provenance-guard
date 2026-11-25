import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { type Report, render } from '../src/report.ts';

const PKG_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const AT = '2026-11-25T10:00:00.000Z';

const REPORT: Report = {
  checked: 42,
  lockfiles: ['package-lock.json', 'legacy/package-lock.json'],
  base: 'origin/main',
  findings: [
    {
      rule: 'trust-downgrade',
      severity: 'error',
      name: 'debug',
      version: '4.4.2',
      message: 'debug@4.4.2 has none; earlier releases had provenance',
      usedBy: ['apps/web', 'packages/ui'],
      locations: [{ file: 'package-lock.json', line: 12 }],
    },
    {
      rule: 'publisher-changed',
      severity: 'warn',
      name: 'debug',
      version: '4.4.2',
      message: 'debug@4.4.2 published by mallory; previously alice',
      locations: [{ file: 'package-lock.json', line: 12 }],
    },
    {
      rule: 'install-script-added',
      severity: 'warn',
      name: 'native',
      version: '1.0.0',
      message: 'native@1.0.0 adds an install script',
    },
  ],
  unverified: [
    {
      name: '@corp/x',
      version: '1.0.0',
      reason: 'registry 404',
      locations: [{ file: 'legacy/package-lock.json', line: 7 }],
    },
  ],
  warnings: ['1 more lockfile not checked: tools/yarn.lock (use --recursive or exclude it)'],
  notes: [
    "package-lock.json: 1 required dependency is missing from the lockfile, so 'used by' may be incomplete (is the lockfile out of sync?): debug → ms",
  ],
};

const sarif = () => JSON.parse(render('sarif', REPORT, { generatedAt: AT }));

test('sarif: valid 2.1.0 envelope with tool name, version and rule metadata', () => {
  const log = sarif();
  assert.equal(log.version, '2.1.0');
  assert.match(log.$schema, /sarif-2\.1\.0/);
  const driver = log.runs[0].tool.driver;
  assert.equal(driver.name, 'provenance-guard');
  assert.equal(driver.version, PKG_VERSION);
  assert.deepEqual(
    driver.rules.map((r: { id: string }) => r.id),
    ['trust-downgrade', 'source-repo-changed', 'install-script-added', 'publisher-changed', 'unverified'],
  );
  for (const rule of driver.rules) {
    assert.ok(rule.shortDescription.text && rule.fullDescription.text && rule.help.text && rule.help.markdown, rule.id);
    assert.ok(['error', 'warning', 'note'].includes(rule.defaultConfiguration.level), rule.id);
  }
});

test('sarif: findings map to results with level, rule index, location and usedBy', () => {
  const [error, warning] = sarif().runs[0].results;
  assert.equal(error.ruleId, 'trust-downgrade');
  assert.equal(error.ruleIndex, 0);
  assert.equal(error.level, 'error');
  assert.equal(error.message.text, 'debug@4.4.2 has none; earlier releases had provenance');
  assert.deepEqual(error.locations[0].physicalLocation, {
    artifactLocation: { uri: 'package-lock.json' },
    region: { startLine: 12 },
  });
  assert.deepEqual(error.properties.usedBy, ['apps/web', 'packages/ui']);
  assert.equal(warning.level, 'warning');
});

test('sarif: a finding without a location points at the first lockfile, line 1', () => {
  const result = sarif().runs[0].results[2];
  assert.deepEqual(result.locations[0].physicalLocation, {
    artifactLocation: { uri: 'package-lock.json' },
    region: { startLine: 1 },
  });
});

test('sarif: unverified packages are note-level results', () => {
  const result = sarif().runs[0].results[3];
  assert.equal(result.ruleId, 'unverified');
  assert.equal(result.level, 'note');
  assert.equal(result.message.text, '@corp/x@1.0.0 could not be verified: registry 404');
  assert.equal(result.locations[0].physicalLocation.artifactLocation.uri, 'legacy/package-lock.json');
});

test('sarif: fingerprints are stable across runs and unique per finding', () => {
  const a = sarif().runs[0].results.map((r: { partialFingerprints: object }) => JSON.stringify(r.partialFingerprints));
  const b = sarif().runs[0].results.map((r: { partialFingerprints: object }) => JSON.stringify(r.partialFingerprints));
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, a.length);
});

test('sarif: warnings and notes become tool notifications', () => {
  const invocation = sarif().runs[0].invocations[0];
  assert.equal(invocation.executionSuccessful, true);
  assert.deepEqual(
    invocation.toolExecutionNotifications.map((n: { level: string }) => n.level),
    ['warning', 'note'],
  );
});

test('junit: one failing test per error, skipped for warnings and unverified, plus a summary test', () => {
  const xml = render('junit', REPORT, { generatedAt: AT });
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<testsuites name="provenance-guard" tests="5" failures="1" skipped="3"/);
  assert.match(xml, /<testcase classname="provenance-guard\.trust-downgrade" name="debug@4\.4\.2">\s*<failure/);
  assert.match(
    xml,
    /<testcase classname="provenance-guard\.publisher-changed" name="debug@4\.4\.2">\s*<skipped message="warning: /,
  );
  assert.match(
    xml,
    /<testcase classname="provenance-guard\.unverified" name="@corp\/x@1\.0\.0">\s*<skipped message="unverified: registry 404"/,
  );
  assert.match(xml, /<testcase classname="provenance-guard" name="42 packages checked" \/>/);
  assert.match(xml, /<system-out>[^<]*1 more lockfile not checked[^<]*<\/system-out>/);
});

test('junit: XML special characters are escaped', () => {
  const xml = render('junit', {
    checked: 1,
    findings: [{ rule: 'trust-downgrade', severity: 'error', name: 'a', version: '1.0.0', message: 'x <b> & "q"' }],
    unverified: [],
  });
  assert.match(xml, /x &lt;b&gt; &amp; &quot;q&quot;/);
  assert.doesNotMatch(xml, /<b>/);
});

test('html: standalone page with summary, findings, unverified, warnings, notes and rule guide', () => {
  const html = render('html', REPORT, { generatedAt: AT });
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<title>provenance-guard report<\/title>/);
  assert.match(html, /1 error/);
  assert.match(html, /2 warnings/);
  assert.match(html, /42 packages checked/);
  assert.match(html, /debug@4\.4\.2/);
  assert.match(html, /apps\/web/);
  assert.match(html, /package-lock\.json:12/);
  assert.match(html, /@corp\/x@1\.0\.0/);
  assert.match(html, /1 more lockfile not checked/);
  assert.match(html, /required dependency is missing/);
  assert.match(html, /What the rules mean/);
  assert.match(html, /origin\/main/);
  assert.match(html, new RegExp(AT));
  assert.doesNotMatch(html, /<script|https?:\/\/(?!github\.com\/amittkSharma)/); // no scripts, no external assets
});

test('html: lockfile-controlled values are escaped', () => {
  const html = render('html', {
    checked: 1,
    findings: [
      {
        rule: 'trust-downgrade',
        severity: 'error',
        name: '<img src=x onerror=alert(1)>',
        version: '1.0.0',
        message: '"><script>alert(1)</script>',
        usedBy: ['apps/<b>'],
      },
    ],
    unverified: [],
  });
  assert.doesNotMatch(html, /<img src=x|<script>|<b>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('html: clean result shows a pass status', () => {
  assert.match(
    render('html', { checked: 3, findings: [], unverified: [] }),
    /✅ 3 packages checked, no trust regressions/,
  );
});

// ---- grouping, info and suppressed ----
const ev = (publisher: string, previousPublisher: string) => ({
  publishedAt: '2026-07-08T00:00:00.000Z',
  ageDays: 140,
  trust: 'none' as const,
  publisher,
  publisherIsMaintainer: true,
  previousVersion: '7.0.1',
  previousPublisher,
  line: '7.x',
  bestEarlierTrust: 'none' as const,
  bestLineTrust: 'none' as const,
});
const member = (name: string) => ({
  rule: 'publisher-changed' as const,
  severity: 'warn' as const,
  name,
  version: '7.0.2',
  message: `${name}@7.0.2 published by microsoft1es; previously typescript-deploys`,
  group: 'publisher-changed:abc123',
  evidence: ev('microsoft1es', 'typescript-deploys'),
});
const NOISY: Report = {
  checked: 10,
  lockfiles: ['package-lock.json'],
  findings: [
    member('@typescript/a'),
    member('@typescript/b'),
    member('typescript'),
    {
      rule: 'trust-downgrade',
      severity: 'info',
      name: 'vite',
      version: '5.4.21',
      message: 'vite@5.4.21 has provenance; earlier releases had trusted-publisher',
      context:
        'Newer release lines use trusted-publisher; the 5.x line never had better than provenance, so this release is not weaker than its own line.',
    },
  ],
  groups: [
    {
      id: 'publisher-changed:abc123',
      rule: 'publisher-changed',
      severity: 'warn',
      version: '7.0.2',
      detail: 'published by microsoft1es; previously typescript-deploys',
      packages: ['@typescript/a', '@typescript/b', 'typescript'],
    },
  ],
  suppressed: [
    {
      rule: 'trust-downgrade',
      severity: 'error',
      name: 'undici-types',
      version: '6.21.0',
      message: 'undici-types@6.21.0 has none; earlier releases had provenance',
      suppressed: { reason: 'maintainer published 6.19.3–6.22 by hand; checked 2026-11-25' },
    },
  ],
  unverified: [],
};

test('text: a group is one row listing its packages; info and allowed are separate sections', () => {
  const out = render('text', NOISY);
  const lines = out.split('\n');
  assert.equal(lines.filter((l) => l.includes('publisher-changed')).length, 1);
  assert.match(
    out,
    /3 packages @7\.0\.2 published by microsoft1es; previously typescript-deploys — @typescript\/a, @typescript\/b, typescript/,
  );
  assert.match(out, /ℹ️ info .*vite@5\.4\.21 has provenance.* — Newer release lines use trusted-publisher/);
  assert.match(out, /allowed .*undici-types@6\.21\.0 .*— maintainer published 6\.19\.3–6\.22 by hand/);
  assert.match(lines[0], /3 findings .*1 info/);
});

test('markdown: grouped row, info and allowed in collapsed sections', () => {
  const md = render('markdown', NOISY);
  assert.equal((md.match(/`publisher-changed`/g) ?? []).length, 1);
  assert.match(md, /3 packages: `@typescript\/a`, `@typescript\/b`, `typescript`/);
  assert.match(md, /<details><summary>1 info finding<\/summary>/);
  assert.match(md, /<details><summary>1 allowed finding<\/summary>/);
  assert.match(md, /maintainer published 6\.19\.3–6\.22 by hand/);
});

test('html: group lists every package; evidence, info and allowed sections are shown', () => {
  const html = render('html', NOISY, { generatedAt: AT });
  for (const name of ['@typescript/a', '@typescript/b', 'typescript'])
    assert.match(html, new RegExp(`<code>${name}</code>`));
  assert.match(html, /3 packages/);
  assert.match(html, /<h2>Info<\/h2>/);
  assert.match(html, /<h2>Allowed<\/h2>/);
  assert.match(html, /maintainer published 6\.19\.3–6\.22 by hand/);
  assert.match(html, /microsoft1es.*listed maintainer/s);
  assert.match(html, /140 days/);
});

test('sarif: info → note, group members share a GUID, allowed findings carry suppressions, evidence in properties', () => {
  const results = JSON.parse(render('sarif', NOISY)).runs[0].results;
  const grouped = results.filter((r: { ruleId: string }) => r.ruleId === 'publisher-changed');
  assert.equal(grouped.length, 3); // every package is still its own result
  assert.equal(new Set(grouped.map((r: { correlationGuid: string }) => r.correlationGuid)).size, 1);
  assert.match(grouped[0].correlationGuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(grouped[0].properties.evidence.publisher, 'microsoft1es');
  const info = results.find((r: { properties: { package: string } }) => r.properties.package === 'vite');
  assert.equal(info.level, 'note');
  assert.match(info.message.text, /Newer release lines use trusted-publisher/);
  const allowed = results.find((r: { properties: { package: string } }) => r.properties.package === 'undici-types');
  assert.deepEqual(allowed.suppressions, [
    {
      kind: 'external',
      status: 'accepted',
      justification: 'maintainer published 6.19.3–6.22 by hand; checked 2026-11-25',
    },
  ]);
});

test('junit: info passes with its context, allowed findings are skipped with the reason', () => {
  const xml = render('junit', NOISY, { generatedAt: AT });
  assert.match(
    xml,
    /<testcase classname="provenance-guard\.trust-downgrade" name="vite@5\.4\.21">\s*<system-out>info: /,
  );
  assert.match(
    xml,
    /<testcase classname="provenance-guard\.trust-downgrade" name="undici-types@6\.21\.0">\s*<skipped message="allowed: maintainer published/,
  );
  assert.match(xml, /tests="6" failures="0" skipped="4"/);
});

test('json: groups and suppressed are included', () => {
  const out = JSON.parse(render('json', NOISY));
  assert.equal(out.groups[0].packages.length, 3);
  assert.equal(out.suppressed[0].suppressed.reason, 'maintainer published 6.19.3–6.22 by hand; checked 2026-11-25');
});

test('html: many lockfile locations collapse behind a summary', () => {
  const locations = Array.from({ length: 21 }, (_, i) => ({ file: 'package-lock.json', line: 100 + i }));
  const html = render('html', { ...NOISY, findings: NOISY.findings.map((f) => (f.group ? { ...f, locations } : f)) });
  assert.match(html, /<details><summary>63 lockfile entries<\/summary>/);
});
