# Roadmap

Rules that exist, rules and improvements that are planned, and how to add a rule.

## Implemented

| Rule                   | Catches                                                                                             | Real incident                                     | Default                               |
| ---------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------- |
| `trust-downgrade`      | A release published with weaker trust than earlier releases (trusted publisher → provenance → none) | Nx "s1ngularity" (2025)                           | error, or info with positive evidence |
| `source-repo-changed`  | Provenance says the release was built from a different repository                                   | Closes a gap in provenance itself                 | error                                 |
| `install-script-added` | A new `preinstall` / `install` / `postinstall` script or native build                               | ua-parser-js and coa/rc (2021), Shai-Hulud (2025) | warn                                  |
| `publisher-changed`    | Published by hand from a different npm account than the previous release                            | Hijacked or new maintainer accounts               | warn                                  |

## Planned

### 0.2.0: low noise, high value

| Rule                     | Catches                                                                                                                                | Signal (already downloaded)                                                                                          | Default                                         | Effort |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------ |
| `workflow-changed`       | Built by a different workflow file, from a non-release branch, or by a `pull_request_target` trigger. Covers the "compromised CI" risk | Provenance: `buildDefinition.externalParameters.workflow` (`path`, `ref`) and `internalParameters.github.event_name` | error                                           | ~3 h   |
| `install-script-changed` | An existing install script whose content changed                                                                                       | `versions[v].scripts`                                                                                                | warn                                            | ~1 h   |
| `version-deprecated`     | The installed version is deprecated with wording such as "compromised" or "malicious"                                                  | `versions[v].deprecated`                                                                                             | error for compromise wording; ignored otherwise | ~1 h   |

`version-deprecated` must not flag ordinary deprecations ("no longer supported"). Real lockfiles contain many of those, and flagging them would bury real findings.

### 0.3.0: medium noise, measure before promoting

| Rule               | Catches                                                                                      | Signal                                                         | Default                   | Effort |
| ------------------ | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------- | ------ |
| `maintainer-added` | A maintainer account added shortly before the release                                        | `versions[v].maintainers`, compared with the previous release  | warn                      | ~2 h   |
| `dependency-added` | A patch release that adds a new dependency (the event-stream → flatmap-stream pattern, 2018) | `versions[v].dependencies`, compared with the previous release | warn, patch releases only | ~2 h   |

### Later: needs new data or a new dependency

| Rule                               | Catches                                                                                                  | What it needs                                                          | Effort   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------- |
| `attestation-invalid`              | Provenance whose Sigstore signature doesn't verify. Today the tool trusts the registry's copy            | The `sigstore` library                                                 | ~1 day   |
| `lockfile-tampered`                | A lockfile `resolved` URL or `integrity` that doesn't match the registry, i.e. a PR swapping the tarball | `dist.tarball` and `dist.integrity` from the packument                 | ~3 h     |
| `trusted-publisher-config-changed` | The trusted-publishing configuration changed between versions                                            | `_npmUser.trustedPublisher.oidcConfigId` (confirm what it means first) | ~2 h     |
| `bin-added`                        | A new `bin` command that could shadow `node`, `git` and similar                                          | `versions[v].bin`                                                      | ~1 h     |
| `code-diff-suspicious`             | New obfuscated or minified code, or new network or credential access, in a patch release                 | Downloading and diffing tarballs                                       | 2–3 days |

### Not planned: other tools do this better

| Check                   | Use instead                                                               |
| ----------------------- | ------------------------------------------------------------------------- |
| Release too new         | npm `min-release-age`, pnpm `minimumReleaseAge`, Yarn `npmMinimalAgeGate` |
| Known malicious package | OSV `MAL-` advisories                                                     |
| Known vulnerabilities   | `npm audit`, OSV                                                          |

### Known gap

A phished maintainer who injects code into an existing file, with no install script and no provenance to lose (chalk/debug, September 2025), is not caught by any rule above except `code-diff-suspicious`. A release-age gate is the practical defence until then.

## Planned improvements (not rules)

Found while building and reviewing 0.1.0. Each has an owner release so it isn't forgotten.

