# ADR 0013: Repo tooling

Status: accepted, 2026-11-04 (stage 0 architecture interview).

## Decision
- A pnpm workspaces monorepo with Turborepo.
- TypeScript in strict mode.
- **Biome** for lint and format.
- **Vitest** with `@cloudflare/vitest-pool-workers` for unit and integration tests, so D1, DOs and Workflows run in workerd.
- **Playwright** for end-to-end tests.
- UI is shadcn/ui on TanStack Start, with shared components in `packages/ui`.

## Amendment, 2026-11-04 (stage 0 build)
`@cloudflare/vitest-pool-workers` has been renamed to **`@cloudflare/vitest-plugin`** and the old
package no longer receives updates. We use `@cloudflare/vitest-plugin` (same integration, same
workerd runtime); the decision is unchanged. Biome's shared config lives in
`packages/config/biome-preset.json` because Biome 2 treats a nested `biome.json` as a second root.
