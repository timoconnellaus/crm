# Relationship OS

An AI-native CRM that runs in your own Cloudflare account. Claude can drive everything through MCP,
including reshaping Relationship OS itself: custom objects, dashboards and automations are code that
AI writes, you approve, and Relationship OS runs safely. Website:
[relationshiposcrm.com](https://relationshiposcrm.com).

> Early development. See [`docs/roadmap.md`](docs/roadmap.md).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/timoconnellaus/relationship-os/tree/main/apps/app)

## Install

```sh
# Not on npm yet: run the CLI from a checkout (docs/deploying.md)
pnpm install && pnpm --filter create-relationship-os build
node packages/create-relationship-os/dist/cli.js
```

The CLI asks for a scoped Cloudflare API token, your account and hostname (`workers.dev` or your own
domain) and the sign-in method, downloads a release, **verifies its sha256 and its GitHub build
attestation**, then provisions D1, R2 and KV, uploads the Workers, sets secrets, runs migrations and
prints the URL. Re-running it repairs an install. Update from **Settings → Updates** (with an optional
stored token) or with `npx create-relationship-os upgrade`; roll back from either. Requires Workers Paid.

The Deploy button above is the developer path: it forks the repository and deploys from source.
Deploying from a checkout for the first time: [`docs/first-deploy.md`](docs/first-deploy.md). Details,
token permissions, rollback and the other routes: [`docs/deploying.md`](docs/deploying.md).

## Privacy: no telemetry

Relationship OS never phones home. A deployment sends nothing about itself, its users or its data to us or
anyone else. The only outbound request it makes on its own is reading the **public GitHub Releases**
of this repository (cached for an hour) when an admin opens Settings → Updates; the installer and
`ros upgrade` talk only to the Cloudflare API with your token and to GitHub Releases. AI calls go to
Workers AI in your own account unless you configure another provider. See ADR 0166.

## Develop

Needs Node 24 (`.nvmrc`) and pnpm 10.

```sh
pnpm i
pnpm dev          # ros-app on http://localhost:5173, with ros-runner and local D1
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

- `apps/app`: `ros-app` Worker (TanStack Start + shadcn/ui)
- `apps/runner`: `ros-runner` Worker (Workflows, Worker Loader, extension runtime)
- `packages/*`: `core`, `db`, `auth`, `sdk`, `ui`, `config`, `release` (bundles, verification,
  the Cloudflare API deploy engine), `create-relationship-os` (the installer CLI), `gatekeeper-*`
- `scripts/release`: the release build, manifest generator (golden-tested) and changelog

- `apps/marketing`: the static landing page for relationshiposcrm.com

## Docs

- Architecture: [`docs/architecture.md`](docs/architecture.md)
- Decisions: [`docs/adr/`](docs/adr/)
- Glossary: [`CONTEXT.md`](CONTEXT.md)
- Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md) (people) and [`AGENTS.md`](AGENTS.md) (agents)

## Licence

Relationship OS is [fair source](https://fair.io): its code is published under the
**Functional Source License, Version 1.1, ALv2 Future License** ([`LICENSE`](LICENSE),
FSL-1.1-ALv2). In plain English:

- **You may** use it for free, including in production for your own organisation, read it, change
  it, self-host it, and redistribute it with the licence attached. Consultants may run it for their
  clients.
- **You may not** offer it, or something built from it, to others as a commercial product or
  service that competes with Relationship OS (for example, a hosted CRM sold to other companies).
- **Every release becomes Apache-2.0 two years after it is published**, with no restrictions left.
- Code published before the relicensing stays available under Apache-2.0, and vendored third-party
  code keeps its own licence. [`NOTICE`](NOTICE) says exactly what is covered by which licence.

This summary is not legal advice; the [`LICENSE`](LICENSE) text is what applies. Contributions
need a signed Contributor License Agreement ([`CLA.md`](CLA.md)); a bot asks for it on your first
pull request.
