import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, diffPackages, readAtRef } from '../src/diff.ts';
import type { Packages } from '../src/types.ts';

const P = (o: Record<string, string[]>): Packages => new Map(Object.entries(o).map(([k, v]) => [k, new Set(v)]));

test('upgrade gets from = highest base version', () => {
  assert.deepEqual(diffPackages(P({ debug: ['4.3.4', '2.6.9'] }), P({ debug: ['4.4.2', '2.6.9'] })), [
    { name: 'debug', from: '4.3.4', to: '4.4.2' },
  ]);
});

test('new package has no from', () => {
  assert.deepEqual(diffPackages(P({}), P({ nx: ['21.5.0'] })), [{ name: 'nx', to: '21.5.0' }]);
});

test('unchanged and removed packages are ignored', () => {
  assert.deepEqual(diffPackages(P({ a: ['1.0.0'], b: ['1.0.0'] }), P({ a: ['1.0.0'] })), []);
});

test('missing base lockfile → everything is added', () => {
  assert.equal(diffPackages(new Map(), P({ a: ['1.0.0'], b: ['2.0.0'] })).length, 2);
});

test('changes are sorted by name, then version', () => {
  const changes = diffPackages(new Map(), P({ zod: ['3.0.0'], chalk: ['5.3.0', '4.1.2'] }));
  assert.deepEqual(
    changes.map((c) => `${c.name}@${c.to}`),
    ['chalk@4.1.2', 'chalk@5.3.0', 'zod@3.0.0'],
  );
});

test('compareVersions orders numerically and puts prereleases first', () => {
  assert.deepEqual(['1.10.0', '1.9.0', '1.10.0-beta.1', '1.2.3'].sort(compareVersions), [
    '1.2.3',
    '1.9.0',
    '1.10.0-beta.1',
    '1.10.0',
  ]);
});

test('readAtRef returns undefined for a path absent at the ref', () => {
  assert.equal(readAtRef('HEAD', 'does-not-exist.lock'), undefined);
});

test('readAtRef returns file content at the ref', () => {
  assert.match(readAtRef('HEAD', 'package.json') ?? '', /"name": "@amittksharma\/provenance-guard"/);
});

test('readAtRef throws on an unknown ref', () => {
  assert.throws(() => readAtRef('no-such-ref-xyz', 'package.json'), /no-such-ref-xyz/);
});

test('readAtRef resolves the path relative to cwd, not the repo root', () => {
  const testDir = new URL('.', import.meta.url).pathname;
  assert.match(readAtRef('HEAD', 'helpers.ts', testDir) ?? '', /readFixture/);
});
