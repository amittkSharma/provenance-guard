# provenance-guard — architecture, usage and solution structure

## 1. Architecture

provenance-guard is a pipeline of five stages. Every stage except the registry client is a pure function, so it can be tested without a network or a git repo.

```
            ┌──────────────┐   Packages    ┌──────────┐   Change[]
lockfile ──►│  lockfile.ts │──────────────►│ diff.ts  │──────────────┐
(+ git ref) │  parse       │  (base, head) │ compare  │              │
            └──────────────┘               └──────────┘              ▼
                                                            ┌────────────────┐
                                    npm registry ◄─────────►│  registry.ts   │
                                    packument + attestation │  History       │
                                                            └───────┬────────┘
                                                                    │ VersionFacts[]
                                                                    ▼
            ┌──────────────┐   CheckResult  ┌──────────┐  Finding[] ┌──────────┐
 stdout ◄───│  report.ts   │◄───────────────│ index.ts │◄───────────│ rules.ts │
 exit code  │  text/json/md│                │ check()  │            │ evaluate │
            └──────────────┘                └──────────┘            └──────────┘
                                       severity overrides,
                                       allowlist, sorting
```

### Data flow for one `diff` run

1. **Find the lockfile:** the `lockfile` option, or the first of `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock` in `cwd`.
2. **Parse head and base:** `parseLockfile()` reads the working-tree file and `git show <base>:./<lockfile>`. Each becomes `Map<name, Set<version>>`. Git, file, link and workspace entries are skipped, and `npm:` aliases resolve to the real package name. If the base ref has no lockfile, every package counts as new.
3. **Diff:** `diffPackages()` returns `{ name, from?, to }` for every version in head that isn't in base.
4. **Fetch history:** one full packument per package name, fetched once and cached. Each version becomes `VersionFacts`:
   - `trust`: `trusted-publisher` if `_npmUser.trustedPublisher` is set, `provenance` if `dist.attestations.provenance` is set, otherwise `none`
   - `publisher`: `_npmUser.name`
   - `hasInstallScript`: `preinstall` / `install` / `postinstall` / `gypfile`
   - `sourceRepo`, fetched only for the two versions a rule needs, from `<registry>/-/npm/v1/attestations/<name>@<version>`: decoded from the SLSA attestation (`predicate.buildDefinition.externalParameters.workflow.repository`). If it can't be read, the version is reported as unverified
5. **Evaluate:** `evaluate(change, history)` compares the target version with
   - _earlier_: every release published before it (for `trust-downgrade`)
   - _previous_: `change.from`, or the release just before the target (for `install-script-added` and `publisher-changed`)
   - _previous attested_: the latest earlier release with provenance (for `source-repo-changed`)
6. **Policy:** `check()` applies severity overrides (`rules`), drops allowlisted findings, sorts the results and sets `exitCode`.
7. **Report:** `render()` produces text, JSON or Markdown. The CLI maps errors to exit code 2.

### Design decisions

| Decision                                                                                          | Why                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compare a package against **its own history**, not a global policy                                | A package that never had provenance isn't suspicious. Losing provenance it used to have is. This keeps false positives low on day one.               |
| `trust-downgrade` compares against **all** earlier releases, not only `from`                      | If a project is already on a bad version, the next bad version must still be flagged.                                                                |
| Registry failures (network, 401/403, 429, 5xx) → **exit 2**, 404 → **unverified**                 | A security gate must never pass because the network or a token failed. A private package missing from the public registry is expected, not an error. |
| Attestations fetched from `<registry>/-/npm/v1/attestations/…`, never from a URL in the packument | Auth headers only ever go to the configured registry.                                                                                                |
| Provenance that can't be read → **unverified**                                                    | `source-repo-changed` can't run without it, so the gap is reported instead of skipped.                                                               |
| ✅ only when nothing is unverified                                                                | A green tick must mean every package was actually checked.                                                                                           |
| One runtime dependency (`yaml`)                                                                   | A supply-chain tool should have a tiny supply chain. HTTP, argument parsing, git and tests use only Node built-ins.                                  |
| No `postinstall` script                                                                           | Teams running `--ignore-scripts` get the same behaviour as everyone else.                                                                            |
| `fetchJson` is injectable                                                                         | Tests run offline from recorded registry fixtures. Users can add proxies, caching or auth without forking.                                           |
| Allowlist entries require a `reason`                                                              | Exceptions are reviewed in pull requests like any other change.                                                                                      |

