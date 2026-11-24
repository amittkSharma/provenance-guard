import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { nodeProjectFiles, workspaceUsage } from '../src/workspaces.ts';
import { readFixture } from './helpers.ts';

const EXPECTED = {
  'chalk@4.1.2': ['apps/web'],
  'chalk@5.3.0': ['apps/web', 'packages/ui'],
  'debug@4.4.1': ['apps/web', 'packages/ui'],
  'ms@2.1.3': ['apps/web', 'packages/ui'],
  'typescript@5.6.3': ['.'],
};

const FORMATS = [
  ['npm', 'package-lock.json'],
  ['pnpm9', 'pnpm-lock.yaml'],
  ['pnpm6', 'pnpm-lock.yaml'],
  ['berry', 'yarn.lock'],
  ['yarn1', 'yarn.lock'],
] as const;

for (const [dir, lockfile] of FORMATS) {
  test(`attributes packages to workspaces: ${dir}`, () => {
    const root = fileURLToPath(new URL(`./fixtures/monorepo/${dir}`, import.meta.url));
    const usage = workspaceUsage(lockfile, readFixture(`monorepo/${dir}/${lockfile}`), nodeProjectFiles(root));
    assert.deepEqual(usage.importers, ['.', 'apps/web', 'packages/ui']);
    assert.deepEqual(Object.fromEntries(usage.usedBy), EXPECTED);
    assert.deepEqual(usage.unresolvedLinks, []); // a complete lockfile reports nothing
    assert.deepEqual(usage.unresolvedRequired, []);
  });
}

test('single project: one importer, everything used by "."', () => {
  const lock = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'app', dependencies: { a: '^1.0.0' } },
      'node_modules/a': { version: '1.0.0', resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz' },
    },
  });
  const usage = workspaceUsage('package-lock.json', lock);
  assert.deepEqual(usage.importers, ['.']);
  assert.deepEqual(Object.fromEntries(usage.usedBy), { 'a@1.0.0': ['.'] });
});

test('workspace dependency cycles terminate', () => {
  const lock = [
    "lockfileVersion: '9.0'",
    'importers:',
    '  packages/a:',
    '    dependencies:',
    '      b: {specifier: workspace:*, version: link:../b}',
    '      x: {specifier: ^1.0.0, version: 1.0.0}',
    '  packages/b:',
    '    dependencies:',
    '      a: {specifier: workspace:*, version: link:../a}',
    'packages:',
    '  x@1.0.0: {resolution: {integrity: sha512-x}}',
    'snapshots:',
    '  x@1.0.0: {}',
  ].join('\n');
  const usage = workspaceUsage('pnpm-lock.yaml', lock);
  assert.deepEqual(Object.fromEntries(usage.usedBy), { 'x@1.0.0': ['packages/a', 'packages/b'] });
});

test('pnpm peer-suffixed snapshot is attributed to its plain version', () => {
  const lock = [
    "lockfileVersion: '9.0'",
    'importers:',
    '  .:',
    '    dependencies:',
    '      react-dom: {specifier: ^18.2.0, version: 18.2.0(react@18.2.0)}',
    'packages:',
    '  react-dom@18.2.0: {resolution: {integrity: sha512-x}}',
    '  react@18.2.0: {resolution: {integrity: sha512-x}}',
    'snapshots:',
    '  react-dom@18.2.0(react@18.2.0):',
    '    dependencies:',
    '      react: 18.2.0',
    '  react@18.2.0: {}',
  ].join('\n');
  assert.deepEqual(Object.fromEntries(workspaceUsage('pnpm-lock.yaml', lock).usedBy), {
    'react-dom@18.2.0': ['.'],
    'react@18.2.0': ['.'],
  });
});

test('yarn v1 without package.json files → no attribution, no crash', () => {
  const empty = mkdtempSync(join(tmpdir(), 'pg-ws-'));
  const usage = workspaceUsage('yarn.lock', readFixture('monorepo/yarn1/yarn.lock'), nodeProjectFiles(empty));
  assert.deepEqual(usage.importers, []);
  assert.equal(usage.usedBy.size, 0);
});

