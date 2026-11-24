import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createFetchJson, createRegistry, type FetchJson, type History, RegistryError } from '../src/registry.ts';
import { readFixture } from './helpers.ts';

const BASE = 'https://registry.npmjs.org';

const fakeFetch: FetchJson = async (url) => {
  const path = url.slice(BASE.length + 1);
  if (path === 'sigstore') return { status: 200, body: JSON.parse(readFixture('registry/sigstore.json')) };
  if (path === 'esbuild') return { status: 200, body: JSON.parse(readFixture('registry/esbuild.json')) };
  if (path === '-/npm/v1/attestations/sigstore@5.0.1') {
    return { status: 200, body: JSON.parse(readFixture('registry/attestations/sigstore@5.0.1.json')) };
  }
  if (path === 'native-addon') {
    const v = (version: string, extra: object) => ({ version, _npmUser: { name: 'alice' }, dist: {}, ...extra });
    return {
      status: 200,
      body: {
        name: 'native-addon',
        time: { '1.0.0': '2024-01-01T00:00:00.000Z', '1.1.0': '2024-02-01T00:00:00.000Z' },
        versions: { '1.1.0': v('1.1.0', { gypfile: true }), '1.0.0': v('1.0.0', {}) },
      },
    };
  }
  if (path === '@private%2fpkg') return { status: 404 };
  if (path === 'debug-503') return { status: 503 };
  if (path === 'rate-limited') return { status: 429 };
  throw new Error(`unexpected url ${url}`);
};

const registry = createRegistry(fakeFetch, BASE);
const history = async (name: string) => (await registry.history(name)) as History;

test('trusted publisher detected', async () => {
  assert.equal((await history('sigstore')).versions.at(-1)?.trust, 'trusted-publisher');
});

test('provenance without trusted publisher detected', async () => {
  const facts = (await history('sigstore')).versions.find((v) => v.version === '3.1.0');
  assert.equal(facts?.trust, 'provenance');
  assert.equal(facts?.publisher, 'bdehamer');
});

test('source repo decoded from the SLSA attestation', async () => {
  const h = await registry.withSourceRepos('sigstore', await history('sigstore'), ['5.0.1']);
  assert.equal(h.versions.find((v) => v.version === '5.0.1')?.sourceRepo, 'https://github.com/sigstore/sigstore-js');
  assert.equal(h.versions.find((v) => v.version === '5.0.0')?.sourceRepo, undefined); // only requested versions
});

test('postinstall script detected', async () => {
  assert.ok((await history('esbuild')).versions.every((v) => v.hasInstallScript));
});

test('gypfile counts as an install script; versions sorted by publish time', async () => {
  const h = await history('native-addon');
  assert.deepEqual(
    h.versions.map((v) => [v.version, v.hasInstallScript]),
    [
      ['1.0.0', false],
      ['1.1.0', true],
    ],
  );
});

test('versions sorted by publish time ascending', async () => {
  const times = (await history('sigstore')).versions.map((v) => v.publishedAt);
  assert.deepEqual(times, [...times].sort());
});

test('404 → Unverified, not a throw', async () => {
  assert.deepEqual(await registry.history('@private/pkg'), {
    name: '@private/pkg',
    version: '*',
    reason: 'registry 404',
  });
});

test('503 → RegistryError naming the url', async () => {
  await assert.rejects(registry.history('debug-503'), (e: unknown) => {
    assert.ok(e instanceof RegistryError);
    assert.equal(e.url, `${BASE}/debug-503`);
    return true;
  });
});

test('429 → RegistryError', async () => {
  await assert.rejects(registry.history('rate-limited'), RegistryError);
});

test('each packument is fetched once per run', async () => {
  let calls = 0;
  const reg = createRegistry(async (url) => {
    calls++;
    return fakeFetch(url);
  }, BASE);
  await Promise.all([reg.history('esbuild'), reg.history('esbuild')]);
  assert.equal(calls, 1);
});

test('createFetchJson limits concurrency and sends headers', async () => {
  let active = 0;
  let peak = 0;
  let auth: string | undefined;
  const server = createServer((req, res) => {
    active++;
    peak = Math.max(peak, active);
    auth = req.headers.authorization;
    setTimeout(() => {
      active--;
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    }, 20);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`;
  try {
    const fetchJson = createFetchJson({ concurrency: 2, headers: { authorization: 'Bearer t' } });
    const results = await Promise.all(Array.from({ length: 6 }, () => fetchJson(url)));
    assert.deepEqual(results[0], { status: 200, body: { ok: true } });
    assert.equal(peak, 2);
    assert.equal(auth, 'Bearer t');
  } finally {
    server.close();
  }
});

test('createFetchJson wraps network failures in RegistryError', async () => {
  await assert.rejects(createFetchJson()('http://127.0.0.1:1/unreachable'), RegistryError);
});
