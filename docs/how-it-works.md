# How provenance-guard works

What the tool checks, how it rates findings, and how it handles monorepos and report formats. For the code structure see [architecture.md](architecture.md); for planned rules see [rules-roadmap.md](rules-roadmap.md).

## Severity: less noise, nothing hidden

provenance-guard reduces noise by **grouping, rating and explaining** findings, never by deleting them:

| Tier       | Meaning                                        | Fails CI? |
| ---------- | ---------------------------------------------- | --------- |
| ❌ error   | Act now                                        | Yes       |
| ⚠️ warning | Review                                         | No        |
| ℹ️ info    | True but low-risk, with the reason (`context`) | No        |
| ✓ allowed  | Accepted in the allowlist, with the reason     | No        |

- **Grouping:** findings from one publish event (same rule, version, publisher and detail) are shown as one row listing every package. For example, TypeScript 7.0.2 and its 20 platform packages changing publisher become one row. In JSON every finding stays in `findings` with a shared `group` id, plus a summary in `groups`. In SARIF each package stays its own result, linked by `correlationGuid`.
- **`info` needs positive evidence, never just "no attack seen".** A `trust-downgrade` is rated `info` only when **all** of these hold. Otherwise it stays an `error`:
  1. **Continuity:** the publisher is a listed maintainer who already published releases in this release line (major version, or minor before 1.0).
  2. One of:
     - **Older-line maintenance release** (for example `vite@5.4.21`): stronger publishing exists only in _newer_ lines, and the release is a verified CI build (provenance with a readable source repo), or it is older than `oldReleaseDays` and the line later went back to attested publishing.
     - **Real drop inside the line** (for example `undici-types@6.21.0`): the release is older than `oldReleaseDays` **and** later releases of the same line went back to provenance or trusted publishing.
- **Stays an `error`:** a new major without provenance; a recent hand-published patch to any line; any release by a non-maintainer; a provenance release whose attestation can't be read; a drop in a line that never went back to attested publishing.
- **Remaining risk:** an attacker who controls the project's own CI _and_ a maintainer's identity produces releases that look legitimate (same repo, same publisher). provenance-guard can't tell those apart; code review and a release-age gate cover that case.
- **Severity overrides win.** `rules: { "trust-downgrade": "error" }` turns every `info` rating for that rule back into `error`.
- **Evidence:** every finding carries `evidence`: publisher, whether they're a listed maintainer, previous version and publisher, age, release line, best earlier trust and last attested version. Reports show it next to each finding.

## Monorepos

Run it from the repo root. Workspace tools share one lockfile at the root, so one run checks every app and package. Each finding says **which workspaces use the package**, directly or through other packages and workspaces:

```text
❌ error trust-downgrade      debug@4.4.2 has none; earlier releases had provenance — used by apps/web, packages/ui
```

In Markdown the same information appears in a **Used by** column, and in JSON as `usedBy`. Single-project repos don't get `usedBy`, because there's only one project it could name.

**Several lockfiles** (old Lerna setups, pnpm with `shared-workspace-lockfile=false`, nested projects):

- By default only the root lockfile is checked. If others exist below it, the report says so: `⚠️ 2 more lockfiles not checked: …`. The ✅ is then withheld.
- `--recursive` checks every lockfile below the current folder. Findings that are exactly the same in several lockfiles (same rule, package, version and message) appear once, listing every workspace that uses the package. If the details differ, for example a different previous publisher because each lockfile upgraded from a different version, each one gets its own row.
- Recursive mode can also be set in the config with `"recursive": true` or `false`.
- Add folders you don't want checked (test fixtures, examples) to `exclude`.

Lockfile discovery walks the whole folder tree and skips only `node_modules` and `.git`. Git-ignored folders, dot folders (for example `.github/actions/*`), submodules and nested repos are all included, so nothing is dropped without a warning. Folders that can't be read are listed in a warning. Put anything you don't want checked in `exclude`.

**Attribution details:**

- A workspace's `devDependencies` count only for that workspace, not for workspaces that depend on it.
- Yarn Berry lockfiles don't separate dev from production dependencies, so dev dependencies there are attributed to every workspace that depends on the package.
- A package that no workspace reaches (for example an extraneous entry) gets no `usedBy` rather than a guess.
- Workspace and local links (`workspace:`, `link:`, `file:`) are followed through the lockfile. A local package outside the workspaces, such as `file:../shared`, is followed but isn't listed as a workspace.
- **Notes (ℹ️)** report gaps in attribution, never in checking. Every package in the lockfile is still checked, the ✅ and the exit code are unaffected, and only `usedBy` may be incomplete:
  - `workspace dependency could not be resolved: apps/web → packages/gone`: the link target isn't in the lockfile, so it isn't followed.
  - `required dependency is missing from the lockfile: debug@4.4.1 → ms`: the lockfile is likely out of sync with `package.json`. Optional and peer dependencies are not reported, because skipping them is normal.
- Yarn v1 workspace patterns support `*`, `**`, `?`, `{a,b}` and `!negation`.

## Report formats

| Format     | For                                                            | Notes                                                                                                                                                      |
| ---------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`     | Terminals                                                      | Default on stdout                                                                                                                                          |
| `json`     | Scripts, dashboards                                            | Findings include `usedBy` and lockfile `locations`                                                                                                         |
| `markdown` | PR comments, step summaries                                    |                                                                                                                                                            |
| `sarif`    | GitHub code scanning, Azure DevOps Scans tab, any SARIF viewer | SARIF 2.1.0. Each result points at the package's line in the lockfile, has a stable fingerprint so dashboards don't duplicate alerts, and carries `usedBy` |
| `junit`    | Azure DevOps Tests tab, Jenkins, GitLab                        | Errors fail; warnings and unverified are skipped with the reason; one passing test records the package count                                               |
| `html`     | Sharing outside CI (auditors, reviews)                         | One self-contained file, no scripts or external assets, everything escaped. Example: [docs/examples/report.html](docs/examples/report.html)                |

`--format <fmt>` chooses what is printed to stdout. `--output <fmt>=<path>` writes a file and can be repeated. **All formats are rendered from one check, so five report files cost the same registry calls as one.**

## Limits

- **Only the public npm data model.** Mirrors that strip `_npmUser` or attestation data produce no findings for those packages. Packages the registry returns 404 for show as _unverified_, and so do versions whose provenance attestation can't be read. Point `registry` at `https://registry.npmjs.org` for public packages.
- **It catches what the registry shows.** A compromise that goes through the project's real CI (for example a poisoned workflow in the same repo) keeps provenance and repo unchanged. Code review and the release-age gate cover that case.
- `scan` downloads one full packument per package. On a big lockfile, expect up to a minute.