### 0.2.0

| Improvement                              | Why                                                                                                                                                                        | Design notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Effort  |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **Disk cache between runs**              | Every run downloads each package's full registry data again (TypeScript's alone is several MB). Nightly `scan`s of big lockfiles are slow and load the registry            | Store each packument and its `ETag` in a cache folder (for example `.provenance-guard-cache/`, path configurable). On the next run, send `If-None-Match`; on `304 Not Modified`, use the stored copy. In CI, persist the folder with the CI's cache step (`actions/cache`, Azure `Cache@2`). **Security:** always revalidate with the registry rather than trusting a timer. A stale copy could hide a brand-new malicious release, so any time-based skip must be opt-in and short | ~2–3 h  |
| **Skip private scopes** (`ignoreScopes`) | The tool asks the public registry about every package in the lockfile, so `registry.npmjs.org` sees internal package names (they come back as 404). That leaks information | Option such as `"ignoreScopes": ["@corp"]`. Matching packages are listed as "skipped (private scope)", not silently dropped                                                                                                                                                                                                                                                                                                                                                         | ~1 h    |
| **`--timeout` CLI flag**                 | `timeoutMs` works in the config file and the API, but not as a flag                                                                                                        | Maps to `timeoutMs`. Add only if users ask                                                                                                                                                                                                                                                                                                                                                                                                                                          | ~15 min |

### 0.3.0 or later

| Improvement                             | Why                                                                                                                      | Effort |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------ |
| **Allowlist for a whole group**         | Accepting one publish event (for example TypeScript and its 20 platform packages) currently needs one entry per package  | ~2 h   |
| **Group one publisher across versions** | One maintainer publishing several packages at different versions (seen with Express dependencies) produces separate rows | ~2 h   |
| **`onFinding` callback in the API**     | Lets tools stream findings (logs, chat) before the run ends                                                              | ~1 h   |
| **CommonJS build**                      | Only needed for consumers on Node versions that can't `require()` ES modules (before 20.19 / 22.12)                      | ~2 h   |

### Verification still owed

These aren't features, but 0.1.0 claims depend on them:

- [ ] Validate the SARIF output against the official SARIF 2.1.0 schema
- [ ] Run the README's Azure DevOps pipeline in a real Azure project (Tests and Scans tabs)
- [ ] Measure precision on 3–5 real repositories for 1–2 weeks before 0.2.0

## Release plan

1. **0.1.0:** the 4 implemented rules, plus noise reduction (grouping, the `info` tier, evidence, visible suppressions).
2. Run it on 3–5 real repositories for 1–2 weeks. Count real findings against noise.
3. **0.2.0**, then **0.3.0**, as above. Measure each before the next.
4. **1.0.0** when all of these are true:
   - fewer than 1 false error per repository per week;
   - the config and API are stable;
   - the package is published with provenance;
   - at least 2 teams use it.
5. **After 1.0:** a new rule ships as `warn` or `info` and becomes `error` only in the next major version, so a minor update never breaks someone's CI.

## Adding a rule

1. **Name the attack.** Write down which real incident or attack pattern it catches. A rule without one adds noise, not safety.
2. **Find the signal in data the tool already has**, if possible: the packument version manifest, `time`, `maintainers`, or the SLSA provenance statement. Each extra request per package slows down every scan.
3. **Decide what counts as positive evidence** for anything below `error`. `info` must never mean "we saw no attack", only "here is evidence it is legitimate".
4. **Write the tests first**, in `test/rules.test.ts`:
   - the attack scenario (must fire);
   - the most common legitimate case (must not fire, or must be `info` with a reason);
   - at least one attempt to dodge the rule (for example a new major, an old release line, or a non-maintainer account).
5. **Implement it** in `src/rules.ts`. Add the id to `RuleId` in `src/types.ts` and to `RULE_IDS`, and a `RULE_DOCS` entry (title, description, what to do), which SARIF and HTML use.
6. **Run it on a real lockfile** (a real npm and pnpm workspace) and count the findings before choosing the default severity.
7. **Document it** in the README rule table and move it to "Implemented" here.
