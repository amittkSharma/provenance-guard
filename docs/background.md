# Why provenance-guard exists

## The problem

Almost every big npm compromise in 2025 worked the same way: an attacker obtained a maintainer's npm token or session (phishing, a leaked CI secret, a malicious package that stole tokens), then published a new patch version from their own machine.

| Incident (2025)                  | What happened                                                                            | Signal that was visible in the registry                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Nx "s1ngularity" (Aug)           | Malicious `nx` versions published with a token stolen through a GitHub Actions injection | Earlier versions had provenance; the malicious ones did not              |
| chalk / debug, 18 packages (Sep) | Maintainer phished; malicious patch versions published                                   | Published by hand by the maintainer account, with no CI build behind it  |
| Shai-Hulud 1 and 2 (Sep, Nov)    | Worm steals npm tokens and republishes victims' packages with a new install script       | `preinstall`/`postinstall` appears in a patch release that never had one |

Vulnerability scanners (`npm audit`, OSV, Snyk) cannot catch this. On day 0 there is no advisory, and the malicious version stays live for the hours before one is written. Those are the hours when CI pipelines pull it in through `^` ranges.

The registry already exposes the signals needed to catch it:

- `versions[v]._npmUser.trustedPublisher`: was this published by CI through OIDC?
- `versions[v].dist.attestations`: does it have SLSA provenance, and **from which repo**?
- `versions[v]._npmUser.name`: who published it?
- `versions[v].scripts`: does it run code on install?

Nobody compares these **against the package's own history** when a lockfile changes.

## The gap

Checked against the current docs on 2026-11-24:

| Tool                   | Release-age gate       | Trust-downgrade check                                           | Source-repo change | New install script                | Report at PR review time |
| ---------------------- | ---------------------- | --------------------------------------------------------------- | ------------------ | --------------------------------- | ------------------------ |
| npm CLI                | ✅ `min-release-age`   | ❌                                                              | ❌                 | ❌ (only `ignore-scripts`)        | ❌                       |
| Yarn Berry             | ✅ `npmMinimalAgeGate` | ❌                                                              | ❌                 | ❌                                | ❌                       |
| pnpm 10                | ✅ `minimumReleaseAge` | ✅ `trustPolicy: no-downgrade`                                  | ❌                 | partial (`onlyBuiltDependencies`) | ❌                       |
| `npm audit signatures` | —                      | ❌ only verifies attestations that exist; missing ones are fine | ❌                 | ❌                                | ❌                       |
| Socket.dev             | ✅                     | ✅                                                              | ✅                 | ✅                                | ✅ (commercial SaaS)     |

**The gap provenance-guard fills:**

1. **npm and Yarn users get no trust-downgrade check at all.** That is most of the ecosystem. pnpm has one, but only at install time.
2. **A source-repo change goes undetected by any free tool.** A version with valid provenance built from `evil/fork` instead of `chalk/chalk` passes every existing check.
3. **Install-time gates block silently.** The person reviewing the PR never sees _why_ a lockfile change is risky. A Markdown PR summary closes that gap.
4. **Existing lockfiles go unchecked.** Install gates only apply to new resolutions. `scan` audits what is already pinned.
5. **No vendor or SaaS required.** It reads only public registry data, has one runtime dependency, and works with any CI.

**Deliberately not built:** a release-age gate. npm, Yarn and pnpm all have one now, so the README tells users to turn it on.

The rules and their roadmap are in [rules-roadmap.md](rules-roadmap.md).