/** apps/web → packages/ui (workspace); ui has dependency `lib` and devDependency `storybook`. */
const DEV_CASES: [string, string, () => { content: string; root?: string }][] = [
  [
    'npm',
    'package-lock.json',
    () => ({
      content: JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'mono', workspaces: ['apps/*', 'packages/*'] },
          'apps/web': { name: 'web', dependencies: { ui: '*' } },
          'packages/ui': { name: 'ui', dependencies: { lib: '*' }, devDependencies: { storybook: '*' } },
          'node_modules/ui': { resolved: 'packages/ui', link: true },
          'node_modules/lib': { version: '1.0.0', resolved: 'https://registry.npmjs.org/lib/-/lib-1.0.0.tgz' },
          'node_modules/storybook': {
            version: '1.0.0',
            resolved: 'https://registry.npmjs.org/storybook/-/storybook-1.0.0.tgz',
            dev: true,
          },
        },
      }),
    }),
  ],
  [
    'pnpm',
    'pnpm-lock.yaml',
    () => ({
      content: [
        "lockfileVersion: '9.0'",
        'importers:',
        '  apps/web:',
        '    dependencies:',
        '      ui: {specifier: workspace:*, version: link:../../packages/ui}',
        '  packages/ui:',
        '    dependencies:',
        '      lib: {specifier: ^1.0.0, version: 1.0.0}',
        '    devDependencies:',
        '      storybook: {specifier: ^1.0.0, version: 1.0.0}',
        'packages:',
        '  lib@1.0.0: {resolution: {integrity: sha512-x}}',
        '  storybook@1.0.0: {resolution: {integrity: sha512-x}}',
        'snapshots:',
        '  lib@1.0.0: {}',
        '  storybook@1.0.0: {}',
      ].join('\n'),
    }),
  ],
  [
    'yarn v1',
    'yarn.lock',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'pg-ws-dev-'));
      const write = (path: string, json: object) => {
        mkdirSync(join(root, path, '..'), { recursive: true });
        writeFileSync(join(root, path), JSON.stringify(json));
      };
      write('package.json', { name: 'mono', private: true, workspaces: ['apps/*', 'packages/*'] });
      write('apps/web/package.json', { name: 'web', dependencies: { ui: '1.0.0' } });
      write('packages/ui/package.json', {
        name: 'ui',
        dependencies: { lib: '^1.0.0' },
        devDependencies: { storybook: '^1.0.0' },
      });
      const content = [
        'lib@^1.0.0:',
        '  version "1.0.0"',
        '  resolved "https://registry.yarnpkg.com/lib/-/lib-1.0.0.tgz#1"',
        '',
        'storybook@^1.0.0:',
        '  version "1.0.0"',
        '  resolved "https://registry.yarnpkg.com/storybook/-/storybook-1.0.0.tgz#1"',
      ].join('\n');
      return { content, root };
    },
  ],
];

for (const [label, lockfile, make] of DEV_CASES) {
  test(`${label}: a workspace's devDependencies are not attributed to workspaces that depend on it`, () => {
    const { content, root } = make();
    const usage = workspaceUsage(lockfile, content, root ? nodeProjectFiles(root) : undefined);
    assert.deepEqual(usage.usedBy.get('lib@1.0.0'), ['apps/web', 'packages/ui']);
    assert.deepEqual(usage.usedBy.get('storybook@1.0.0'), ['packages/ui']);
  });
}

test('yarn v1 workspace globs: **, negation, braces and partial wildcards', () => {
  const root = mkdtempSync(join(tmpdir(), 'pg-ws-glob-'));
  const pkg = (dir: string) => {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, 'package.json'), JSON.stringify({ name: dir.replaceAll('/', '-') }));
  };
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      workspaces: { packages: ['packages/**', '!packages/legacy', 'tools/{a,b}', 'plugins/*-plugin'] },
    }),
  );
  for (const dir of [
    'packages/ui',
    'packages/group/deep',
    'packages/legacy',
    'tools/a',
    'tools/b',
    'tools/c',
    'plugins/x-plugin',
    'plugins/other',
  ]) {
    pkg(dir);
  }
  mkdirSync(join(root, 'packages/ui/node_modules/dep'), { recursive: true });
  writeFileSync(join(root, 'packages/ui/node_modules/dep/package.json'), '{}');
  const usage = workspaceUsage('yarn.lock', '', nodeProjectFiles(root));
  assert.deepEqual(usage.importers, [
    '.',
    'packages/group/deep',
    'packages/ui',
    'plugins/x-plugin',
    'tools/a',
    'tools/b',
  ]);
});

test('large monorepo: attribution stays fast (1,000 workspaces × 5,000 packages)', () => {
  const packages: Record<string, object> = { '': { name: 'mono' } };
  for (let i = 0; i < 5000; i++) {
    const deps = Object.fromEntries([1, 2, 3, 4, 5, 6].map((d) => [`p${(i * 7 + d) % 5000}`, '*']));
    packages[`node_modules/p${i}`] = {
      version: '1.0.0',
      resolved: `https://registry.npmjs.org/p${i}/-/p${i}-1.0.0.tgz`,
      dependencies: deps,
    };
  }
  for (let w = 0; w < 1000; w++) packages[`apps/a${w}`] = { name: `a${w}`, dependencies: { [`p${w}`]: '*' } };
  const started = performance.now();
  const usage = workspaceUsage('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages }));
  const seconds = (performance.now() - started) / 1000;
  assert.equal(usage.importers.length, 1001);
  assert.ok(seconds < 15, `took ${seconds.toFixed(1)}s`);
});

const R = 'https://registry.npmjs.org';
const tgz = (name: string, version = '1.0.0') => ({ version, resolved: `${R}/${name}/-/${name}-${version}.tgz` });

test('npm: a local package outside the workspaces is followed but is not a workspace', () => {
  const lock = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'mono', workspaces: ['apps/*'] },
      'apps/web': { name: 'web', dependencies: { shared: 'file:../../shared' } },
      '../shared': { name: 'shared', version: '1.0.0', dependencies: { lib: '^1.0.0' } },
      'node_modules/shared': { resolved: '../shared', link: true },
      'node_modules/lib': tgz('lib'),
    },
  });
  const usage = workspaceUsage('package-lock.json', lock);
  assert.deepEqual(usage.importers, ['.', 'apps/web']);
  assert.deepEqual(usage.usedBy.get('lib@1.0.0'), ['apps/web']);
  assert.deepEqual(usage.unresolvedLinks, []);
});

