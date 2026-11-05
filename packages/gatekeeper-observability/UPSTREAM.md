# Upstream: `@relationship-os/gatekeeper-observability`

| | |
| --- | --- |
| Upstream | [cloudflare/cloudflare-os](https://github.com/cloudflare/cloudflare-os) `packages/observability` (`@gadgets/observability`) |
| Commit | `a3ba4746b58f1ef8e2252f8bac6b6377099202f0` (2026-11-03) |
| Licence | Apache-2.0 (`LICENSE`, `NOTICE`) |

The structured Worker logger the vendored gatekeepers log through (`createLogger`,
`createObservabilityContext`). Named `gatekeeper-observability` so it is not mistaken for the CRM's
own observability, which is not decided yet.

## What we take

`src/logger.ts`, `src/logger-core.ts`, `src/observability-context.ts`,
`src/node-async-hooks.d.ts` and `__tests__/logger.test.ts`, all byte-identical.

## Local modifications

- **Subset only.** Not taken: `error-reporting.ts` (and its `@gadgets/error-reporting`
  dependency), `metrics.ts`, `metrics-schema.ts`, `tracing.ts`, their tests and `AGENTS.md`. The
  gatekeepers import only `./logger` and `./observability-context`.
- **Ours:** `package.json` (exports only those two), `tsconfig.json`, and `vitest.config.ts`,
  which drops upstream's error-reporter and tail-worker fixtures (only the modules we don't take
  use them) and keeps the `nodejs_als` flag the context needs.
- **No shims.**

## Pulling upstream changes

Follow the procedure in [`../gatekeeper-kit/UPSTREAM.md`](../gatekeeper-kit/UPSTREAM.md#pulling-upstream-changes).
If a gatekeeper starts importing another `@gadgets/observability/*` module, add it to
`scripts/vendor-gatekeepers.mjs` and to `exports` here.
