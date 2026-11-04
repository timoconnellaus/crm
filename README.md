# CRM

An AI-native CRM that runs in your own Cloudflare account. Claude can drive everything through MCP,
including reshaping the CRM itself: custom objects, dashboards and automations are code that AI
writes, you approve, and the CRM runs safely.

> Early development. See [`docs/roadmap.md`](docs/roadmap.md).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/timoconnellaus/crm/tree/main/apps/app)

The button deploys both Workers (`crm-app`, `crm-runner`) and the `crm` D1 database to your
account. Requires Workers Paid. Details and the manual route: [`docs/deploying.md`](docs/deploying.md).

## Develop

Needs Node 24 (`.nvmrc`) and pnpm 10.

```sh
pnpm i
pnpm dev          # crm-app on http://localhost:5173, with crm-runner and local D1
```

`pnpm dev` creates `apps/*/.dev.vars` from the examples on first run and applies migrations to the
local database. Sign up at `/sign-in` (open locally), and see `/status` for health.

| Command | What it does |
| --- | --- |
| `pnpm lint` / `pnpm format` | Biome check / fix |
| `pnpm typecheck` | `wrangler types --check` + `tsc` in every package |
| `pnpm test` | Vitest in workerd (`@cloudflare/vitest-plugin`) for every Worker and package |
| `pnpm test:e2e` | Playwright smoke test against `vite dev` |
| `pnpm run deploy` | Deploy both Workers and apply migrations ([`docs/deploying.md`](docs/deploying.md)) |

## Layout

- `apps/app`: `crm-app` Worker (TanStack Start + shadcn/ui)
- `apps/runner`: `crm-runner` Worker (Workflows, Worker Loader, extension runtime)
- `packages/*`: `core`, `db`, `auth`, `sdk`, `ui`, `config`

## Docs

- Architecture: [`docs/architecture.md`](docs/architecture.md)
- Decisions: [`docs/adr/`](docs/adr/)
- Glossary: [`CONTEXT.md`](CONTEXT.md)
- Contributing / agents: [`AGENTS.md`](AGENTS.md)