## 2. Usage

### CLI

```text
provenance-guard diff [--base origin/main] [--lockfile <path>] [--format text|json|markdown] [--config <path>] [--registry <url>]
provenance-guard scan [--lockfile <path>] [--format …] [--config …] [--registry …]
```

| Exit code | Meaning                                                                                                                                   |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 0         | No error findings (warnings may exist)                                                                                                    |
| 1         | At least one error finding                                                                                                                |
| 2         | Tool failure: bad arguments or config, no lockfile, unsupported lockfile version, git error, registry unreachable / 401 / 403 / 429 / 5xx |

Option precedence: CLI flag → `.provenance-guard.json` (or `--config`) → `$npm_config_registry` (registry only) → built-in default.

### Programmatic

```ts
import { check, render } from '@amittksharma/provenance-guard';

const result = await check({ base: 'origin/main', rules: { 'publisher-changed': 'off' } });
console.log(render('text', result));
```

`check(options): Promise<CheckResult>`:

```ts
interface CheckResult {
  checked: number; // package versions examined
  findings: Finding[]; // { rule, severity, name, version, message }
  unverified: Unverified[]; // { name, version, reason }
  exitCode: 0 | 1;
}
```

The [README](../README.md#use-it-from-code) lists every option.

### Typical rollout

1. Run `scan` once locally. Allowlist the real historical gaps (with reasons) or turn off `publisher-changed`.
2. Add `diff --base origin/<target>` to the pull request workflow with `--format markdown >> $GITHUB_STEP_SUMMARY`.
3. Turn on the package manager's release-age gate as well.

## 3. Solution structure

```
provenance-guard/
├── src/
│   ├── types.ts       Shared types: Trust, RuleId, Change, VersionFacts, Finding, Unverified
│   ├── lockfile.ts    parseLockfile(): npm v2/v3, pnpm v6+, Yarn v1 and Berry (LF or CRLF) → Packages
│   ├── diff.ts        diffPackages(), compareVersions(), readAtRef() (git show)
│   ├── registry.ts    createRegistry() → history() / withSourceRepos(); createFetchJson(); RegistryError
│   ├── rules.ts       evaluate(), repoVersionsNeeded(): the four rules
│   ├── report.ts      render(): text / json / markdown
│   ├── index.ts       Public API: check(), options, validation, allowlist, severity overrides
│   └── cli.ts         run(argv, deps): args, config file, exit codes; bin entry
├── test/
│   ├── fixtures/                 Lockfiles for every format + recorded npm registry responses
│   ├── lockfile.test.ts          Parsing, aliases, git/workspace skipping
│   ├── diff.test.ts              Diff, version order, git ref reading
│   ├── registry.test.ts          Trust detection, attestation decoding, errors, concurrency
│   ├── rules.test.ts             Each rule, including the Nx / Shai-Hulud scenarios
│   └── cli.test.ts               End to end in temp git repos: exit codes, config, allowlist, reports
├── docs/
│   ├── design-discussion.md      Problem, gap analysis, features, feature→task map
│   ├── implementation-plan.md    Task-by-task build plan
│   └── architecture.md           This file
├── .husky/                       pre-commit (lint, types, test), commit-msg (Conventional Commits)
├── biome.jsonc                   Lint + format
├── tsconfig.json                 Build (src → dist, .ts imports rewritten to .js)
├── tsconfig.test.json            Type-check src + tests
└── .versionrc.json               commit-and-tag-version changelog sections
```

### Module dependencies

```
cli.ts ──► index.ts ──► lockfile.ts
   │          ├───────► diff.ts
   │          ├───────► registry.ts
   │          ├───────► rules.ts ──► registry.ts (History type)
   │          └───────► report.ts
   └──────► report.ts
(all) ─────► types.ts
```

No cycles. `registry.ts` is the only module that does network I/O, and `diff.ts` (`readAtRef`) is the only one that runs git.

### Extending

| To add                                 | Touch                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| A new rule                             | `RuleId` in `types.ts`, `RULE_IDS` in `index.ts`, logic in `rules.ts`, a test in `rules.test.ts` |
| A new lockfile format                  | One parser function plus a `switch` case in `lockfile.ts`, and a fixture                         |
| A new output format                    | `render()` in `report.ts` and `FORMATS` in `cli.ts`                                              |
| SARIF / GitHub Action / result caching | Deferred until there is demand (see design-discussion.md)                                        |
