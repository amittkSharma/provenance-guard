# provenance-guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A CLI that reviews lockfile changes and fails CI when a dependency version is *less trustworthy than the versions before it*: provenance lost, built from a different repo, new publisher, or a new install script.

**Architecture:** Parse lockfile at base ref and HEAD → list added/upgraded `name@version` → fetch npm packument + attestations per version → run 4 comparison rules against that package's own history → print text / JSON / Markdown, exit non-zero on errors. Pure functions for parse/diff/rules; one module touches the network, injected for tests.

**Tech Stack:** Node ≥ 20, TypeScript (ESM), `node:test`, global `fetch`, `yaml` (only runtime dependency).

**Spec:** [design-discussion.md](design-discussion.md) (problem, gap, features).

---
# Part 2 — Implementation

## Global Constraints

- Node `>=20`; ESM only; TypeScript `strict`.
- Runtime dependencies: `yaml` only. Use global `fetch`, `node:child_process`, and `node:test`.
- Registry base URL: `process.env.npm_config_registry ?? "https://registry.npmjs.org"`, with trailing slash stripped.
- Trust order: `none` (0) < `provenance` (1) < `trusted-publisher` (2).
- Exit codes: `0` no error findings, `1` at least one error finding, `2` tool failure (bad args, unreadable lockfile, registry 5xx or network error).
- Never pass silently: if a package can't be checked, report it in an `unverified` list in every output format.
- At most 8 concurrent registry requests.

## Review Focus

1. **Registry unreachable or 5xx/429.** Expect exit 2 with the failing URL. Never exit 0. → test in Task 3.
2. **Private or scoped package not on the public registry (404/401).** Expect the package listed under `unverified`, no crash, and exit code determined by the other findings. → test in Task 3.
3. **Lockfile missing at the base ref** (new project or a renamed lockfile). Expect every package treated as added. → test in Task 2.
4. **Packages that predate provenance** (no release ever had it). Expect no `trust-downgrade` finding. → test in Task 4.
5. **Non-registry entries** (`git+`, `file:`, `link:`, `workspace:`, `npm:` aliases). Skip git, file, link and workspace entries; resolve aliases to their real name. → test in Task 1.

## File Structure

```
provenance-guard/
  package.json  tsconfig.json  README.md  .gitignore
  src/
    types.ts       shared types (Task 1)
    lockfile.ts    parse any lockfile → Map<name, Set<version>> (Task 1)
    diff.ts        base vs head → Change[] (Task 2)
    registry.ts    packument + attestation → VersionFacts (Task 3)
    rules.ts       Change + history → Finding[] (Task 4)
    report.ts      text/json/markdown (Task 5)
    cli.ts         args, config, exit codes (Task 5)
  test/
    fixtures/      lockfiles + recorded packuments/attestations
    *.test.ts
```

---

### Task 1: Scaffold + lockfile parsing (≈ 2 h)

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `src/types.ts`, `src/lockfile.ts`
- Test: `test/lockfile.test.ts`, `test/fixtures/{package-lock.json,pnpm-lock.yaml,yarn-v1.lock,yarn-berry.lock}`

**Interfaces:**
- Produces (`src/types.ts`):
  ```ts
  export type Trust = 'none' | 'provenance' | 'trusted-publisher';
  export type RuleId = 'trust-downgrade' | 'source-repo-changed' | 'install-script-added' | 'publisher-changed';
  export type Packages = Map<string, Set<string>>;           // name → versions
  export interface Change { name: string; from?: string; to: string }
  export interface VersionFacts {
    version: string; publishedAt: string; trust: Trust;
    sourceRepo?: string; publisher?: string; hasInstallScript: boolean;
  }
  export interface Finding { rule: RuleId; severity: 'error' | 'warn'; name: string; version: string; message: string }
  export interface Unverified { name: string; version: string; reason: string }
  ```
- Produces (`src/lockfile.ts`): `parseLockfile(filename: string, content: string): Packages`. The format is chosen by basename: `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`. Yarn v1 and Berry are told apart by the `__metadata:` key.

