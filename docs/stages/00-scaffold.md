# Stage 0: Scaffold

Read first: [`docs/architecture.md`](../architecture.md), [`CONTEXT.md`](../../CONTEXT.md),
[`AGENTS.md`](../../AGENTS.md), ADRs [0004](../adr/0004-worker-topology.md),
[0008](../adr/0008-identity-adapters.md), [0012](../adr/0012-distribution.md),
[0013](../adr/0013-tooling.md), [0006](../adr/0006-dynamic-runtime-cloudflare-computer.md).

## Goal

An empty but real, deployable skeleton of the architecture, so every later stage only adds features.
No CRM features yet.

## Scope

### Monorepo
- pnpm workspaces + Turborepo; Node LTS pinned (`.nvmrc` / `packageManager`).
- `packages/config`: shared `tsconfig` (strict), Biome config, Vitest preset.
- Root scripts: `dev`, `build`, `typecheck`, `lint`, `format`, `test`, `test:e2e`, `deploy`.
- Workspace packages as in the [repository layout](../architecture.md#repository-layout): `apps/app`,
  `apps/runner`, `packages/core`, `packages/db`, `packages/auth`, `packages/sdk`, `packages/ui`,
  `packages/config`. Packages without stage-0 content get a README stating their purpose and an
  `index.ts` placeholder export. Don't invent APIs for later stages.

### `apps/app` → Worker `crm-app`
- TanStack Start on Cloudflare Workers (Cloudflare Vite plugin), shadcn/ui via `packages/ui`.
- App shell: sidebar layout, signed-in user menu, empty home page, light/dark theme.
- `GET /api/health` returns version, commit and the D1 migration level.
- Calls `crm-runner` over a service binding (a `ping` RPC shown on the health response).

### `apps/runner` → Worker `crm-runner`
- `WorkerEntrypoint` with a `ping` RPC.
- One hello-world Workflow, triggered from the app for the smoke test.
- **Spike** (see below), behind a dev-only route.

### Data
- D1 binding `DB` on both Workers.
- `packages/db`: migrations folder for core tables, a migration runner usable by `wrangler d1
  migrations apply` and by tests, typed access for core tables (choose Drizzle or Kysely and record
  the choice as an ADR).
- First migration: only what auth needs, plus `core_meta` (schema version).
- `core_` prefix convention enforced (a test fails on a core table without it).

### Identity (ADR 0008)
- `packages/auth`: `IdentityProvider` interface + `Principal` type.
- Better Auth adapter (default): email + Google sign-in, D1-backed.
- Cloudflare Access adapter: JWT verification against the team's JWKS.
- `IDENTITY_PROVIDER=better-auth|cloudflare-access` selects the adapter at deploy time. A middleware
  resolves the `Principal` for every server function and route.
- MCP OAuth is **not** in this stage (stage 2), but nothing should block it.

### Deploy & CI
- Self-contained `wrangler.jsonc` per Worker. No account-specific IDs committed. Secrets listed in
  `.dev.vars.example` and documented in `docs/deploying.md`.
- A "Deploy to Cloudflare" button in the README that provisions D1 and both Workers.
- GitHub Actions: lint, typecheck, unit tests, and e2e smoke on PRs.

### Tests
- Vitest with `@cloudflare/vitest-pool-workers` in each Worker (health, ping, auth middleware,
  migration runner).
- Playwright smoke: sign in (Better Auth test user), see the shell, health is green.

## Spike: `@cloudflare/computer` + Worker Loader (ADR 0006)

In `apps/runner`, create a Durable Object holding a `Workspace` with a `WorkerJavaScriptBackend`
(`globalOutbound: null`), plus one host module `codemode:crm` exposing a fake `getPerson(id)`.

Measure and write up in `docs/spikes/0001-dynamic-runtime.md`:
- cold and warm execution latency for a trivial module
- latency of one host-module call
- behaviour at the per-execution timeout
- committing a file with `codemode:git` / the host git client, then reading back the diff
- any Workers Paid limits hit

The write-up ends with a recommendation: proceed with ADR 0006 as-is, or use the fallback. The spike
code may stay behind a dev-only route, or be deleted once it's written up.

## Out of scope
CRM objects, the operations registry implementation, MCP, gatekeepers, the AI registry, release
bundles.

## Acceptance criteria
1. `pnpm i && pnpm dev` runs both Workers locally. Signing in with Better Auth shows the app shell.
2. With `IDENTITY_PROVIDER=cloudflare-access`, a request carrying a valid Access JWT is admitted, and
   one without is rejected (covered by tests).
3. `pnpm lint typecheck test` passes, and CI runs it on PRs.
4. The Playwright smoke test passes.
5. `/api/health` reports the migration level and a successful runner ping.
6. `pnpm deploy` deploys both Workers to a fresh account given only documented secrets. The Deploy
   button config is present.
7. The spike write-up exists, with numbers and a recommendation.
8. `docs/architecture.md` is updated if anything in it changed. New decisions get ADRs.
