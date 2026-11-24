The same monorepo in every lockfile format:

- `.` (root): devDependency typescript@5.6.3
- `apps/web`: chalk@4.1.2 + workspace package `ui`
- `packages/ui`: chalk@5.3.0 + debug@4.4.1 (which depends on ms@2.1.3)

Expected attribution: typescript → `.`; chalk@4.1.2 → `apps/web`; chalk@5.3.0, debug, ms → `apps/web`, `packages/ui`.
