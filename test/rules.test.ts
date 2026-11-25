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
  const [finding, ...rest] = evaluate(
    C('nx', '21.5.0', '21.4.0'),
    H(v('21.4.0', 1, { trust: 'provenance' }), v('21.5.0', 2)),
  );
  assert.deepEqual(rest, []);
  assert.deepEqual(
    {
      rule: finding.rule,
      severity: finding.severity,
      name: finding.name,
      version: finding.version,
      message: finding.message,
    },
    {
      rule: 'trust-downgrade',
      severity: 'error',
      name: 'nx',
      version: '21.5.0',
      message: 'nx@21.5.0 has none; earlier releases had provenance',
    },
  );
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
  const { evidence: _, ...finding } = evaluate(C('lib', '1.0.1', '1.0.0'), history)[0];
  assert.deepEqual(finding, {
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

// ---- release lines, age and evidence ----
const NOW = new Date(Date.UTC(2026, 10, 25));
const at = (iso: string, version: string, overrides: Partial<VersionFacts> = {}): VersionFacts => ({
  version,
  publishedAt: `${iso}T00:00:00.000Z`,
  trust: 'none',
  publisher: 'alice',
  hasInstallScript: false,
  ...overrides,
});
const opts = { now: NOW, oldReleaseDays: 90 };

test('maintenance release compared with a newer line is info, with context (vite case)', () => {
  const history: History = {
    versions: [
      at('2025-01-01', '5.4.0', { trust: 'provenance', publisher: 'vitebot' }),
      at('2025-08-19', '7.1.3', { trust: 'trusted-publisher', publisher: 'GitHub Actions' }),
      at('2025-10-20', '5.4.21', {
        trust: 'provenance',
        publisher: 'vitebot',
        sourceRepo: 'https://github.com/vitejs/vite',
      }),
    ],
    maintainers: ['vitebot'],
  };
  const [finding] = evaluate(C('vite', '5.4.21', '5.4.0'), history, opts);
  assert.equal(finding.rule, 'trust-downgrade');
  assert.equal(finding.severity, 'info');
  assert.equal(
    finding.context,
    'Newer release lines use trusted-publisher; the 5.x line never had better than provenance, so this release is not weaker than its own line.',
  );
});

test('recent real drop inside the line stays an error', () => {
  const history: History = {
    versions: [at('2026-11-01', '6.13.0', { trust: 'provenance' }), at('2026-11-20', '6.14.0')],
    maintainers: ['alice'],
  };
  assert.equal(evaluate(C('lib', '6.14.0', '6.13.0'), history, opts)[0].severity, 'error');
});

test('old real drop by the maintainer who published the attested releases is info (undici-types case)', () => {
  const history: History = {
    versions: [
      at('2024-04-12', '6.13.0', { trust: 'provenance', publisher: 'matteo.collina' }),
      at('2024-07-22', '6.19.3', { publisher: 'matteo.collina' }),
      at('2024-11-13', '6.21.0', { publisher: 'matteo.collina' }),
      at('2026-01-05', '6.23.0', { trust: 'trusted-publisher', publisher: 'GitHub Actions' }),
    ],
    maintainers: ['matteo.collina', 'ethan_arrowood'],
  };
  const [finding] = evaluate(C('undici-types', '6.21.0', '6.19.3'), history, opts);
  assert.equal(finding.severity, 'info');
  assert.equal(
    finding.context,
    'Published 742 days ago by matteo.collina, a listed maintainer who also published earlier 6.x releases with provenance; later 6.x releases (6.23.0) went back to trusted-publisher.',
  );
});

test('old drop by an account that is not a listed maintainer stays an error', () => {
  const history: History = {
    versions: [
      at('2024-04-12', '6.13.0', { trust: 'provenance' }),
      at('2024-11-13', '6.21.0', { publisher: 'mallory' }),
    ],
    maintainers: ['alice', 'mallory-not'],
  };
  assert.equal(evaluate(C('lib', '6.21.0', '6.13.0'), history, opts)[0].severity, 'error');
});

test('old drop by a maintainer who never published an attested release in the line stays an error', () => {
  const history: History = {
    versions: [at('2024-04-12', '6.13.0', { trust: 'provenance' }), at('2024-11-13', '6.21.0', { publisher: 'bob' })],
    maintainers: ['alice', 'bob'],
  };
  assert.equal(evaluate(C('lib', '6.21.0', '6.13.0'), history, opts)[0].severity, 'error');
});

test('without maintainer data an old drop stays an error', () => {
  const history: History = {
    versions: [at('2024-04-12', '6.13.0', { trust: 'provenance' }), at('2024-11-13', '6.21.0')],
  };
  assert.equal(evaluate(C('lib', '6.21.0', '6.13.0'), history, opts)[0].severity, 'error');
});

test('before 1.0, each minor is its own release line', () => {
  const history: History = {
    versions: [
      at('2025-01-01', '0.3.0', { trust: 'provenance' }),
      at('2025-02-01', '0.4.0', { trust: 'trusted-publisher', publisher: 'GitHub Actions' }),
      at('2025-03-01', '0.3.9', { trust: 'provenance', sourceRepo: 'https://github.com/a/pre' }),
    ],
    maintainers: ['alice'],
  };
  const [finding] = evaluate(C('pre', '0.3.9', '0.3.0'), history, opts);
  assert.equal(finding.severity, 'info');
  assert.match(finding.context ?? '', /the 0\.3\.x line never had better than provenance/);
});

test('every finding carries its evidence', () => {
  const history: History = {
    versions: [
      at('2026-11-01', '2.0.0', { trust: 'provenance', publisher: 'alice', sourceRepo: 'https://github.com/a/lib' }),
      at('2026-11-20', '2.0.1', { publisher: 'mallory', hasInstallScript: true }),
    ],
    maintainers: ['alice'],
  };
  const findings = evaluate(C('lib', '2.0.1', '2.0.0'), history, opts);
  assert.deepEqual(
    findings.map((f) => f.rule),
    ['trust-downgrade', 'install-script-added', 'publisher-changed'],
  );
  for (const f of findings) {
    assert.deepEqual(f.evidence, {
      publishedAt: '2026-11-20T00:00:00.000Z',
      ageDays: 5,
      trust: 'none',
      publisher: 'mallory',
      publisherIsMaintainer: false,
      previousVersion: '2.0.0',
      previousPublisher: 'alice',
      line: '2.x',
      bestEarlierTrust: 'provenance',
      bestLineTrust: 'provenance',
      lastAttestedVersion: '2.0.0',
    });
  }
});

test('a new major without provenance after older lines had it stays an error (attacker publishes 99.0.0)', () => {
  const history: History = {
    versions: [
      at('2026-11-01', '1.0.0', { trust: 'provenance' }),
      at('2026-11-20', '99.0.0', { publisher: 'mallory' }),
    ],
  };
  assert.equal(evaluate(C('lib', '99.0.0', '1.0.0'), history, opts)[0].severity, 'error');
});

test('old line keeps info only when the stronger trust is from newer lines, not older ones', () => {
  const history: History = {
    versions: [
      at('2025-01-01', '4.0.0', { trust: 'trusted-publisher' }),
      at('2025-02-01', '5.0.0', { trust: 'provenance' }),
      at('2025-03-01', '5.0.1', { trust: 'provenance' }),
    ],
  };
  assert.equal(evaluate(C('lib', '5.0.1', '5.0.0'), history, opts)[0].severity, 'error');
});

test('a recent hand-published patch to an old line that predates provenance stays an error (stolen token, old line)', () => {
  const history: History = {
    versions: [
      at('2022-01-01', '2.9.0', { publisher: 'vitebot' }),
      at('2026-09-01', '7.1.3', { trust: 'trusted-publisher', publisher: 'GitHub Actions' }),
      at('2026-11-20', '2.9.99', { publisher: 'vitebot' }),
    ],
    maintainers: ['vitebot'],
  };
  assert.equal(evaluate(C('vite', '2.9.99', '2.9.0'), history, opts)[0].severity, 'error');
});

test('an old hand-published release in a line that never had provenance stays an error (no positive evidence)', () => {
  const history: History = {
    versions: [
      at('2022-01-01', '2.9.0'),
      at('2023-01-01', '3.0.0', { trust: 'provenance' }),
      at('2024-01-01', '2.9.5'),
    ],
  };
  assert.equal(evaluate(C('lib', '2.9.5', '2.9.0'), history, opts)[0].severity, 'error');
});

// ---- adversarial review: info needs positive evidence ----
test('attack: provenance release on an older line by a non-maintainer stays an error (compromised CI + stolen token)', () => {
  const history: History = {
    versions: [
      at('2025-01-01', '4.0.0', { trust: 'provenance', publisher: 'alice', sourceRepo: 'https://github.com/a/lib' }),
      at('2025-06-01', '5.0.0', { trust: 'trusted-publisher', publisher: 'GitHub Actions' }),
      at('2026-11-24', '4.9.9', { trust: 'provenance', publisher: 'mallory', sourceRepo: 'https://github.com/a/lib' }),
    ],
    maintainers: ['alice'],
  };
  assert.deepEqual(
    evaluate(C('lib', '4.9.9', '4.0.0'), history, opts).map((f) => [f.rule, f.severity]),
    [['trust-downgrade', 'error']],
  );
});

test('attack: old hand-published release on an old line by an unknown account stays an error', () => {
  const history: History = {
    versions: [
      at('2023-01-01', '4.0.0', { publisher: 'alice' }),
      at('2024-01-01', '5.0.0', { trust: 'provenance', publisher: 'alice' }),
      at('2025-01-01', '4.9.9', { publisher: 'mallory' }),
    ],
    maintainers: ['alice'],
  };
  assert.equal(evaluate(C('lib', '4.9.9', '4.0.0'), history, opts)[0].severity, 'error');
});

test('attack: stolen maintainer token, old release, line never went back to provenance → error', () => {
  const history: History = {
    versions: [at('2025-01-01', '5.0.0', { trust: 'provenance' }), at('2025-08-01', '5.0.1')],
    maintainers: ['alice'],
  };
  assert.equal(evaluate(C('lib', '5.0.1', '5.0.0'), history, opts)[0].severity, 'error');
});

test('a provenance release whose attestation could not be read is not rated info', () => {
  const history: History = {
    versions: [
      at('2025-01-01', '5.4.0', { trust: 'provenance', publisher: 'vitebot' }),
      at('2025-08-19', '7.1.3', { trust: 'trusted-publisher', publisher: 'GitHub Actions' }),
      at('2025-10-20', '5.4.21', { trust: 'provenance', publisher: 'vitebot' }), // no sourceRepo: unreadable
    ],
    maintainers: ['vitebot'],
  };
  assert.equal(evaluate(C('vite', '5.4.21', '5.4.0'), history, opts)[0].severity, 'error');
});

test('a release published after the reference time (clock skew) has age 0, not a negative age', () => {
  const history: History = {
    versions: [at('2026-11-01', '1.0.0', { trust: 'provenance' }), at('2026-11-26', '1.0.1')],
  };
  assert.equal(evaluate(C('lib', '1.0.1', '1.0.0'), history, opts)[0].evidence?.ageDays, 0);
});
