# Upstream: `@crm/gatekeeper-interface`

| | |
| --- | --- |
| Upstream | [cloudflare/cloudflare-os](https://github.com/cloudflare/cloudflare-os) `packages/workshop-shared/src/gatekeeper.ts` and `scripts/assert-workerd.ts` |
| Commit | `a3ba4746b58f1ef8e2252f8bac6b6377099202f0` (2026-11-03) |
| Licence | Apache-2.0 (`LICENSE`, `NOTICE`) |

The canonical gatekeeper RPC interface: `GatekeeperVendor`, `GatekeeperUser`, `Gatekeeper`,
`ApprovalQueue`, `ObservationDescription`, `ActionDescription`, hooks and the git cache. Our runner
implements the Workshop side of it in stage 6. See
[`docs/research/gatekeeper-interface.md`](../../docs/research/gatekeeper-interface.md).

## What we take

- `src/gatekeeper.ts`: upstream `workshop-shared/src/gatekeeper.ts`, **byte-identical**. It
  imports only types from `cloudflare:workers`.
- `testing/assert-workerd.ts`: upstream `scripts/assert-workerd.ts` (from `@gadgets/scripts`),
  byte-identical. Every vendored package's workerd test config lists it in `setupFiles`, so a pool
  that fails to start cannot pass silently in Node.

## Local modifications

- **Extracted, not the whole package.** We don't take the rest of `workshop-shared` (`api.ts`,
  the Workshop RPC; `cloudflare-gatekeeper.ts`, `code-change.ts`, `external-message-gateway.ts`,
  `feature-flags.ts`, `limits.ts`, `theme.ts`). None of the vendored gatekeepers import them.
- **Ours:** `package.json` (exports `./gatekeeper` and `./testing/assert-workerd`),
  `tsconfig.json`, `vitest.config.ts`, and `test/gatekeeper.test.ts`, a test of the module's few
  runtime helpers (upstream has none for this file).
- **No shims.**

## Pulling upstream changes

Follow the procedure in [`../gatekeeper-kit/UPSTREAM.md`](../gatekeeper-kit/UPSTREAM.md#pulling-upstream-changes).
All vendored packages move together.
