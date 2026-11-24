# provenance-guard

**Fail CI when a dependency update is less trustworthy than the package's own earlier releases.**

Most npm supply-chain attacks in 2025 (Nx "s1ngularity", chalk/debug, the Shai-Hulud worm) followed the same pattern: an attacker stole a maintainer's token and published a new patch version by hand. Vulnerability scanners miss these on day 0 because no advisory exists yet. Each attack still left a visible trace in the registry, and provenance-guard checks for those traces:

| Rule                   | Fails when                                                                                                 | Severity |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- | -------- |
| `trust-downgrade`      | The version has weaker publishing trust than earlier releases (trusted publisher → provenance → none)      | ❌ error |
| `source-repo-changed`  | Provenance says it was built from a different GitHub repo than before                                      | ❌ error |
| `install-script-added` | It adds `preinstall` / `install` / `postinstall` (or a native build) that the previous release didn't have | ⚠️ warn  |
| `publisher-changed`    | It was published by hand by a different npm account than the previous release                              | ⚠️ warn  |

It works with **npm, pnpm and Yarn** (v1 and Berry) lockfiles, reads only public registry data, and has a single runtime dependency (`yaml`).

---

## Quick start

```bash
# In a pull request: check only what changed since main
npx @amittksharma/provenance-guard diff --base origin/main

# Audit everything already in the lockfile
npx @amittksharma/provenance-guard scan
```

```text
provenance-guard: 2 findings in 3 packages
❌ error trust-downgrade      nx@21.5.0 has none; earlier releases had provenance
⚠️ warn  install-script-added nx@21.5.0 adds an install script
```

Exit codes: **0** no errors · **1** at least one error finding · **2** the tool couldn't run (bad config, no lockfile, registry unreachable). It never exits 0 if it couldn't finish the check.

## Add it to CI (2 minutes)

### GitHub Actions

```yaml
name: dependency trust
on: pull_request

jobs:
  provenance-guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # the base branch must be available for `diff`
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx @amittksharma/provenance-guard diff --base origin/${{ github.base_ref }} --format markdown >> "$GITHUB_STEP_SUMMARY"
```

The Markdown report appears on the workflow run's summary page. The step fails when there is an error finding.

### Any other CI

```bash
git fetch origin main
npx @amittksharma/provenance-guard diff --base origin/main --format markdown > provenance-guard.md
```

Use `--format json` if another tool will read the result.

## Configure

Put an optional `.provenance-guard.json` in the project root. All keys are optional.

```jsonc
{
  "base": "origin/main", // default ref for `diff`
  "lockfile": "pnpm-lock.yaml", // default: auto-detect
  "registry": "https://registry.npmjs.org",
  "rules": {
    "publisher-changed": "off", // "error" | "warn" | "off"
    "install-script-added": "error"
  },
  "allow": [
    {
      "name": "undici-types",
      "rule": "trust-downgrade",
      "version": "6.21.0", // optional: only this version
      "reason": "6.14–7.0.0 were published without provenance by the same maintainer; checked 2026-11-24"
    }
  ]
}
```

- **`rules`**: change a rule's severity, or turn it off.
- **`allow`**: accept a specific finding. A `reason` is **required**, so every exception is explained in code review. Add `version` to keep the exception narrow. Without it, every version of that package is allowed for that rule.

CLI flags override the config file:

```text
provenance-guard <diff|scan> [--base <ref>] [--lockfile <path>] [--format text|json|markdown]
                             [--config <path>] [--registry <url>]
```

## Use it from code

```ts
import { check, render } from '@amittksharma/provenance-guard';

const result = await check({
  cwd: '/path/to/project',
  base: 'origin/main', // omit to check the whole lockfile
  rules: { 'publisher-changed': 'off' },
  allow: [{ name: 'undici-types', rule: 'trust-downgrade', reason: 'known gap' }],
  headers: { authorization: `Bearer ${process.env.REGISTRY_TOKEN}` }, // private mirror
  concurrency: 8,
});

console.log(render('markdown', result));
process.exitCode = result.exitCode; // 0 or 1
```

