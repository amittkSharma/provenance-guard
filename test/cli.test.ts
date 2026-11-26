import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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
  'multi-lib': packument('multi-lib', {
    '1.0.0': { trust: 'provenance', user: 'alice' },
    '1.0.1': { trust: 'none', user: 'bob' },
    '1.0.2': { trust: 'none', user: 'mallory' },
  }),
  ...Object.fromEntries(
    ['grp-a', 'grp-b', 'grp-c'].map((n) => [
      n,
      packument(n, { '1.0.0': { trust: 'none', user: 'alice' }, '2.0.0': { trust: 'none', user: 'mallory' } }),
    ]),
  ),
  solo: packument('solo', { '1.0.0': { trust: 'none', user: 'alice' }, '2.0.0': { trust: 'none', user: 'eve' } }),
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
  JSON.stringify(
    {
      lockfileVersion: 3,
      packages: Object.fromEntries(
        Object.entries(deps).map(([n, v]) => [
          `node_modules/${n}`,
          { version: v, resolved: `${REGISTRY}/${n}/-/${n.split('/').at(-1)}-${v}.tgz` },
        ]),
      ),
    },
    null,
    2, // pretty-printed like real lockfiles, so packages have their own lines
  );

/** npm workspaces lockfile: apps/web → packages/ui (workspace) → `deps`. */
const monorepoLock = (deps: Record<string, string>) =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'mono', workspaces: ['apps/*', 'packages/*'] },
      'apps/web': { name: 'web', dependencies: { ui: '*' } },
      'apps/admin': { name: 'admin', dependencies: { 'safe-lib': '*' } },
      'packages/ui': { name: 'ui', dependencies: Object.fromEntries(Object.keys(deps).map((n) => [n, '*'])) },
      'node_modules/ui': { resolved: 'packages/ui', link: true },
      ...Object.fromEntries(
        Object.entries(deps).map(([n, v]) => [
          `node_modules/${n}`,
          { version: v, resolved: `${REGISTRY}/${n}/-/${n}-${v}.tgz` },
        ]),
      ),
    },
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
const withoutLocations = (items: { locations?: unknown }[]) => items.map(({ locations: _, ...rest }) => rest);
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
  assert.deepEqual(withoutLocations(JSON.parse(r.stdout).unverified), [
    { name: '@corp/internal', version: '1.0.0', reason: 'registry 404' },
  ]);
});

