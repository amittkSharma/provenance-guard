import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLockfile } from '../src/lockfile.ts';
import { readFixture } from './helpers.ts';

for (const fixture of ['package-lock.json', 'pnpm-lock.yaml', 'yarn-v1.lock', 'yarn-berry.lock']) {
  test(`parses ${fixture}`, () => {
    const pkgs = parseLockfile(fixture.startsWith('yarn') ? 'yarn.lock' : fixture, readFixture(fixture));
    assert.deepEqual([...(pkgs.get('chalk') ?? [])].sort(), ['4.1.2', '5.3.0']);
    assert.deepEqual([...(pkgs.get('lodash') ?? [])], ['4.17.21']);
    assert.deepEqual([...(pkgs.get('string-width') ?? [])], ['4.2.3']); // npm: alias resolved to the real name
    assert.equal(pkgs.has('string-width-cjs'), false);
    assert.equal(pkgs.has('foo'), false); // git dependency skipped
    assert.equal(pkgs.has('my-workspace-pkg'), false); // workspace/link skipped
    assert.equal(pkgs.has('fixture'), false); // root project skipped
  });
}

test('accepts a path, not just a basename', () => {
  assert.equal(parseLockfile('some/dir/pnpm-lock.yaml', readFixture('pnpm-lock.yaml')).size, 3);
});

test('scoped package names keep their scope', () => {
  const lock = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      'node_modules/@scope/pkg': {
        version: '2.0.0',
        resolved: 'https://registry.npmjs.org/@scope/pkg/-/pkg-2.0.0.tgz',
      },
    },
  });
  assert.deepEqual([...(parseLockfile('package-lock.json', lock).get('@scope/pkg') ?? [])], ['2.0.0']);
});

test('package-lock v1 is rejected with a clear message', () => {
  assert.throws(
    () => parseLockfile('package-lock.json', JSON.stringify({ lockfileVersion: 1, dependencies: {} })),
    /lockfileVersion 1 is not supported/,
  );
});

test('unknown lockfile name throws', () => {
  assert.throws(() => parseLockfile('bun.lockb', ''), /unsupported lockfile/);
});

test('CRLF line endings parse the same as LF', () => {
  for (const fixture of ['yarn-v1.lock', 'yarn-berry.lock', 'pnpm-lock.yaml']) {
    const crlf = readFixture(fixture).replace(/\n/g, '\r\n');
    const pkgs = parseLockfile(fixture.startsWith('yarn') ? 'yarn.lock' : fixture, crlf);
    assert.deepEqual([...(pkgs.get('chalk') ?? [])].sort(), ['4.1.2', '5.3.0'], fixture);
  }
});

test('pnpm lockfileVersion below 6 is rejected', () => {
  assert.throws(
    () =>
      parseLockfile(
        'pnpm-lock.yaml',
        'lockfileVersion: 5.4\npackages:\n  /chalk/5.3.0:\n    resolution: {integrity: x}\n',
      ),
    /pnpm-lock\.yaml lockfileVersion 5\.4 is not supported/,
  );
});

test('yarn berry archiveUrl resolutions keep the package', () => {
  const lock =
    '__metadata:\n  version: 8\n\n"foo@npm:1.0.0::__archiveUrl=https%3A%2F%2Fexample.com%2Ffoo.tgz":\n  version: 1.0.0\n  resolution: "foo@npm:1.0.0::__archiveUrl=https%3A%2F%2Fexample.com%2Ffoo.tgz"\n';
  assert.deepEqual([...(parseLockfile('yarn.lock', lock).get('foo') ?? [])], ['1.0.0']);
});
