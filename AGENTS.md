# AGENTS.md

An AI-native, self-hosted CRM on Cloudflare. Start with [`docs/architecture.md`](docs/architecture.md),
use the vocabulary in [`CONTEXT.md`](CONTEXT.md), and respect the decisions in
[`docs/adr/`](docs/adr/).

## Working in a stage

- You will be pointed at a stage spec in `docs/stages/`. Build what it says. Its acceptance criteria
  are the definition of done.
- If the spec turns out to be wrong or ambiguous, don't silently diverge. Stop and ask, or record the
  deviation and why in the PR description.
- A new significant decision gets an ADR (`docs/adr/NNNN-title.md`, next free number). If a decision
  changes, amend the old ADR with a dated note rather than deleting it.
- Keep `docs/architecture.md` and `CONTEXT.md` true when you change what they describe.

## Rules that hold everywhere

- **Operations first.** Anything a user can do is an operation in the registry (`packages/core`) with
  zod schemas, a model-facing description, a permission and a risk class. UI, MCP and extension code
  call operations. They never write to D1 directly.
- **Core vs extension schema.** Core tables are `core_*` and change only via migrations in
  `packages/db`. Never touch `x_*` tables from migrations.
- **No ambient authority for extension code.** Dynamic workers run with `globalOutbound: null` and
  get only host modules. External access goes only through gatekeepers.
- **Identity and policy are not AI-configurable.** Auth secrets are env-only. Loosening approval
  policy is human-admin-only.
- **Code asks for a model role, never a model id.**
- Vendored code (see `UPSTREAMS.md`) is edited deliberately. Note local changes in `UPSTREAMS.md`.

## Tooling

- pnpm + Turborepo. Run `pnpm lint`, `pnpm typecheck` and `pnpm test` before pushing.
- Biome formats and lints. Don't add ESLint or Prettier.
- Tests run in workerd via `@cloudflare/vitest-pool-workers`. Prefer integration tests against real
  bindings over mocks.
- TypeScript strict. No `any` without a comment saying why.
- Generate Worker `Env` types with `wrangler types`. Don't hand-write them.

## Git

- Work on a branch, open a PR against `main`, and keep commits focused.
- Don't commit account IDs, secrets or `.dev.vars`.