test('version missing from the registry → unverified', async () => {
  const cwd = repo({}, { 'safe-lib': '7.7.7' });
  const r = await cli(['scan', '--format', 'json'], cwd);
  assert.deepEqual(withoutLocations(JSON.parse(r.stdout).unverified), [
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

test('attestation that cannot be read → unverified, not silently skipped', async () => {
  const pk = packument('attested-lib', {
    '1.0.0': { trust: 'provenance', user: 'ci' },
    '1.0.1': { trust: 'provenance', user: 'ci' },
  });
  const cwd = repo({ 'attested-lib': '1.0.0' }, { 'attested-lib': '1.0.1' });
  const r = await run(['diff', '--base', 'HEAD', '--format', 'json'], {
    cwd,
    env: {},
    fetchJson: async (url) => (url.endsWith('/attested-lib') ? { status: 200, body: pk } : { status: 404 }),
  });
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(withoutLocations(JSON.parse(r.stdout).unverified), [
    { name: 'attested-lib', version: '1.0.1', reason: 'provenance attestation could not be read' },
  ]);
});

test('text and markdown do not show ✅ when packages are unverified', async () => {
  const report = {
    checked: 2,
    findings: [],
    unverified: [{ name: '@corp/x', version: '1.0.0', reason: 'registry 404' }],
  };
  for (const format of ['text', 'markdown'] as const) {
    const out = render(format, report);
    assert.doesNotMatch(out, /✅/, format);
    assert.match(out, /1 of 2 packages could not be verified/, format);
  }
});

test('monorepo: findings name the workspaces that use the package', async () => {
  const cwd = repo(undefined, {});
  writeFileSync(join(cwd, 'package-lock.json'), monorepoLock({ 'demo-lib': '1.0.1', 'safe-lib': '2.0.1' }));
  const r = await cli(['scan', '--format', 'json'], cwd);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.findings[0].usedBy, ['apps/web', 'packages/ui']);
  assert.deepEqual(out.unverified, []);
});

test('single project: findings have no usedBy', async () => {
  const cwd = repo({ 'demo-lib': '1.0.0' }, { 'demo-lib': '1.0.1' });
  const out = JSON.parse((await cli(['diff', '--base', 'HEAD', '--format', 'json'], cwd)).stdout);
  assert.equal(out.findings[0].usedBy, undefined);
});

test('text and markdown show "used by"', async () => {
  const report = {
    checked: 1,
    unverified: [],
    findings: [
      {
        rule: 'trust-downgrade' as const,
        severity: 'error' as const,
        name: 'a',
        version: '1.0.1',
        message: 'a@1.0.1 has none; earlier releases had provenance',
        usedBy: ['apps/a', 'apps/b', 'apps/c', 'apps/d', 'apps/e', 'apps/f', 'apps/g'],
      },
    ],
  };
  assert.match(render('text', report), /used by apps\/a, apps\/b, apps\/c, apps\/d, apps\/e \+2 more/);
  const md = render('markdown', report);
  assert.match(md, /\| Severity \| Package \| Rule \| Detail \| Used by \|/);
  assert.match(md, /\| `apps\/a`, `apps\/b`, `apps\/c`, `apps\/d`, `apps\/e` \+2 more \|$/m);
});

/** Root project with `root` deps plus a nested project `legacy/` with its own lockfile. */
function nestedRepo(root: Record<string, string>, legacy: Record<string, string>, config?: object): string {
  const cwd = repo(undefined, root, config);
  mkdirSync(join(cwd, 'legacy'));
  writeFileSync(join(cwd, 'legacy/package-lock.json'), lock(legacy));
  return cwd;
}

test('nested lockfile without --recursive → warning, no ✅, exit unchanged', async () => {
  const cwd = nestedRepo({ 'safe-lib': '2.0.1' }, { 'demo-lib': '1.0.1' });
  const r = await cli(['scan'], cwd);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /✅/);
  assert.match(r.stdout, /1 more lockfile not checked: legacy\/package-lock\.json \(use --recursive or exclude it\)/);
  const json = JSON.parse((await cli(['scan', '--format', 'json'], cwd)).stdout);
  assert.equal(json.warnings.length, 1);
});

test('--recursive checks nested lockfiles and attributes findings to their directory', async () => {
  const cwd = nestedRepo({ 'safe-lib': '2.0.1' }, { 'demo-lib': '1.0.1' });
  const r = await cli(['scan', '--recursive', '--format', 'json'], cwd);
  assert.equal(r.exitCode, 1, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.checked, 2);
  assert.deepEqual(out.warnings, []);
  assert.deepEqual(out.findings[0].usedBy, ['legacy']);
});

test('--recursive diff: a nested lockfile new since base → all its packages checked', async () => {
  const cwd = nestedRepo({ 'safe-lib': '2.0.1' }, { 'demo-lib': '1.0.1' });
  execFileSync('git', ['add', '-A'], { cwd });
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'head'], { cwd });
  writeFileSync(join(cwd, 'legacy/package-lock.json'), lock({ 'demo-lib': '1.0.1', 'safe-lib': '2.0.0' }));
  const out = JSON.parse((await cli(['diff', '--base', 'HEAD', '--recursive', '--format', 'json'], cwd)).stdout);
  assert.equal(out.checked, 1); // only safe-lib@2.0.0 is new
});

test('the same bad version in two lockfiles is reported once, used by both', async () => {
  const cwd = nestedRepo({ 'demo-lib': '1.0.1' }, { 'demo-lib': '1.0.1' });
  const out = JSON.parse((await cli(['scan', '--recursive', '--format', 'json'], cwd)).stdout);
  assert.equal(out.checked, 1);
  const downgrades = out.findings.filter((f: { rule: string }) => f.rule === 'trust-downgrade');
  assert.equal(downgrades.length, 1);
  assert.deepEqual(downgrades[0].usedBy, ['.', 'legacy']);
});

test('exclude in config silences the nested-lockfile warning', async () => {
  const cwd = nestedRepo({ 'safe-lib': '2.0.1' }, { 'demo-lib': '1.0.1' }, { exclude: ['legacy'] });
  const out = JSON.parse((await cli(['scan', '--format', 'json'], cwd)).stdout);
  assert.deepEqual(out.warnings, []);
});

test('--recursive with --lockfile → exit 2', async () => {
  const cwd = nestedRepo({ 'safe-lib': '2.0.1' }, {});
  const r = await cli(['scan', '--recursive', '--lockfile', 'package-lock.json'], cwd);
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /--recursive and --lockfile cannot be combined/);
});

test('--recursive without any lockfile → exit 2', async () => {
  const r = await cli(['scan', '--recursive'], mkdtempSync(join(tmpdir(), 'pg-none-')));
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /no lockfile found/);
});