- [ ] **Step 1: Scaffold.** `git init`. Set `package.json` with `"type": "module"`, `"bin": {"provenance-guard": "dist/cli.js"}`, `"engines": {"node": ">=20"}`, `"files": ["dist"]`, dependency `yaml`, devDependencies `typescript` and `@types/node`. Scripts: `build` = `tsc`, `test` = `node --test --experimental-strip-types test/*.test.ts`. Use `tsconfig` with `strict`, `module`/`moduleResolution` `NodeNext`, `outDir dist`.

- [ ] **Step 2: Write fixtures + failing tests.** Each fixture contains `lodash@4.17.21`, `chalk@5.3.0` and `chalk@4.1.2` (two versions), an alias `string-width-cjs` → `npm:string-width@4.2.3`, a git dep `foo` from `git+https://…`, and a `workspace:`/`link:` entry.

  ```ts
  for (const f of ['package-lock.json', 'pnpm-lock.yaml', 'yarn-v1.lock', 'yarn-berry.lock']) {
    test(`parses ${f}`, () => {
      const pkgs = parseLockfile(f.startsWith('yarn') ? 'yarn.lock' : f, readFixture(f));
      assert.deepEqual([...pkgs.get('chalk')!].sort(), ['4.1.2', '5.3.0']);
      assert.deepEqual([...pkgs.get('lodash')!], ['4.17.21']);
      assert.deepEqual([...pkgs.get('string-width')!], ['4.2.3']);   // alias resolved
      assert.equal(pkgs.has('string-width-cjs'), false);
      assert.equal(pkgs.has('foo'), false);                           // git dep skipped
      assert.equal(pkgs.has('my-workspace-pkg'), false);              // workspace/link skipped
    });
  }
  test('unknown lockfile name throws', () => assert.throws(() => parseLockfile('bun.lockb', ''), /unsupported lockfile/));
  ```

- [ ] **Step 3: Run tests.** `npm test` → expect FAIL (`parseLockfile` not defined).
- [ ] **Step 4: Implement `parseLockfile`.**
  - **npm:** walk `packages`. Name is the part of the key after the last `node_modules/`; aliases use the `name` field. Skip `""`, `link: true`, and entries whose `resolved` isn't a registry tarball.
  - **pnpm v9:** keys of `packages` (`name@version`, split on the last `@` after index 0). Skip keys whose version part contains `(` (peer-suffix duplicates) after stripping the suffix, and skip `file:`/`link:`.
  - **Yarn Berry:** `resolution: "name@npm:version"` → keep `npm:` only.
  - **Yarn v1:** line-based. Each header line takes its name from the first descriptor; on `npm:` aliases, take the real name from the descriptor; `version "x"` follows the header. Skip entries whose `resolved` isn't an `https://` registry URL.
- [ ] **Step 5: Run tests.** `npm test` → expect PASS.
- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat: parse npm, pnpm and yarn lockfiles"`

---

### Task 2: Lockfile diff against a git ref (≈ 1 h)

**Files:**
- Create: `src/diff.ts`
- Test: `test/diff.test.ts`

**Interfaces:**
- Consumes: `parseLockfile`, `Packages`, `Change` (Task 1).
- Produces:
  - `diffPackages(base: Packages, head: Packages): Change[]`, sorted by `name`, then `to`.
  - `readAtRef(ref: string, path: string): string | undefined`. Calls `git show <ref>:<path>` through `execFileSync`; returns `undefined` when the path doesn't exist at that ref, and throws on any other git error (e.g. an unknown ref).

- [ ] **Step 1: Write failing tests.**
  ```ts
  const P = (o: Record<string, string[]>): Packages => new Map(Object.entries(o).map(([k, v]) => [k, new Set(v)]));
  test('upgrade gets from = highest base version', () =>
    assert.deepEqual(diffPackages(P({ debug: ['4.3.4', '2.6.9'] }), P({ debug: ['4.4.2', '2.6.9'] })),
      [{ name: 'debug', from: '4.3.4', to: '4.4.2' }]));
  test('new package has no from', () =>
    assert.deepEqual(diffPackages(P({}), P({ nx: ['21.5.0'] })), [{ name: 'nx', to: '21.5.0' }]));
  test('unchanged and removed packages are ignored', () =>
    assert.deepEqual(diffPackages(P({ a: ['1.0.0'], b: ['1.0.0'] }), P({ a: ['1.0.0'] })), []));
  test('missing base lockfile → everything is added', () =>
    assert.equal(diffPackages(new Map(), P({ a: ['1.0.0'], b: ['2.0.0'] })).length, 2));   // Review Focus 3
  test('readAtRef returns undefined for path absent at ref', () =>
    assert.equal(readAtRef('HEAD', 'does-not-exist.lock'), undefined));
  ```
