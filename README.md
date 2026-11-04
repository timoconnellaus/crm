# CRM

An AI-native CRM that runs in your own Cloudflare account. Claude can drive everything through MCP,
including reshaping the CRM itself: custom objects, dashboards and automations are code that AI
writes, you approve, and the CRM runs safely.

> Early development. See [`docs/roadmap.md`](docs/roadmap.md).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/timoconnellaus/crm/tree/main/apps/app)

## Install

```sh
npx create-crm        # or: pnpm dlx create-crm
```

The CLI asks for a scoped Cloudflare API token, your account and hostname (`workers.dev` or your own
domain) and the sign-in method, downloads a release, **verifies its sha256 and its GitHub build
attestation**, then provisions D1, R2 and KV, uploads the Workers, sets secrets, runs migrations and
prints the URL. Re-running it repairs an install. Update from **Settings → Updates** (with an optional
stored token) or with `npx create-crm upgrade`; roll back from either. Requires Workers Paid.

The Deploy button above is the developer path: it forks the repository and deploys from source.
Details, token permissions, rollback and the manual route: [`docs/deploying.md`](docs/deploying.md).

## Privacy: no telemetry

The CRM never phones home. A deployment sends nothing about itself, its users or its data to us or
anyone else. The only outbound request it makes on its own is reading the **public GitHub Releases**
of this repository (cached for an hour) when an admin opens Settings → Updates; the installer and
`crm upgrade` talk only to the Cloudflare API with your token and to GitHub Releases. AI calls go to
Workers AI in your own account unless you configure another provider. See ADR 0166.

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
| `node scripts/release/build-release.ts --version X.Y.Z` | Build a release bundle locally ([`scripts/release`](scripts/release/README.md)) |

## Layout

- `apps/app`: `crm-app` Worker (TanStack Start + shadcn/ui)
- `apps/runner`: `crm-runner` Worker (Workflows, Worker Loader, extension runtime)
- `packages/*`: `core`, `db`, `auth`, `sdk`, `ui`, `config`, `release` (bundles, verification,
  the Cloudflare API deploy engine), `create-crm` (the installer CLI), `gatekeeper-*`
- `scripts/release`: the release build, manifest generator (golden-tested) and changelog

## Docs

- Architecture: [`docs/architecture.md`](docs/architecture.md)
- Decisions: [`docs/adr/`](docs/adr/)
- Glossary: [`CONTEXT.md`](CONTEXT.md)
- Contributing / agents: [`AGENTS.md`](AGENTS.md)
