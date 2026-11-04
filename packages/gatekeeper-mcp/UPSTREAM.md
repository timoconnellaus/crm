# Upstream: `@crm/gatekeeper-mcp` (Worker `crm-gatekeeper-mcp`)

| | |
| --- | --- |
| Upstream | [cloudflare/cloudflare-os](https://github.com/cloudflare/cloudflare-os) `packages/gatekeeper-mcp` (`@gadgets/mcp-gatekeeper`, Worker `gatekeeper-mcp`) |
| Commit | `a3ba4746b58f1ef8e2252f8bac6b6377099202f0` (2026-11-03) |
| Licence | Apache-2.0 (`LICENSE`, `NOTICE`) |

Lets a user connect any MCP server by URL. Read-only tools (`readOnlyHint`) run as observations;
every other tool call is queued for approval.

## What we take

`src/**` (except `src/generated/`), `__tests__/**` and `README.md`, copied by
`scripts/vendor-gatekeepers.mjs`. These are upstream-owned: don't edit them by hand.

## Local modifications

- **Scope rename.** `@gadgets/*` imports point at `@crm/gatekeeper-interface`,
  `@crm/gatekeeper-kit`, `@crm/mcp-shared`, `@crm/gatekeeper-observability` and
  `@crm/gatekeeper-configurator-ui`. The 11 source files this touched start with a
  `// Vendored from cloudflare/cloudflare-os@… Modified locally` comment.
- **Worker config.** Upstream generates `wrangler.jsonc` from `cloudflare.config.ts` with
  `@gadgets/scripts/worker-config`. We removed `cloudflare.config.ts` and keep `wrangler.jsonc`
  by hand, with upstream's settings (compatibility date and flags, `MCP_ALLOW_INSECURE`, the
  capnweb-validate build, Text module rules, DO migrations) plus: name `crm-gatekeeper-mcp`,
  `workers_dev: false` and `preview_urls: false`. No account IDs.
- **Types.** `worker-configuration.d.ts` is regenerated with our wrangler by `pnpm types`
  (`scripts/gatekeeper-worker-types.mjs`, a port of upstream's post-processing). Because
  `src/env.d.ts` declares `GlobalProps`, it holds runtime types only, as upstream's does.
- **Replaced (ours):** `package.json` (scope, exact versions, Turborepo scripts, `vite` pinned to
  `7.3.6` for the tests: Vite 8's Oxc does not lower the decorators capnweb-validate emits, which
  upstream works around the same way) and `tsconfig.json`.
- **Removed:** `vite.config.ts` (Vite+ tasks, including `build:configurator`).
- **Tests.** Upstream's `__tests__` run in Node (`vitest.config.ts`), as upstream's defaults run
  them. Added `test/vendor.test.ts` with `vitest.worker.config.ts`: a workerd smoke test that loads
  the Worker with its real `wrangler.jsonc` and calls `GatekeeperVendor.describe()`,
  `getSupportedResources()` and `getTypeScriptTypes()`.

## Shims

| File | Stands in for |
| --- | --- |
| `src/generated/server-configurator-ui.txt` | The configurator frame upstream builds from `src/configurator/server-configurator-ui.tsx` with the configurator-ui runtime. An inert placeholder page; see [`../gatekeeper-configurator-ui/UPSTREAM.md`](../gatekeeper-configurator-ui/UPSTREAM.md). |

## Pulling upstream changes

Follow the procedure in [`../gatekeeper-kit/UPSTREAM.md`](../gatekeeper-kit/UPSTREAM.md#pulling-upstream-changes).
Compare upstream's generated `wrangler.jsonc` with ours by hand.
