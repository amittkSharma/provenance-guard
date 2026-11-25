# Architecture

For contributors: how the code is organised and why. For user-facing behaviour see [how-it-works.md](how-it-works.md).

## Pipeline

```
lockfile(s) ──► collect ──► registry ──► rules ──► findings ──► report
  (+ git base)   parse, diff,   packument +   evaluate      triage:        text · json · markdown
                 workspaces,    attestation   each change   merge, rate,   sarif · junit · html
                 locations      per package   vs history    allow, group
```

Each stage except `registry.ts` (network) and `diff.ts` / `discover.ts` (git and file system) is a pure function. That keeps the tests offline and fast.

## Data flow

1. **Lockfiles** (`collect.ts`, `discover.ts`):
   - Check one lockfile, or every lockfile below `cwd` with `recursive`.
   - Discovery walks the file system and skips only `node_modules`, `.git` and `exclude` paths. Lockfiles that were found but not checked become warnings.
2. **Changes** (`lockfile.ts`, `diff.ts`):
   - Parse the working-tree lockfile, and the base lockfile from `git show <base>:./<file>`, into `name → versions`.
   - The new versions are the changes. With no base, every package is a change.
3. **Workspaces** (`workspaces.ts`):
   - Build the lockfile's dependency graph once and walk it from every workspace, to fill `usedBy`.
   - Links that can't be resolved and missing required dependencies become notes.
4. **History** (`registry.ts`):
   - Fetch one packument per package (cached), and read provenance attestations only for the versions a rule needs.
   - 404 means unverified; any other failure exits with code 2.
5. **Rules** (`rules.ts`): `evaluate()` compares the new version with the package's own earlier releases, attaches `evidence`, and rates `info` only on positive evidence.
6. **Triage** (`findings.ts`):
   - Merge exact duplicates and apply severity overrides.
   - Move allowlisted findings to `suppressed`, and group findings from one publish event.
7. **Reports** (`report*.ts`): every format is rendered from one `CheckResult`, so extra formats cost no requests.

## Design decisions

| Decision                                                                                          | Why                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compare a package against **its own history**, not a global policy                                | A package that never had provenance isn't suspicious. Losing provenance it used to have is. This keeps false positives low on day one.                     |
| `trust-downgrade` compares against **all** earlier releases, not only `from`                      | If a project is already on a bad version, the next bad version must still be flagged.                                                                      |
| Registry failures (network, 401/403, 429, 5xx) → **exit 2**, 404 → **unverified**                 | A security gate must never pass because the network or a token failed. A private package missing from the public registry is expected, not an error.       |
| Attestations fetched from `<registry>/-/npm/v1/attestations/…`, never from a URL in the packument | Auth headers only ever go to the configured registry.                                                                                                      |
| Provenance that can't be read → **unverified**                                                    | `source-repo-changed` can't run without it, so the gap is reported instead of skipped.                                                                     |
| ✅ only when nothing is unverified                                                                | A green tick must mean every package was actually checked.                                                                                                 |
| One runtime dependency (`yaml`)                                                                   | A supply-chain tool should have a tiny supply chain. HTTP, argument parsing, git and tests use only Node built-ins.                                        |
| No `postinstall` script                                                                           | Teams running `--ignore-scripts` get the same behaviour as everyone else.                                                                                  |
| `fetchJson` is injectable                                                                         | Tests run offline from recorded registry fixtures. Users can add proxies, caching or auth without forking.                                                 |
| Discovery walks the file system (not `git ls-files`) and skips only `node_modules` and `.git`     | Git hides ignored files, submodules and nested repos. A security gate must not lose lockfiles silently, so anything unwanted goes in `exclude` explicitly. |
| Lockfiles below the root → **warning**, ✅ withheld, exit code unchanged                          | A lockfile nobody checks is a silent coverage gap. Warning instead of failing keeps fixture-heavy repos usable; `exclude` or `--recursive` resolves it.    |
| `usedBy` = every workspace that reaches the package, including through other workspaces           | Owners of `apps/web` need to know when `packages/ui` pulls in a bad version for them.                                                                      |
| Reduce noise by grouping, rating (`info`) and explaining — never by deleting                      | Users trust a quiet report only if they can still see everything it chose not to shout about. Allowlisted findings stay visible as suppressed.             |
| Allowlist entries require a `reason`                                                              | Exceptions are reviewed in pull requests like any other change.                                                                                            |

## Source layout

```
src/
  index.ts          Public API (check, render, OUTPUT_FORMATS, RULE_IDS, createFetchJson, RegistryError, types)
  cli.ts            Command line: arguments, config file, --output files, exit codes
  check.ts          check(): orchestrates the pipeline, returns CheckResult
  options.ts        CheckOptions, AllowEntry, validation
  collect.ts        Lockfile selection, changes, workspace usage, locations, warnings and notes
  discover.ts       Finds every lockfile below a folder
  lockfile.ts       Parses npm, pnpm and Yarn lockfiles; finds a package's line
  diff.ts           Version order, lockfile diff, reading a file at a git ref
  workspaces.ts     Dependency graph per lockfile format; which workspaces use what
  registry.ts       Packuments, attestations, concurrency limit, RegistryError
  rules.ts          The rules, release lines, evidence, RULE_IDS
  findings.ts       Merge, severity overrides, allowlist, grouping, ordering
  report.ts         render(): text, markdown, json; dispatches to the formats below
  report-common.ts  Report type, headlines, rule documentation
  report-sarif.ts   SARIF 2.1.0
  report-junit.ts   JUnit XML
  report-html.ts    Standalone HTML
  text.ts           plural, shortList, packageId, escapeMarkup
  types.ts          Shared types
test/               One *.test.ts per module; fixtures/ holds lockfiles and recorded registry data
```

## Adding things

| To add            | Where                                                                       |
| ----------------- | --------------------------------------------------------------------------- |
| A rule            | See [rules-roadmap.md → Adding a rule](rules-roadmap.md#adding-a-rule)      |
| A lockfile format | A parser in `lockfile.ts`, a graph builder in `workspaces.ts`, and fixtures |
| A report format   | A renderer file, plus `OUTPUT_FORMATS` and `render()` in `report.ts`        |
