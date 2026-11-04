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
  gatekeeper. The CRM renders the configurator modules natively instead (stage 6): the app aliases
  this package to its own React runtime built from `@crm/ui`'s shadcn components
  (`apps/app/src/components/integrations/configurator/runtime.tsx`, wired up by `vite-plugin.ts`
  there) and drives each gatekeeper's `ui` capability through the server. The modules themselves
  stay unchanged; they are still type-checked and unit-tested in their own packages.
- **Ours:** `package.json`, `tsconfig.json`, `vitest.config.ts` (Node, as upstream).

## Generated frames in place of this package's build

The gatekeepers still import their frames (`src/generated/<name>-configurator-ui.txt`, which
`startResourceConfigurator()` returns as `iframeHtml`). Those files are generated, not committed:
`src/generated/` is git-ignored in every gatekeeper, and `scripts/gatekeeper-configurator-frames.mjs`
writes a tiny document naming the spec for every frame the vendored sources import (16 across
`gatekeeper-{mcp,google,microsoft,slack,email,zoominfo}`). Each gatekeeper's `typecheck`, `test` and
`build` run it first, as does `scripts/dev-setup.mjs`. This package's `test` runs it with `--check`,
which fails if git tracks a frame or would not ignore one. The CRM never shows these documents.

## Pulling upstream changes

Follow the procedure in [`../gatekeeper-kit/UPSTREAM.md`](../gatekeeper-kit/UPSTREAM.md#pulling-upstream-changes).
