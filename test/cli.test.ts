import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { run } from '../src/cli.ts';
import { check } from '../src/index.ts';
import type { FetchJson } from '../src/registry.ts';
import { render } from '../src/report.ts';

const REGISTRY = 'https://registry.npmjs.org';

const packument = (name: string, versions: Record<string, { trust: 'none' | 'provenance'; user: string }>) => ({
  name,
  time: Object.fromEntries(Object.keys(versions).map((v, i) => [v, `2025-01-0${i + 1}T00:00:00.000Z`])),
  versions: Object.fromEntries(
    Object.entries(versions).map(([v, { trust, user }]) => [
      v,
      {
        version: v,
        _npmUser: { name: user },
        dist: trust === 'provenance' ? { attestations: { url: 'x', provenance: {} } } : {},
      },
    ]),
  ),
});

const PACKUMENTS: Record<string, unknown> = {
  'demo-lib': packument('demo-lib', {
    '1.0.0': { trust: 'provenance', user: 'alice' },
    '1.0.1': { trust: 'none', user: 'mallory' },
  }),
  'safe-lib': packument('safe-lib', {
    '2.0.0': { trust: 'none', user: 'bob' },
    '2.0.1': { trust: 'none', user: 'bob' },
  }),
};

const fetchJson: FetchJson = async (url) => {
  const name = decodeURIComponent(url.slice(REGISTRY.length + 1));
  if (name === 'x') return { status: 404 }; // attestation bundle, not needed here
  if (name === 'broken-lib') return { status: 503 };
  return PACKUMENTS[name] ? { status: 200, body: PACKUMENTS[name] } : { status: 404 };
};

const lock = (deps: Record<string, string>) =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: Object.fromEntries(
      Object.entries(deps).map(([n, v]) => [
        `node_modules/${n}`,
        { version: v, resolved: `${REGISTRY}/${n}/-/${n.split('/').at(-1)}-${v}.tgz` },
      ]),
    ),
  });

/** Temp git repo whose committed lockfile is `base` and working-tree lockfile is `head`. */
function repo(base: Record<string, string> | undefined, head: Record<string, string>, config?: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'pg-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  if (base) writeFileSync(join(dir, 'package-lock.json'), lock(base));
  writeFileSync(join(dir, 'README'), 'x');
  git('add', '-A');
  git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'base');
  writeFileSync(join(dir, 'package-lock.json'), lock(head));
  if (config) writeFileSync(join(dir, '.provenance-guard.json'), JSON.stringify(config));
  return dir;
}

const env = { npm_config_registry: undefined };
const cli = (argv: string[], cwd: string) => run(argv, { fetchJson, cwd, env });

test('diff: downgrade → exit 1, findings in JSON', async () => {
  const cwd = repo({ 'demo-lib': '1.0.0', 'safe-lib': '2.0.0' }, { 'demo-lib': '1.0.1', 'safe-lib': '2.0.0' });
  const r = await cli(['diff', '--base', 'HEAD', '--format', 'json'], cwd);
  assert.equal(r.exitCode, 1, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.checked, 1);
  assert.deepEqual(
    out.findings.map((f: { rule: string; severity: string }) => [f.rule, f.severity]),
    [
      ['trust-downgrade', 'error'],
      ['publisher-changed', 'warn'],
    ],
  );
});

test('diff: unchanged lockfile → exit 0 with success message', async () => {
  const cwd = repo({ 'safe-lib': '2.0.0' }, { 'safe-lib': '2.0.0' });
  const r = await cli(['diff', '--base', 'HEAD'], cwd);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.match(r.stdout, /✅ 0 packages checked, no trust regressions/);
});

test('diff: base ref without a lockfile → every package is checked', async () => {
  const cwd = repo(undefined, { 'demo-lib': '1.0.1', 'safe-lib': '2.0.1' });
  const r = await cli(['diff', '--base', 'HEAD', '--format', 'json'], cwd);
  assert.equal(JSON.parse(r.stdout).checked, 2);
});

test('scan: checks every package in the lockfile', async () => {
  const cwd = repo({ 'demo-lib': '1.0.1' }, { 'demo-lib': '1.0.1', 'safe-lib': '2.0.1' });
  const r = await cli(['scan', '--format', 'json'], cwd);
  assert.equal(r.exitCode, 1);
  assert.equal(JSON.parse(r.stdout).checked, 2);
});

test('allowlisted finding → exit 0', async () => {
  const cwd = repo(
    { 'demo-lib': '1.0.0' },
    { 'demo-lib': '1.0.1' },
    {
      allow: [
        { name: 'demo-lib', rule: 'trust-downgrade', reason: 'maintainer moved CI, confirmed in issue #12' },
        { name: 'demo-lib', rule: 'publisher-changed', version: '1.0.1', reason: 'new maintainer' },
      ],
    },
  );
  const r = await cli(['diff', '--base', 'HEAD', '--format', 'json'], cwd);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).findings, []);
});