test('invalid exclude in config → exit 2', async () => {
  const cwd = repo({}, {}, { exclude: 'legacy' });
  const r = await cli(['scan'], cwd);
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /exclude must be an array of paths/);
});

test('--recursive checks a root lockfile that git ignores (never fewer lockfiles than the default)', async () => {
  const cwd = nestedRepo({ 'safe-lib': '2.0.1' }, { 'demo-lib': '1.0.1' });
  writeFileSync(join(cwd, '.gitignore'), '/package-lock.json\n');
  const out = JSON.parse((await cli(['scan', '--recursive', '--format', 'json'], cwd)).stdout);
  assert.equal(out.checked, 2);
});

test('monorepo: a package no workspace reaches gets no usedBy (not the root)', async () => {
  const cwd = repo(undefined, {});
  const content = JSON.parse(monorepoLock({ 'safe-lib': '2.0.1' }));
  content.packages['node_modules/demo-lib'] = {
    version: '1.0.1',
    resolved: `${REGISTRY}/demo-lib/-/demo-lib-1.0.1.tgz`,
  };
  writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify(content));
  const out = JSON.parse((await cli(['scan', '--format', 'json'], cwd)).stdout);
  const finding = out.findings.find((f: { name: string }) => f.name === 'demo-lib');
  assert.equal(finding.usedBy, undefined);
});

test('CLI --recursive wins over a lockfile set in the config', async () => {
  const cwd = nestedRepo({ 'safe-lib': '2.0.1' }, { 'demo-lib': '1.0.1' }, { lockfile: 'package-lock.json' });
  const r = await cli(['scan', '--recursive', '--format', 'json'], cwd);
  assert.equal(r.exitCode, 1, r.stderr);
  assert.equal(JSON.parse(r.stdout).checked, 2);
});

test('recursive must be a boolean in config', async () => {
  const cwd = repo({}, {}, { recursive: 'false' });
  const r = await cli(['scan'], cwd);
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /recursive must be true or false/);
});

test('markdown lists usedBy for unverified packages and neutralises backticks in paths', () => {
  const md = render('markdown', {
    checked: 1,
    findings: [
      { rule: 'trust-downgrade', severity: 'error', name: 'a', version: '1.0.0', message: 'm', usedBy: ['apps/we`b'] },
    ],
    unverified: [{ name: '@corp/x', version: '1.0.0', reason: 'registry 404', usedBy: ['apps/web', 'apps/admin'] }],
  });
  assert.match(md, /- `@corp\/x@1\.0\.0`: registry 404 — used by `apps\/web`, `apps\/admin`/);
  assert.match(md, /`apps\/we'b`/);
});

test('recursive: true in config turns recursive mode on without the flag', async () => {
  const cwd = nestedRepo({ 'safe-lib': '2.0.1' }, { 'demo-lib': '1.0.1' }, { recursive: true });
  const out = JSON.parse((await cli(['scan', '--format', 'json'], cwd)).stdout);
  assert.equal(out.checked, 2);
  assert.deepEqual(out.warnings, []);
});

test('recursive: false in config checks only the root lockfile and warns about the rest', async () => {
  const cwd = nestedRepo({ 'safe-lib': '2.0.1' }, { 'demo-lib': '1.0.1' }, { recursive: false });
  const out = JSON.parse((await cli(['scan', '--format', 'json'], cwd)).stdout);
  assert.equal(out.checked, 1);
  assert.equal(out.warnings.length, 1);
});

test('same version from different lockfiles: identical findings merge, differing ones stay separate', async () => {
  // Root upgrades multi-lib 1.0.0 → 1.0.2, legacy/ upgrades 1.0.1 → 1.0.2.
  const cwd = repo({ 'multi-lib': '1.0.0' }, { 'multi-lib': '1.0.2' });
  mkdirSync(join(cwd, 'legacy'));
  writeFileSync(join(cwd, 'legacy/package-lock.json'), lock({ 'multi-lib': '1.0.1' }));
  execFileSync('git', ['add', 'legacy'], { cwd });
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'legacy'], { cwd });
  writeFileSync(join(cwd, 'legacy/package-lock.json'), lock({ 'multi-lib': '1.0.2' }));

  const out = JSON.parse((await cli(['diff', '--base', 'HEAD', '--recursive', '--format', 'json'], cwd)).stdout);
  const rows = out.findings.map((f: { rule: string; message: string; usedBy: string[] }) => [
    f.rule,
    f.message,
    f.usedBy,
  ]);
  assert.deepEqual(rows, [
    ['trust-downgrade', 'multi-lib@1.0.2 has none; earlier releases had provenance', ['.', 'legacy']],
    ['publisher-changed', 'multi-lib@1.0.2 published by mallory; previously alice', ['.']],
    ['publisher-changed', 'multi-lib@1.0.2 published by mallory; previously bob', ['legacy']],
  ]);
  assert.equal(out.checked, 1);
});

