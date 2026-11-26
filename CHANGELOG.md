# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## 0.1.0 (2026-11-26)

First public release.

### Highlights

- **Four trust rules** that compare every dependency update with the package's own release history: `trust-downgrade`, `source-repo-changed`, `install-script-added` and `publisher-changed`
- **`diff` and `scan` commands:** check only what a pull request changed, or the whole lockfile. Exit code `2` when the check can't finish, never a silent pass
- **npm, pnpm (lockfile v6 and v9), Yarn v1 and Yarn Berry**, including monorepos: findings name the workspaces that use the package, and `--recursive` checks every lockfile
- **Six report formats** from one check: text, JSON, Markdown, SARIF (GitHub code scanning, Azure DevOps Scans tab), JUnit (Azure DevOps Tests tab) and standalone HTML
- **Low noise without hiding anything:** findings from one publish event are grouped, low-risk findings are rated `info` only on positive evidence, every finding carries its evidence, and allowlisted findings stay visible with their reason
- **Configurable:** `.provenance-guard.json` or the `check()` API, with severity overrides, an allowlist that requires reasons, registry and auth headers, and a custom HTTP layer
- **Small supply chain:** one runtime dependency, no install scripts, published with npm provenance

### Features

- check() API, CLI, allowlist, reports and docs ([535eec5](https://github.com/amittkSharma/provenance-guard/commit/535eec52ac41848f22bf5e5816aa35bfff23bd77))
- diff lockfiles against a git ref ([8e65f77](https://github.com/amittkSharma/provenance-guard/commit/8e65f774db244829c17bd8ebde84ea6236aa0a10))
- parse npm, pnpm and yarn lockfiles ([5ee6c85](https://github.com/amittkSharma/provenance-guard/commit/5ee6c85cd39ef34e122b586d603de97f798c735d))
- read trust facts from the npm registry ([070e8b7](https://github.com/amittkSharma/provenance-guard/commit/070e8b74b2e519e0cf55b34cd897e2f85493fb20))
- reports, noise reduction, production readiness and docs ([b5cf2ea](https://github.com/amittkSharma/provenance-guard/commit/b5cf2eaf97b0cdba5f4e075666ba2a0b6564b28e))
- trust comparison rules ([6615003](https://github.com/amittkSharma/provenance-guard/commit/66150030f196cb53eb72383f108a50442b8d73a2))
- workspace attribution and recursive lockfile discovery ([2e4f661](https://github.com/amittkSharma/provenance-guard/commit/2e4f661a67d290e9134f46ac652fa850e47caca4))

### Bug Fixes

- close silent-pass paths found in review ([d30a465](https://github.com/amittkSharma/provenance-guard/commit/d30a465c01cefada59840599210e5a93fe21ed52))

### Documentation

- remove Learn more section from README ([ab2261a](https://github.com/amittkSharma/provenance-guard/commit/ab2261aba0f09e578324e03774f4eae9ebde9fb8))
- use absolute GitHub URLs in README so images and links work on npmjs.com ([9acb659](https://github.com/amittkSharma/provenance-guard/commit/9acb65936cceead5cc65c70e5859515330635f95))