test('allow entry for another version does not apply', async () => {
  const cwd = repo(
    { 'demo-lib': '1.0.0' },
    { 'demo-lib': '1.0.1' },
    { allow: [{ name: 'demo-lib', rule: 'trust-downgrade', version: '9.9.9', reason: 'other version' }] },
  );
  assert.equal((await cli(['diff', '--base', 'HEAD'], cwd)).exitCode, 1);
});

test('allowlist entry without reason → exit 2', async () => {
  const cwd = repo({}, {}, { allow: [{ name: 'demo-lib', rule: 'trust-downgrade' }] });
  const r = await cli(['diff', '--base', 'HEAD'], cwd);
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /allowlist entry for demo-lib needs a reason/);
});

test('rule severity override: downgrade as warn → exit 0; off removes the finding', async () => {
  const cwd = repo(
    { 'demo-lib': '1.0.0' },
    { 'demo-lib': '1.0.1' },
    { rules: { 'trust-downgrade': 'warn', 'publisher-changed': 'off' } },
  );
  const r = await cli(['diff', '--base', 'HEAD', '--format', 'json'], cwd);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(
    JSON.parse(r.stdout).findings.map((f: { rule: string; severity: string }) => [f.rule, f.severity]),
    [['trust-downgrade', 'warn']],
  );
});

test('invalid rule severity in config → exit 2', async () => {
  const cwd = repo({}, {}, { rules: { 'trust-downgrade': 'fatal' } });
  const r = await cli(['scan'], cwd);
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /trust-downgrade/);
});

test('registry 503 → exit 2, stderr names the url', async () => {
  const cwd = repo({}, { 'broken-lib': '1.0.0' });
  const r = await cli(['scan'], cwd);
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /registry\.npmjs\.org\/broken-lib/);
});

test('private 404 package → exit 0, listed as unverified', async () => {
  const cwd = repo({}, { '@corp/internal': '1.0.0' });
  const r = await cli(['scan', '--format', 'json'], cwd);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).unverified, [
    { name: '@corp/internal', version: '1.0.0', reason: 'registry 404' },
  ]);
});

test('version missing from the registry → unverified', async () => {
  const cwd = repo({}, { 'safe-lib': '7.7.7' });
  const r = await cli(['scan', '--format', 'json'], cwd);
  assert.deepEqual(JSON.parse(r.stdout).unverified, [
    { name: 'safe-lib', version: '7.7.7', reason: 'version not in registry' },
  ]);
});

test('no lockfile → exit 2', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pg-empty-'));
  const r = await cli(['scan'], cwd);
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /no lockfile found/);
});

test('unknown option → exit 2 with usage', async () => {
  const r = await cli(['scan', '--nope'], process.cwd());
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /Usage: provenance-guard/);
});

test('--help → exit 0 with usage on stdout', async () => {
  const r = await cli(['--help'], process.cwd());
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /Usage: provenance-guard/);
});

test('check() API: options object without CLI or config file', async () => {
  const cwd = repo({ 'demo-lib': '1.0.0' }, { 'demo-lib': '1.0.1' });
  const result = await check({
    cwd,
    base: 'HEAD',
    fetchJson,
    registry: REGISTRY,
    rules: { 'publisher-changed': 'off' },
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(
    result.findings.map((f) => f.rule),
    ['trust-downgrade'],
  );
});

test('markdown: empty result', () => {
  assert.match(
    render('markdown', { findings: [], unverified: [], checked: 3 }),
    /✅ 3 packages checked, no trust regressions/,
  );
});

test('markdown: findings table and unverified details', () => {
  const md = render('markdown', {
    checked: 2,
    findings: [{ rule: 'trust-downgrade', severity: 'error', name: 'a', version: '1.0.1', message: 'a|b' }],
    unverified: [{ name: '@corp/x', version: '1.0.0', reason: 'registry 404' }],
  });
  assert.match(md, /^### provenance-guard/);
  assert.match(md, /\| Severity \| Package \| Rule \| Detail \|/);
  assert.match(md, /\| ❌ error \| `a@1\.0\.1` \| `trust-downgrade` \| a\\\|b \|/);
  assert.match(md, /<details><summary>1 package could not be verified<\/summary>/);
});

test('registry comes from npm_config_registry when not configured', async () => {
  const cwd = repo({}, { 'safe-lib': '2.0.1' });
  const urls: string[] = [];
  await run(['scan'], {
    cwd,
    env: { npm_config_registry: 'https://mirror.example/npm/' },
    fetchJson: async (url) => {
      urls.push(url);
      return { status: 404 };
    },
  });
  assert.deepEqual(urls, ['https://mirror.example/npm/safe-lib']);
});
