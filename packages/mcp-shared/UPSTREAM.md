# Upstream: `@relationship-os/mcp-shared`

| | |
| --- | --- |
| Upstream | [cloudflare/cloudflare-os](https://github.com/cloudflare/cloudflare-os) `packages/mcp-shared` (`@gadgets/mcp-shared`) |
| Commit | `a3ba4746b58f1ef8e2252f8bac6b6377099202f0` (2026-11-03) |
| Licence | Apache-2.0 (`LICENSE`, `NOTICE`) |

## What we take

`src/**`, `__tests__/**`, `README.md` and `AGENTS.md`, copied by
`scripts/vendor-gatekeepers.mjs`. These are upstream-owned: don't edit them by hand.

## Local modifications

- **Scope rename.** `@gadgets/workshop-shared/gatekeeper`, `@gadgets/gatekeeper-kit/*` and
  `@gadgets/observability/*` imports point at `@relationship-os/gatekeeper-interface/gatekeeper`,
  `@relationship-os/gatekeeper-kit/*` and `@relationship-os/gatekeeper-observability/*`. The 10 source files this touched
  start with a `// Vendored from cloudflare/cloudflare-os@… Modified locally` comment.
- **Replaced (ours):** `package.json` (scope, exact versions; `typescript6` stays an alias of
  `typescript@6.0.3` because a test imports it by that name), `tsconfig.json` and
  `tsconfig.test.json` (extend `@relationship-os/config/tsconfig.vendored.json`, and use
  `@cloudflare/workers-types/experimental` instead of a committed `worker-configuration.d.ts`:
  this library has no Worker config, so the upstream file held runtime types only).
- **Removed:** `vite.config.ts` (Vite+ tasks) and `worker-configuration.d.ts`.
- **Test config:** `vitest.config.ts` is upstream's, unchanged (Node, with its
  `cloudflare:workers` stub).
- Upstream also uses this library for `gatekeeper-mcp-portal`, which we don't vendor.
- **No shims.**

## Pulling upstream changes

Follow the procedure in [`../gatekeeper-kit/UPSTREAM.md`](../gatekeeper-kit/UPSTREAM.md#pulling-upstream-changes).
