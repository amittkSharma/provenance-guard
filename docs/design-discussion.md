# provenance-guard — design discussion

Captured from the planning discussion on 2026-11-24. The implementation plan is in [implementation-plan.md](implementation-plan.md).

## The real problem

Almost every big npm compromise in 2025 worked the same way: an attacker obtained a maintainer's npm token or session (phishing, a leaked CI secret, a malicious package that stole tokens), then published a new patch version from their own machine.

| Incident (2025) | What happened | Signal that was visible in the registry |
|---|---|---|
| Nx "s1ngularity" (Aug) | Malicious `nx` versions published with a token stolen through a GitHub Actions injection | Earlier versions had provenance; the malicious ones did not |
| chalk / debug, 18 packages (Sep) | Maintainer phished; malicious patch versions published | Published by hand by the maintainer account, with no CI build behind it |
| Shai-Hulud 1 and 2 (Sep, Nov) | Worm steals npm tokens and republishes victims' packages with a new install script | `preinstall`/`postinstall` appears in a patch release that never had one |

Vulnerability scanners (`npm audit`, OSV, Snyk) cannot catch this. On day 0 there is no advisory, and the malicious version stays live for the hours before one is written. Those are the hours when CI pipelines pull it in through `^` ranges.

The registry already exposes the signals needed to catch it:
- `versions[v]._npmUser.trustedPublisher`: was this published by CI through OIDC?
- `versions[v].dist.attestations`: does it have SLSA provenance, and **from which repo**?
- `versions[v]._npmUser.name`: who published it?
- `versions[v].scripts`: does it run code on install?

Nobody compares these **against the package's own history** when a lockfile changes.

## The gap (what exists versus what is missing)

Checked against the current docs on 2026-11-24:

| Tool | Release-age gate | Trust-downgrade check | Source-repo change | New install script | Report at PR review time |
|---|---|---|---|---|---|
| npm CLI | ✅ `min-release-age` | ❌ | ❌ | ❌ (only `ignore-scripts`) | ❌ |
| Yarn Berry | ✅ `npmMinimalAgeGate` | ❌ | ❌ | ❌ | ❌ |
| pnpm 10 | ✅ `minimumReleaseAge` | ✅ `trustPolicy: no-downgrade` | ❌ | partial (`onlyBuiltDependencies`) | ❌ |
| `npm audit signatures` | — | ❌ only verifies attestations that exist; missing ones are fine | ❌ | ❌ | ❌ |
| Socket.dev | ✅ | ✅ | ✅ | ✅ | ✅ (commercial SaaS) |

**The gap provenance-guard fills:**
1. **npm and Yarn users get no trust-downgrade check at all.** That is most of the ecosystem. pnpm has one, but only at install time.
2. **A source-repo change goes undetected by any free tool.** A version with valid provenance built from `evil/fork` instead of `chalk/chalk` passes every existing check.
3. **Install-time gates block silently.** The person reviewing the PR never sees *why* a lockfile change is risky. A Markdown PR summary closes that gap.
4. **Existing lockfiles go unchecked.** Install gates only apply to new resolutions. `scan` audits what is already pinned.
5. **No vendor or SaaS required.** It reads only public registry data, has one runtime dependency, and works with any CI.

**Deliberately not built:** a release-age gate. npm, Yarn and pnpm all have one now, so the README tells users to turn it on.

## Features (v1)

| # | Feature | Severity | Catches |
|---|---|---|---|
| F1 | `trust-downgrade`: version's trust level is below the best level of any earlier release (`trusted-publisher` > `provenance` > `none`) | error | Nx-style token theft |
| F2 | `source-repo-changed`: provenance repo differs from the previous attested release | error | Builds from a fork or stolen-CI repo |
| F3 | `install-script-added`: `preinstall`/`install`/`postinstall`/`gypfile` present, absent in the previous release | warn | Shai-Hulud-style worms |
| F4 | `publisher-changed`: no trusted publisher, and `_npmUser.name` differs from the previous release | warn | Hijacked or new maintainer accounts |
| F5 | `diff --base <ref>`: checks only packages added or upgraded relative to a git ref | — | PR gate |
| F6 | `scan`: checks every package in the lockfile | — | First adoption, periodic audit |
| F7 | Lockfiles: `package-lock.json` v2/v3, `pnpm-lock.yaml` v9, `yarn.lock` v1 and Berry | — | Any package manager |
| F8 | Output: `text`, `json`, `markdown` (for `$GITHUB_STEP_SUMMARY` / PR comments); exit 0 / 1 (error findings) / 2 (tool failure) | — | CI |
| F9 | Allowlist: `.provenance-guard.json` → `{ "allow": [{ "name", "rule", "reason" }] }` | — | Real intentional changes |

**Later, add only when asked:** SARIF output, a GitHub Action wrapper, private-registry auth, expiring allowlist entries, caching results between runs.


## How the v1 features map to the build tasks

The tasks are split by pipeline stage, not by feature. Every rule needs the same pipeline (read lockfile → compare → fetch registry data → apply rule → report), so building per feature would repeat it four times. The trade-off: no feature works from the command line until Task 5 is done; Tasks 1–4 are tested on their own.

| Feature | Task(s) |
|---|---|
| F7: read npm, pnpm and Yarn lockfiles | 1 |
| F5: `diff --base` (only what the PR changed) | 2, command in 5 |
| F6: `scan` (whole lockfile) | 5 |
| F1: `trust-downgrade` | 3 (trust data), 4 (rule) |
| F2: `source-repo-changed` | 3 (source repo), 4 (rule) |
| F3: `install-script-added` | 3, 4 |
| F4: `publisher-changed` | 3, 4 |
| F8: text, JSON, Markdown output, exit codes | 5 |
| F9: allowlist | 5 |

Decision: keep the stage-by-stage plan (5 tasks, about 11 hours).
