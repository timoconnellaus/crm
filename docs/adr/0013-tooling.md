# ADR 0013: Repo tooling

Status: accepted, 2026-11-04 (stage 0 architecture interview).

## Decision
- A pnpm workspaces monorepo with Turborepo.
- TypeScript in strict mode.
- **Biome** for lint and format.
- **Vitest** with `@cloudflare/vitest-pool-workers` for unit and integration tests, so D1, DOs and Workflows run in workerd.
- **Playwright** for end-to-end tests.
- UI is shadcn/ui on TanStack Start, with shared components in `packages/ui`.
