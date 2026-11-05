# Contributing to Relationship OS

Thanks for helping. This page is for people; coding agents also follow [`AGENTS.md`](AGENTS.md).

## Before you start

- Read [`docs/architecture.md`](docs/architecture.md) and use the words in
  [`CONTEXT.md`](CONTEXT.md). Significant decisions are recorded in [`docs/adr/`](docs/adr/).
- For anything bigger than a small fix, open an issue first so we can agree on the approach.

## Licence and the CLA

Relationship OS is licensed under FSL-1.1-ALv2 (see [`LICENSE`](LICENSE) and the licence section of
the [`README`](README.md)). Every contributor signs the [Contributor License Agreement](CLA.md) once.
On your first pull request the CLA bot posts a comment; reply with the sentence it gives you, and
the check turns green. You keep the copyright in your work; the CLA lets the project use it under
the FSL and also under commercial and enterprise terms.

Vendored code (the packages listed in [`UPSTREAMS.md`](UPSTREAMS.md)) keeps its own licence.
Changes to it go upstream where possible, and local changes are recorded in `UPSTREAMS.md`.

## Working on the code

You need Node 24 (`.nvmrc`) and pnpm 10.

```sh
pnpm install
pnpm dev                    # the app on http://localhost:5173, with the runner and a local D1
pnpm lint && pnpm typecheck && pnpm test
```

- Every user action is an **operation** in `packages/core` with zod schemas, a description, a
  permission and a risk class. UI, MCP and extension code call operations, never D1 directly.
- Tests run in workerd. Prefer integration tests against real bindings over mocks.
- Biome formats and lints (`pnpm format`). TypeScript is strict.
- Never commit secrets, account IDs or `.dev.vars`.

## Pull requests

- Branch from `main`, keep commits focused, and open a pull request against `main`.
- CI (lint, typecheck, tests, build and the end-to-end suite) and the CLA check must be green.
- Describe what changed and why, and anything you deliberately left out.
