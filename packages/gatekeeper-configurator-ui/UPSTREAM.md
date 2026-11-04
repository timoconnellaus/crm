# Upstream: `@crm/gatekeeper-configurator-ui`

| | |
| --- | --- |
| Upstream | [cloudflare/cloudflare-os](https://github.com/cloudflare/cloudflare-os) `packages/configurator-ui` (`@gadgets/configurator-ui`) |
| Commit | `a3ba4746b58f1ef8e2252f8bac6b6377099202f0` (2026-11-03) |
| Licence | Apache-2.0 (`LICENSE`, `NOTICE`) |

The authoring API that gatekeeper resource-configurator modules (`src/configurator/*-ui.tsx` in
`gatekeeper-mcp` and `gatekeeper-google`) import: types plus component stubs (`h`, `Section`,
`Field`, `HierarchyPicker`, …) that throw if called outside the sandbox runtime.

## What we take

`src/index.ts`, `src/runtime/options.ts` and `src/runtime/options.test.ts`, byte-identical.

## Local modifications

- **Not vendored: the sandbox runtime and the frame build.** Upstream renders each configurator
  module in a sandboxed iframe with Kumo components on Preact and Tailwind, bundled by
  `build/` and `scripts/build-gatekeeper-configurator.ts` into `src/generated/*.txt` in each
  gatekeeper. That pulls in React/Preact, Kumo, Tailwind, esbuild and a browser test suite, and it
  is UI the CRM may well render its own way. Instead, each gatekeeper Worker commits
  **placeholder frames** (see the shim below). The configurator modules are still type-checked
  and unit-tested, so they stay ready to build.
- **Ours:** `package.json`, `tsconfig.json`, `vitest.config.ts` (Node, as upstream).

## Shims that stand in for this package's build

| Shim | Stands in for |
| --- | --- |
| `packages/gatekeeper-mcp/src/generated/server-configurator-ui.txt` | the frame built from `src/configurator/server-configurator-ui.tsx` |
| `packages/gatekeeper-google/src/generated/{bigquery,calendar,chat-account,chat-space,chat-thread,drive,gmail}-configurator-ui.txt` | the frames built from the matching `src/configurator/*-ui.tsx` |

Each is the same inert HTML page with a `SHIM` comment. `startResourceConfigurator()` returns it, so
the Workshop-side picker cannot work until stage 6 decides how the CRM picks resources (vendor the
runtime, or render the configurator spec in our own React UI).

## Pulling upstream changes

Follow the procedure in [`../gatekeeper-kit/UPSTREAM.md`](../gatekeeper-kit/UPSTREAM.md#pulling-upstream-changes).