`check()` throws when it can't finish (no lockfile, invalid options, registry error). Catch the error and decide how to handle it.

| Option        | Default                         | Purpose                                                                     |
| ------------- | ------------------------------- | --------------------------------------------------------------------------- |
| `cwd`         | `process.cwd()`                 | Project directory                                                           |
| `lockfile`    | auto-detect                     | `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml` or `yarn.lock` |
| `base`        | —                               | Git ref. Set → check changed packages only; unset → check all               |
| `rules`       | built-in severities             | `{ [rule]: 'error' \| 'warn' \| 'off' }`                                    |
| `allow`       | `[]`                            | `{ name, rule, version?, reason }[]`                                        |
| `registry`    | `$npm_config_registry` or npmjs | Registry base URL                                                           |
| `headers`     | `{}`                            | Extra request headers (auth)                                                |
| `concurrency` | `8`                             | Parallel registry requests                                                  |
| `fetchJson`   | built-in                        | Replace the HTTP layer (proxy, cache, tests)                                |

Also exported: `createFetchJson`, `RegistryError`, `RULE_IDS`, `LOCKFILES` and all result types.

## Handling a finding

1. **Look at the package page** on npmjs.com, and at the repo's releases and issues. Was the change announced (new CI, new maintainer, project moved)?
2. **Not explained?** Don't merge. Pin the previous version and report it to the maintainers.
3. **Explained?** Add an `allow` entry with the version and a reason.

**What to expect on the first `scan`:** long-lived projects often have old gaps. For example, `undici-types` (used by `@types/node`) dropped provenance between 6.14 and 7.0.0. `publisher-changed` also fires when a large project changes its publishing account (TypeScript did in 2026). Allowlist the real gaps once, or set `publisher-changed` to `off`. After that, run `diff` on pull requests.

## Use it together with a release-age gate

provenance-guard compares a version against the package's history. A **release-age gate** delays installing brand-new versions, which gives the community time to spot attacks. Every major package manager now has one built in; turn it on as well:

| Package manager | Setting                                                                         |
| --------------- | ------------------------------------------------------------------------------- |
| npm             | `min-release-age`                                                               |
| pnpm            | `minimumReleaseAge` (pnpm also has `trustPolicy: no-downgrade` at install time) |
| Yarn Berry      | `npmMinimalAgeGate`                                                             |

## Limits

- **Only the public npm data model.** Private registries or mirrors that strip `_npmUser` or attestation data produce no findings for those packages (packages they 404 on show as _unverified_). Point `registry` at `https://registry.npmjs.org` for public packages.
- **It catches what the registry shows.** A compromise that goes through the project's real CI (for example a poisoned workflow in the same repo) keeps provenance and repo unchanged. Code review and the release-age gate cover that case.
- `scan` downloads one full packument per package. On a big lockfile, expect up to a minute.

## Troubleshooting

| Symptom                                         | Fix                                                                                                                  |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `unable to get local issuer certificate`        | Corporate TLS proxy. Node ≥ 22.15: `NODE_OPTIONS=--use-system-ca`. Older: `NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem` |
| `git show origin/main:package-lock.json failed` | Shallow clone. Use `fetch-depth: 0` or `git fetch origin main`                                                       |
| A private package shows as _unverified_         | Expected: it isn't on the public registry. Pass `registry` and `headers` if your mirror serves full packuments       |

## Development

```bash
npm install          # also installs the husky git hooks
npm test             # node:test, runs TypeScript directly (Node ≥ 22.18)
npm run lint:fix     # biome
npm run types        # tsc --noEmit
npm run build        # → dist/
npm run bump         # commit-and-tag-version: version, CHANGELOG, tag
```

- **Pre-commit hook:** lint, types and tests.
- **Commit-msg hook:** requires [Conventional Commits](https://www.conventionalcommits.org) (`feat: …`, `fix(registry): …`) so the changelog can be generated.

Design notes: [docs/design-discussion.md](docs/design-discussion.md) · Architecture: [docs/architecture.md](docs/architecture.md)

## License

MIT
