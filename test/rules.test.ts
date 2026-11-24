import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { History } from '../src/registry.ts';
import { evaluate, repoVersionsNeeded } from '../src/rules.ts';
import type { Change, VersionFacts } from '../src/types.ts';

const v = (version: string, day: number, overrides: Partial<VersionFacts> = {}): VersionFacts => ({
  version,
  publishedAt: new Date(Date.UTC(2025, 0, day)).toISOString(),
  trust: 'none',
  publisher: 'alice',
  hasInstallScript: false,
  ...overrides,
});
const H = (...versions: VersionFacts[]): History => ({ versions });
const C = (name: string, to: string, from?: string): Change => (from ? { name, from, to } : { name, to });
const rules = (change: Change, history: History) => evaluate(change, history).map((f) => [f.rule, f.severity]);

test('provenance → none is a downgrade (Nx case)', () => {
  const findings = evaluate(C('nx', '21.5.0', '21.4.0'), H(v('21.4.0', 1, { trust: 'provenance' }), v('21.5.0', 2)));
  assert.deepEqual(findings, [
    {
      rule: 'trust-downgrade',
      severity: 'error',
      name: 'nx',
      version: '21.5.0',
      message: 'nx@21.5.0 has none; earlier releases had provenance',
    },
  ]);
});

test('never had provenance → no downgrade', () => {
  assert.deepEqual(rules(C('old', '1.0.1'), H(v('1.0.0', 1), v('1.0.1', 2))), []);
});

test('trusted-publisher → provenance is a downgrade', () => {
  assert.deepEqual(
    rules(C('x', '2.0.0'), H(v('1.0.0', 1, { trust: 'trusted-publisher' }), v('2.0.0', 2, { trust: 'provenance' }))),
    [['trust-downgrade', 'error']],
  );
});

test('downgrade compares against ALL earlier releases, not only from', () => {
  const history = H(v('1.0.0', 1, { trust: 'trusted-publisher' }), v('1.1.0', 2), v('1.2.0', 3));
  assert.deepEqual(rules(C('x', '1.2.0', '1.1.0'), history), [['trust-downgrade', 'error']]);
});

test('releases published after the target do not count', () => {
  const history = H(v('1.0.0', 1), v('1.0.1', 2), v('2.0.0', 3, { trust: 'trusted-publisher' }));
  assert.deepEqual(rules(C('x', '1.0.1', '1.0.0'), history), []);
});

test('source repo change fires', () => {
  const history = H(
    v('1.0.0', 1, { trust: 'provenance', sourceRepo: 'https://github.com/acme/lib' }),
    v('1.0.1', 2, { trust: 'provenance', sourceRepo: 'https://github.com/evil/lib' }),
  );
  assert.deepEqual(evaluate(C('lib', '1.0.1', '1.0.0'), history)[0], {
    rule: 'source-repo-changed',
    severity: 'error',
    name: 'lib',
    version: '1.0.1',
    message: 'lib@1.0.1 built from https://github.com/evil/lib; previously https://github.com/acme/lib',
  });
});

test('same source repo with different casing does not fire', () => {
  const history = H(
    v('1.0.0', 1, { trust: 'provenance', sourceRepo: 'https://github.com/Acme/Lib' }),
    v('1.0.1', 2, { trust: 'provenance', sourceRepo: 'https://github.com/acme/lib' }),
  );
  assert.deepEqual(rules(C('lib', '1.0.1', '1.0.0'), history), []);
});

test('install script added fires', () => {
  const findings = evaluate(C('w', '1.0.1', '1.0.0'), H(v('1.0.0', 1), v('1.0.1', 2, { hasInstallScript: true })));
  assert.deepEqual(
    findings.map((f) => [f.rule, f.severity, f.message]),
    [['install-script-added', 'warn', 'w@1.0.1 adds an install script']],
  );
});

test('install script already present in previous release does not fire', () => {
  const history = H(v('1.0.0', 1, { hasInstallScript: true }), v('1.0.1', 2, { hasInstallScript: true }));
  assert.deepEqual(rules(C('esbuild', '1.0.1', '1.0.0'), history), []);
});

test('new package (first release) with install script fires', () => {
  assert.deepEqual(rules(C('fresh', '1.0.0'), H(v('1.0.0', 1, { hasInstallScript: true }))), [
    ['install-script-added', 'warn'],
  ]);
});

test('publisher change fires when there is no trusted publisher', () => {
  const findings = evaluate(C('debug', '4.4.2', '4.4.1'), H(v('4.4.1', 1), v('4.4.2', 2, { publisher: 'mallory' })));
  assert.deepEqual(
    findings.map((f) => [f.rule, f.severity, f.message]),
    [['publisher-changed', 'warn', 'debug@4.4.2 published by mallory; previously alice']],
  );
});

test('publisher change ignored when target uses a trusted publisher', () => {
  const history = H(v('1.0.0', 1), v('1.0.1', 2, { trust: 'trusted-publisher', publisher: 'GitHub Actions' }));
  assert.deepEqual(rules(C('x', '1.0.1', '1.0.0'), history), []);
});

test('previous = from when from is in history, even if a later release exists', () => {
  // 1.0.0 (alice) → 1.2.0 (bob); 1.1.0 by bob in between. Compared against from=1.0.0 → publisher changed.
  const history = H(v('1.0.0', 1), v('1.1.0', 2, { publisher: 'bob' }), v('1.2.0', 3, { publisher: 'bob' }));
  assert.deepEqual(rules(C('x', '1.2.0', '1.0.0'), history), [['publisher-changed', 'warn']]);
});

test('target version missing from history → no findings', () => {
  assert.deepEqual(rules(C('x', '9.9.9'), H(v('1.0.0', 1))), []);
});

test('repoVersionsNeeded returns target and previous attested version', () => {
  const history = H(v('1.0.0', 1, { trust: 'provenance' }), v('1.5.0', 2), v('2.0.0', 3, { trust: 'provenance' }));
  assert.deepEqual(repoVersionsNeeded(C('x', '2.0.0'), history), ['2.0.0', '1.0.0']);
});

test('repoVersionsNeeded skips target without provenance and missing previous', () => {
  assert.deepEqual(repoVersionsNeeded(C('x', '1.0.0'), H(v('1.0.0', 1))), []);
});