- [ ] **Step 2: Run tests.** `npm test` → expect FAIL.
- [ ] **Step 3: Implement both functions.** For each head version not in the base set, `from` = the highest base version of the same name by semver order (write a 10-line numeric compare; don't add `semver`). Leave `from` unset if the name isn't in the base. `readAtRef` detects a missing path through git's stderr: `exists on disk, but not in` / `does not exist in`.
- [ ] **Step 4: Run tests.** `npm test` → expect PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat: diff lockfiles against a git ref"`

---

### Task 3: Registry facts (≈ 3 h)

**Files:**
- Create: `src/registry.ts`
- Test: `test/registry.test.ts`, `test/fixtures/registry/*.json`. Record real responses once with `curl` (`debug`, `sigstore`, `nx` packuments trimmed to about 6 versions, plus one attestations response) and commit them.

**Interfaces:**
- Consumes: `VersionFacts`, `Trust`, `Unverified` (Task 1).
- Produces:
  ```ts
  export type FetchJson = (url: string) => Promise<{ status: number; body?: unknown }>;
  export interface History { versions: VersionFacts[] }   // sorted by publishedAt ascending
  export function createRegistry(fetchJson: FetchJson, base: string): {
    history(name: string): Promise<History | Unverified>;   // Unverified on 404/401/403; sourceRepo left unset
    withSourceRepos(name: string, history: History, versions: string[]): Promise<History>;   // fills sourceRepo for those versions
    // both throw RegistryError on 5xx, 429 and network failure
  };
  export class RegistryError extends Error { url: string }
  export const defaultFetchJson: FetchJson;   // wraps global fetch with an 8-request concurrency limit
  ```

Facts per version, from the full packument `GET {base}/{name}` (scoped names encoded as `@scope%2fname`):
- `publishedAt` = `time[version]`
- `trust`: `'trusted-publisher'` if `_npmUser.trustedPublisher` is present; else `'provenance'` if `dist.attestations.provenance` is present; else `'none'`
- `publisher` = `_npmUser.name`
- `hasInstallScript` = any of `scripts.preinstall`, `scripts.install`, `scripts.postinstall`, or `gypfile === true`
- `sourceRepo`, only when `trust !== 'none'`: `GET dist.attestations.url`. Take the attestation whose `predicateType === 'https://slsa.dev/provenance/v1'`, base64-decode `bundle.dsseEnvelope.payload`, read `predicate.buildDefinition.externalParameters.workflow.repository`, and lowercase it.

Fetching attestations for every version is too expensive. The CLI flow per change is: `history(name)` → `repoVersionsNeeded(change, history)` (Task 4) → `withSourceRepos(name, history, thoseVersions)` → `evaluate`. Versions with `trust === 'none'` are skipped inside `withSourceRepos`.

- [ ] **Step 1: Write failing tests** using a fake `FetchJson` that serves fixtures by URL.
  ```ts
  test('trusted publisher detected', async () => {
    const h = await reg.history('sigstore') as History;
    assert.equal(h.versions.at(-1)!.trust, 'trusted-publisher');
  });
  test('source repo decoded from SLSA attestation', async () => {
    const h = await reg.withSourceRepos('sigstore', await reg.history('sigstore') as History, ['5.0.1']);
    assert.equal(h.versions.find(v => v.version === '5.0.1')!.sourceRepo, 'https://github.com/sigstore/sigstore-js');
  });
  test('install script detected', async () => { /* fixture version with scripts.postinstall → hasInstallScript true */ });
  test('versions sorted by publish time', async () => { /* assert ascending publishedAt */ });
  test('404 → Unverified, not throw', async () =>            // Review Focus 2
    assert.deepEqual(await reg.history('@private/pkg'), { name: '@private/pkg', version: '*', reason: 'registry 404' }));
  test('503 → RegistryError with url', async () =>           // Review Focus 1
    await assert.rejects(reg.history('debug-503'), (e: RegistryError) => e.url.endsWith('/debug-503')));
  ```
- [ ] **Step 2: Run tests.** `npm test` → expect FAIL.
- [ ] **Step 3: Implement `createRegistry`, `defaultFetchJson` and `RegistryError`.** Cache packuments per run in a `Map<string, Promise<…>>` so the same name is fetched once. Wrap failures of `defaultFetchJson` in `RegistryError`.
- [ ] **Step 4: Run tests.** `npm test` → expect PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat: read trust facts from the npm registry"`

---

### Task 4: Rules (≈ 2 h)

**Files:**
- Create: `src/rules.ts`
- Test: `test/rules.test.ts`

**Interfaces:**
- Consumes: `Change`, `VersionFacts`, `Finding`, `History` (Tasks 1 and 3).
- Produces:
  - `repoVersionsNeeded(change: Change, history: History): string[]` → `[change.to, previousAttested?.version]`, i.e. which versions Task 3 must fetch attestations for.
  - `evaluate(change: Change, history: History): Finding[]`

Definitions (`target` = facts for `change.to`; `earlier` = versions with `publishedAt < target.publishedAt`; `previous` = facts for `change.from` if it is in history, else the last of `earlier`; `previousAttested` = last of `earlier` with `trust !== 'none'`):

| Rule | Fires when | Severity | Message (exact) |
|---|---|---|---|
| `trust-downgrade` | `rank(target.trust) < max(rank(e.trust) for e in earlier)` | error | ``${name}@${to} has ${target.trust}; earlier releases had ${best}`` |
| `source-repo-changed` | `target.sourceRepo && previousAttested?.sourceRepo && they differ` | error | ``${name}@${to} built from ${target.sourceRepo}; previously ${prev}`` |
| `install-script-added` | `target.hasInstallScript && !previous?.hasInstallScript` | warn | ``${name}@${to} adds an install script`` |
| `publisher-changed` | `target.trust === 'none' && previous?.publisher && target.publisher !== previous.publisher` | warn | ``${name}@${to} published by ${target.publisher}; previously ${previous.publisher}`` |

If `change.to` isn't in history (unpublished version), return `[]`. The CLI records it as `Unverified` with reason `version not in registry`.

- [ ] **Step 1: Write failing tests.** Build histories inline with a helper `v(version, publishedAt, overrides)`.
  ```ts
  test('provenance → none is a downgrade (Nx case)', () => {
    const f = evaluate({ name: 'nx', from: '21.4.0', to: '21.5.0' }, H(v('21.4.0', 1, { trust: 'provenance' }), v('21.5.0', 2, { trust: 'none' })));
    assert.deepEqual(f.map(x => [x.rule, x.severity]), [['trust-downgrade', 'error']]);
  });
  test('never had provenance → no downgrade', () =>                    // Review Focus 4
    assert.deepEqual(evaluate(C('old', '1.0.1'), H(v('1.0.0', 1), v('1.0.1', 2))), []));
  test('trusted-publisher → provenance is a downgrade', () => { /* … */ });
  test('downgrade compares against ALL earlier releases, not only `from`', () => {
    // 1.0.0 trusted, 1.1.0 none (already bad, user was on it), 1.2.0 none → still fires for 1.2.0
  });
  test('source repo change fires; same repo with different casing does not', () => { /* … */ });
  test('install script added fires; already present in previous does not', () => { /* … */ });
  test('new package with install script fires (no previous)', () => { /* … */ });
  test('publisher change ignored when target uses a trusted publisher', () => { /* … */ });
  test('repoVersionsNeeded returns target and previous attested version', () => {
    assert.deepEqual(repoVersionsNeeded(C('x', '2.0.0'), H(v('1.0.0', 1, { trust: 'provenance' }), v('1.5.0', 2), v('2.0.0', 3, { trust: 'provenance' }))), ['2.0.0', '1.0.0']);
  });
  ```
- [ ] **Step 2: Run tests.** `npm test` → expect FAIL.
- [ ] **Step 3: Implement `evaluate` and `repoVersionsNeeded`** per the table.
- [ ] **Step 4: Run tests.** `npm test` → expect PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat: trust comparison rules"`

---

### Task 5: CLI, allowlist, reports, README (≈ 3 h)

**Files:**
- Create: `src/report.ts`, `src/cli.ts`, `README.md`
- Test: `test/report.test.ts`, `test/cli.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `run(argv: string[], deps: { fetchJson: FetchJson; cwd: string }): Promise<{ exitCode: 0 | 1 | 2; stdout: string; stderr: string }>`. `cli.ts` calls it with `process.argv.slice(2)` and `defaultFetchJson`, writes the output, and sets `process.exitCode`. The file starts with `#!/usr/bin/env node`.
  - `render(format: 'text' | 'json' | 'markdown', r: { findings: Finding[]; unverified: Unverified[]; checked: number }): string`

CLI surface:
```
provenance-guard diff [--base origin/main] [--lockfile <path>] [--format text|json|markdown] [--config .provenance-guard.json]
provenance-guard scan [--lockfile <path>] [--format …] [--config …]
```
- `--lockfile` default: the first of `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock` that exists in `cwd`; none found → exit 2.
- `scan` treats every package as `{ name, to }` with no `from`.
- Allowlist: drop findings where `name` and `rule` match an `allow` entry. An entry without `reason` → exit 2 (`allowlist entry for <name> needs a reason`).
- JSON shape: `{ checked, findings, unverified }`. Markdown: a `### provenance-guard` heading, a table `| Severity | Package | Rule | Detail |`, then a collapsed `<details>` list of unverified packages. Empty → `✅ N packages checked, no trust regressions`.
- Exit codes are listed under Global Constraints.

- [ ] **Step 1: Write failing tests** (temporary git repo per test via `mkdtemp` + `git init`; fake `fetchJson` serving the Task 3 fixtures).
  ```ts
  test('diff: downgrade → exit 1, finding in JSON', async () => {
    // base commit lockfile has nx 21.4.0, head has 21.5.0 (fixture with no provenance)
    const r = await run(['diff', '--base', 'HEAD~1', '--format', 'json'], deps);
    assert.equal(r.exitCode, 1);
    assert.equal(JSON.parse(r.stdout).findings[0].rule, 'trust-downgrade');
  });
  test('allowlisted finding → exit 0', async () => { /* … */ });
  test('allowlist entry without reason → exit 2', async () => { /* … */ });
  test('registry 503 → exit 2, stderr names the URL', async () => { /* … */ });   // Review Focus 1
  test('private 404 package → exit 0, listed in unverified', async () => { /* … */ }); // Review Focus 2
  test('no lockfile → exit 2', async () => { /* … */ });
  test('markdown empty result', () =>
    assert.match(render('markdown', { findings: [], unverified: [], checked: 3 }), /✅ 3 packages checked, no trust regressions/));
  ```
- [ ] **Step 2: Run tests.** `npm test` → expect FAIL.
- [ ] **Step 3: Implement `render`, `run` and `cli.ts`.** Parse arguments with `node:util` `parseArgs` (no dependency).
- [ ] **Step 4: Run tests.** `npm test` → expect PASS.
- [ ] **Step 5: Smoke test against the real registry.** `npm run build && node dist/cli.js scan --lockfile test/fixtures/package-lock.json` → expect exit 0 and `N packages checked`.
- [ ] **Step 6: Write the README.** Include the problem (the incident table from Part 1), install, both commands, this GitHub Actions snippet, the allowlist format, and a "Turn on your package manager's release-age gate too" section with the npm, pnpm and Yarn setting names.
  ```yaml
  - run: npx provenance-guard diff --base origin/${{ github.base_ref }} --format markdown >> "$GITHUB_STEP_SUMMARY"
  ```
- [ ] **Step 7: Commit.** `git add -A && git commit -m "feat: CLI, allowlist and reports"`

---

## Release checklist (not a task — do it once at publish time)
- Publish only from GitHub Actions with npm **trusted publishing**; no `NPM_TOKEN`. A tool that checks provenance must have provenance itself.
- No `postinstall` script.