test('unresolved links and required dependencies become notes; ✅ and exit code are unaffected', async () => {
  const cwd = repo(undefined, {});
  const content = JSON.parse(monorepoLock({ 'safe-lib': '2.0.1' }));
  content.packages['node_modules/safe-lib'].dependencies = { ms: '^2.1.3' };
  content.packages['apps/web'].dependencies.gone = '*';
  content.packages['node_modules/gone'] = { resolved: '../gone', link: true };
  writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify(content));
  const r = await cli(['scan', '--format', 'json'], cwd);
  assert.equal(r.exitCode, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.warnings, []);
  assert.deepEqual(out.notes, [
    "package-lock.json: 1 workspace dependency could not be resolved, so 'used by' doesn't follow it: gone → ../gone",
    "package-lock.json: 1 required dependency is missing from the lockfile, so 'used by' may be incomplete (is the lockfile out of sync?): safe-lib → ms",
  ]);
  const text = (await cli(['scan'], cwd)).stdout;
  assert.match(text, /✅/);
  assert.match(text, /ℹ️ package-lock\.json: 1 workspace dependency could not be resolved/);
});

test('--output writes several formats from one run with the same registry calls as one format', async () => {
  const cwd = repo({ 'demo-lib': '1.0.0' }, { 'demo-lib': '1.0.1' });
  let calls = 0;
  const counting: FetchJson = async (url) => {
    calls++;
    return fetchJson(url);
  };
  await run(['diff', '--base', 'HEAD'], { cwd, env, fetchJson: counting });
  const single = calls;
  calls = 0;
  const r = await run(
    [
      'diff',
      '--base',
      'HEAD',
      '--output',
      'sarif=reports/pg.sarif',
      '--output',
      'junit=reports/pg.junit.xml',
      '--output',
      'html=reports/pg.html',
      '--output',
      'json=reports/pg.json',
      '--output',
      'markdown=reports/pg.md',
    ],
    { cwd, env, fetchJson: counting },
  );
  assert.equal(r.exitCode, 1, r.stderr);
  assert.equal(calls, single);
  assert.match(r.stdout, /trust-downgrade/); // stdout still gets the text report
  const sarifLog = JSON.parse(readFileSync(join(cwd, 'reports/pg.sarif'), 'utf8'));
  const location = sarifLog.runs[0].results[0].locations[0].physicalLocation;
  assert.equal(location.artifactLocation.uri, 'package-lock.json');
  assert.ok(location.region.startLine > 1);
  assert.match(readFileSync(join(cwd, 'reports/pg.junit.xml'), 'utf8'), /<testsuites/);
  assert.match(readFileSync(join(cwd, 'reports/pg.html'), 'utf8'), /<!doctype html>/i);
  assert.equal(JSON.parse(readFileSync(join(cwd, 'reports/pg.json'), 'utf8')).findings[0].rule, 'trust-downgrade');
  assert.match(readFileSync(join(cwd, 'reports/pg.md'), 'utf8'), /### provenance-guard/);
});

test('JSON findings include their lockfile locations', async () => {
  const cwd = repo({ 'demo-lib': '1.0.0' }, { 'demo-lib': '1.0.1' });
  const out = JSON.parse((await cli(['diff', '--base', 'HEAD', '--format', 'json'], cwd)).stdout);
  assert.equal(out.findings[0].locations[0].file, 'package-lock.json');
  assert.ok(out.findings[0].locations[0].line > 1);
  assert.deepEqual(out.lockfiles, ['package-lock.json']);
});

test('--format sarif prints SARIF to stdout', async () => {
  const cwd = repo({ 'demo-lib': '1.0.0' }, { 'demo-lib': '1.0.1' });
  assert.equal(JSON.parse((await cli(['diff', '--base', 'HEAD', '--format', 'sarif'], cwd)).stdout).version, '2.1.0');
});

test('invalid --output → exit 2', async () => {
  const cwd = repo({}, {});
  for (const output of ['pdf=x.pdf', 'sarif', 'sarif=']) {
    const r = await cli(['scan', '--output', output], cwd);
    assert.equal(r.exitCode, 2, output);
    assert.match(r.stderr, /--output/, output);
  }
});

test('findings from one publish event share a group; the group lists every package', async () => {
  const cwd = repo(
    { 'grp-a': '1.0.0', 'grp-b': '1.0.0', 'grp-c': '1.0.0', solo: '1.0.0' },
    { 'grp-a': '2.0.0', 'grp-b': '2.0.0', 'grp-c': '2.0.0', solo: '2.0.0' },
  );
  const out = JSON.parse((await cli(['diff', '--base', 'HEAD', '--format', 'json'], cwd)).stdout);
  assert.equal(out.findings.length, 4); // nothing dropped
  const grouped = out.findings.filter((f: { group?: string }) => f.group);
  assert.deepEqual(
    grouped.map((f: { name: string }) => f.name),
    ['grp-a', 'grp-b', 'grp-c'],
  );
  assert.equal(new Set(grouped.map((f: { group: string }) => f.group)).size, 1);
  assert.equal(out.findings.find((f: { name: string }) => f.name === 'solo').group, undefined);
  assert.deepEqual(out.groups, [
    {
      id: grouped[0].group,
      rule: 'publisher-changed',
      severity: 'warn',
      version: '2.0.0',
      detail: 'published by mallory; previously alice',
      packages: ['grp-a', 'grp-b', 'grp-c'],
    },
  ]);
});

test('allowlisted findings are reported as suppressed with their reason, not dropped', async () => {
  const cwd = repo(
    { 'demo-lib': '1.0.0' },
    { 'demo-lib': '1.0.1' },
    { allow: [{ name: 'demo-lib', rule: 'trust-downgrade', reason: 'confirmed with maintainers in issue #12' }] },
  );
  const r = await cli(['diff', '--base', 'HEAD', '--format', 'json'], cwd);
  assert.equal(r.exitCode, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(
    out.findings.map((f: { rule: string }) => f.rule),
    ['publisher-changed'],
  );
  assert.equal(out.suppressed.length, 1);
  assert.equal(out.suppressed[0].rule, 'trust-downgrade');
  assert.deepEqual(out.suppressed[0].suppressed, { reason: 'confirmed with maintainers in issue #12' });
});

test('rules can be set to info: reported, never failing', async () => {
  const cwd = repo({ 'demo-lib': '1.0.0' }, { 'demo-lib': '1.0.1' }, { rules: { 'trust-downgrade': 'info' } });
  const r = await cli(['diff', '--base', 'HEAD', '--format', 'json'], cwd);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).findings[0].severity, 'info');
});

