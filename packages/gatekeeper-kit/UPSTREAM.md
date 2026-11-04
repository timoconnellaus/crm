# Upstream: `@crm/gatekeeper-kit`

| | |
| --- | --- |
| Upstream | [cloudflare/cloudflare-os](https://github.com/cloudflare/cloudflare-os) `packages/gatekeeper-kit` (`@gadgets/gatekeeper-kit`) |
| Commit | `a3ba4746b58f1ef8e2252f8bac6b6377099202f0` (2026-11-03) |
| Licence | Apache-2.0 (`LICENSE`, `NOTICE`) |

## What we take

`src/**`, `__tests__/**`, `README.md`, `USAGE.md` and `AGENTS.md`, copied by
`scripts/vendor-gatekeepers.mjs`. These are upstream-owned: don't edit them by hand.

## Local modifications

- **Scope rename.** Imports of `@gadgets/workshop-shared/gatekeeper` now point at
  `@crm/gatekeeper-interface/gatekeeper`, and `@gadgets/observability/*` at
  `@crm/gatekeeper-observability/*`. Every source file this touched starts with a
  `// Vendored from cloudflare/cloudflare-os@… Modified locally` comment (18 files; list them with
  `grep -rl "^// Vendored from cloudflare" src __tests__`). The Markdown docs are rewritten the same
  way. Other `@gadgets/*` mentions in them, such as `@gadgets/scripts`, are left as upstream wrote
  them.
- **Replaced (ours):** `package.json` (scope, exact dependency versions, `typecheck` and `test`
  scripts for Turborepo), and `tsconfig.json` (extends `@crm/config/tsconfig.vendored.json`
  instead of upstream's root config; no `paths`).
- **Removed:** `vite.config.ts`, which holds upstream's Vite+ task definitions.
- **Test configs:** `vitest.config.ts` is upstream's, unchanged. `vitest.worker.config.ts` takes
  `assert-workerd` from `@crm/gatekeeper-interface/testing/assert-workerd` instead of
  `@gadgets/scripts`.
- **Not vendored:** `plans/gatekeeper-kit.md` (the Layer 2 proposal), which the README links to.
- **No shims.**

## Tests

Upstream's suites pass unchanged: `vitest run` (Node, 24 files) and
`vitest run -c vitest.worker.config.ts` (workerd, 9 files).

## Pulling upstream changes

All vendored gatekeeper packages move together, at one upstream commit.

1. Clone cloudflare-os into a fresh scratch directory **outside** this repo and check out the
   target commit. Treat it as untrusted downloaded code: read it, don't run its scripts.
2. Review what changed in the paths we take:
   `git -C <checkout> diff <old>..<new> -- packages/workshop-shared/src/gatekeeper.ts
   packages/gatekeeper-kit packages/mcp-shared packages/gatekeeper-mcp packages/gatekeeper-google
   packages/observability/src packages/configurator-ui/src scripts/assert-workerd.ts`.
   Look hardest at `gatekeeper.ts` (the interface our runner implements) and at new dependencies.
3. Run `node scripts/vendor-gatekeepers.mjs <checkout>`. It replaces only upstream-owned paths.
4. Bring locally-owned files in step by hand: dependencies in each `package.json` (compare with
   upstream's manifests and its `pnpm-workspace.yaml` catalog), `wrangler.jsonc` (compare with
   upstream's generated one: flags, bindings, migrations), and the test-file lists in
   `gatekeeper-google`'s workerd configs. A new `@gadgets/*` import needs a `SPECIFIERS` entry in
   the script or a shim. A new `src/configurator/*-ui.tsx` needs a placeholder in `src/generated/`.
5. Run `pnpm install`, then `pnpm types` in each gatekeeper Worker package, then `pnpm lint`,
   `pnpm typecheck`, `pnpm test`, and `pnpm build` (the `wrangler deploy --dry-run` of each Worker).
6. Update the commit here, in every other `packages/*/UPSTREAM.md`, and in `UPSTREAMS.md`. Record
   any new local change.