test('npm: link target missing from the lockfile → reported, not a workspace', () => {
  const lock = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'mono', workspaces: ['apps/*'] },
      'apps/web': { name: 'web', dependencies: { gone: '*' } },
      'node_modules/gone': { resolved: '../gone', link: true },
    },
  });
  const usage = workspaceUsage('package-lock.json', lock);
  assert.deepEqual(usage.importers, ['.', 'apps/web']);
  assert.deepEqual(usage.unresolvedLinks, ['gone → ../gone']);
});

test('npm: missing required dependencies are reported; optional and peer ones are not', () => {
  const lock = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'app', dependencies: { debug: '^4.0.0' }, devDependencies: { jest: '^29.0.0' } },
      'node_modules/debug': {
        ...tgz('debug', '4.4.1'),
        dependencies: { ms: '^2.1.3' },
        optionalDependencies: { 'supports-color': '*' },
        peerDependencies: { typescript: '*' },
      },
    },
  });
  assert.deepEqual(workspaceUsage('package-lock.json', lock).unresolvedRequired, ['. → jest', 'debug → ms']);
});

test('pnpm: missing workspace link and required dependency reported; optional ignored', () => {
  const lock = [
    "lockfileVersion: '9.0'",
    'importers:',
    '  apps/web:',
    '    dependencies:',
    '      gone: {specifier: workspace:*, version: link:../../packages/gone}',
    '      debug: {specifier: ^4.0.0, version: 4.4.1}',
    '    optionalDependencies:',
    '      fsevents: {specifier: ^2.0.0, version: 2.3.3}',
    'packages:',
    '  debug@4.4.1: {resolution: {integrity: sha512-x}}',
    'snapshots:',
    '  debug@4.4.1:',
    '    dependencies:',
    '      ms: 2.1.3',
    '    optionalDependencies:',
    '      supports-color: 9.0.0',
  ].join('\n');
  const usage = workspaceUsage('pnpm-lock.yaml', lock);
  assert.deepEqual(usage.importers, ['apps/web']);
  assert.deepEqual(usage.unresolvedLinks, ['apps/web → packages/gone']);
  assert.deepEqual(usage.unresolvedRequired, ['debug@4.4.1 → ms']);
});

test('yarn berry: missing workspace and required dependency reported; dependenciesMeta optional ignored', () => {
  const lock = [
    '__metadata:',
    '  version: 8',
    '',
    '"web@workspace:apps/web":',
    '  version: 0.0.0-use.local',
    '  resolution: "web@workspace:apps/web"',
    '  dependencies:',
    '    gone: "workspace:*"',
    '    debug: "npm:^4.0.0"',
    '    fsevents: "npm:^2.0.0"',
    '  dependenciesMeta:',
    '    fsevents:',
    '      optional: true',
    '',
    '"debug@npm:^4.0.0":',
    '  version: 4.4.1',
    '  resolution: "debug@npm:4.4.1"',
    '  dependencies:',
    '    ms: "npm:^2.1.3"',
  ].join('\n');
  const usage = workspaceUsage('yarn.lock', lock);
  assert.deepEqual(usage.unresolvedLinks, ['apps/web → gone@workspace:*']);
  assert.deepEqual(usage.unresolvedRequired, ['debug@4.4.1 → ms']);
});

test('yarn v1: missing link and required dependency reported; optional ignored', () => {
  const root = mkdtempSync(join(tmpdir(), 'pg-ws-miss-'));
  mkdirSync(join(root, 'apps/web'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'] }));
  writeFileSync(
    join(root, 'apps/web/package.json'),
    JSON.stringify({
      name: 'web',
      dependencies: { gone: 'link:../../gone', debug: '^4.0.0' },
      optionalDependencies: { fsevents: '^2.0.0' },
    }),
  );
  const lock = [
    'debug@^4.0.0:',
    '  version "4.4.1"',
    '  resolved "https://registry.yarnpkg.com/debug/-/debug-4.4.1.tgz#1"',
    '  dependencies:',
    '    ms "^2.1.3"',
    '  optionalDependencies:',
    '    supports-color "^9.0.0"',
  ].join('\n');
  const usage = workspaceUsage('yarn.lock', lock, nodeProjectFiles(root));
  assert.deepEqual(usage.unresolvedLinks, ['apps/web → gone@link:../../gone']);
  assert.deepEqual(usage.unresolvedRequired, ['debug@4.4.1 → ms']);
});