test('oldReleaseDays must be a non-negative number', async () => {
  const cwd = repo({}, {}, { oldReleaseDays: -1 });
  const r = await cli(['scan'], cwd);
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /oldReleaseDays must be a number of days \(7 or more\)/);
});

test('findings carry evidence in JSON', async () => {
  const cwd = repo({ 'demo-lib': '1.0.0' }, { 'demo-lib': '1.0.1' });
  const out = JSON.parse((await cli(['diff', '--base', 'HEAD', '--format', 'json'], cwd)).stdout);
  const evidence = out.findings[0].evidence;
  assert.equal(evidence.publisher, 'mallory');
  assert.equal(evidence.previousPublisher, 'alice');
  assert.equal(evidence.line, '1.x');
  assert.equal(evidence.bestLineTrust, 'provenance');
});

test('oldReleaseDays below 7 is rejected, so a config change cannot switch the age protection off', async () => {
  for (const days of [0, 3]) {
    const r = await cli(['scan'], repo({}, {}, { oldReleaseDays: days }));
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /oldReleaseDays must be a number of days \(7 or more\)/);
  }
});

test('timeoutMs from the config file reaches the registry client', async () => {
  const server = createServer((_req, res) => setTimeout(() => res.end('{}'), 500));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const cwd = repo({}, { 'safe-lib': '2.0.1' }, { timeoutMs: 50, registry });
    const r = await run(['scan'], { cwd, env: {} }); // real HTTP client, no injected fetchJson
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /127\.0\.0\.1.*timeout/i);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('invalid timeoutMs in config → exit 2 before any lockfile work', async () => {
  const r = await cli(['scan'], repo({}, {}, { timeoutMs: '5000' }));
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /timeoutMs must be a positive number of milliseconds/);
});

test('invalid concurrency in config → exit 2, even when a custom HTTP layer is used', async () => {
  const r = await cli(['scan'], repo({}, {}, { concurrency: 0 }));
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /concurrency must be at least 1/);
});
