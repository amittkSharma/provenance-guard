import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { discoverLockfiles } from '../src/discover.ts';

function tree(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'pg-disc-'));
  for (const file of files) {
    mkdirSync(join(dir, dirname(file)), { recursive: true });
    writeFileSync(join(dir, file), file.endsWith('.gitignore') ? 'ignored-build/\n/package-lock.json\n' : '{}');
  }
  return dir;
}

const FILES = [
  'package-lock.json',
  'apps/legacy/package-lock.json',
  'apps/my app/package-lock.json',
  'packages/old/yarn.lock',
  'tools/x/pnpm-lock.yaml',
  '.github/actions/setup/package-lock.json',
  'ignored-build/package-lock.json',
  'test/fixtures/package-lock.json',
  'node_modules/dep/package-lock.json',
  'apps/legacy/node_modules/dep/yarn.lock',
  '.gitignore',
];

const EXPECTED = [
  'package-lock.json',
  '.github/actions/setup/package-lock.json',
  'apps/legacy/package-lock.json',
  'apps/my app/package-lock.json',
  'ignored-build/package-lock.json',
  'packages/old/yarn.lock',
  'test/fixtures/package-lock.json',
  'tools/x/pnpm-lock.yaml',
];

test('finds every lockfile except in node_modules — including git-ignored, dot folders and spaces', () => {
  const dir = tree(FILES);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  assert.deepEqual(discoverLockfiles(dir), { lockfiles: EXPECTED, unreadable: [] });
});

test('same result outside a git repo', () => {
  assert.deepEqual(discoverLockfiles(tree(FILES)).lockfiles, EXPECTED);
});

test('nested git repos and submodule checkouts are searched; .git folders are not', () => {
  const dir = tree(['package-lock.json', 'libs/sub/package-lock.json', 'libs/sub/.git/package-lock.json']);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['init', '-q'], { cwd: join(dir, 'libs/sub') });
  assert.deepEqual(discoverLockfiles(dir).lockfiles, ['package-lock.json', 'libs/sub/package-lock.json']);
});

test('exclude drops lockfiles under the given paths', () => {
  const dir = tree(FILES);
  assert.deepEqual(discoverLockfiles(dir, ['test/fixtures', 'tools/', 'ignored-build', '.github']).lockfiles, [
    'package-lock.json',
    'apps/legacy/package-lock.json',
    'apps/my app/package-lock.json',
    'packages/old/yarn.lock',
  ]);
});

test('exclude matches whole path segments, not string prefixes', () => {
  const dir = tree(['package-lock.json', 'apps/web/package-lock.json', 'apps/web2/package-lock.json']);
  assert.deepEqual(discoverLockfiles(dir, ['apps/web']).lockfiles, [
    'package-lock.json',
    'apps/web2/package-lock.json',
  ]);
});

test('an unreadable folder is reported, not fatal', { skip: process.getuid?.() === 0 }, () => {
  const dir = tree(['package-lock.json', 'secret/package-lock.json']);
  chmodSync(join(dir, 'secret'), 0o000);
  try {
    assert.deepEqual(discoverLockfiles(dir), { lockfiles: ['package-lock.json'], unreadable: ['secret'] });
  } finally {
    chmodSync(join(dir, 'secret'), 0o755);
  }
});
