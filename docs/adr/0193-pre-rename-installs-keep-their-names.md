# ADR 0193: Installs from before the rename keep their deployed names

Status: accepted, 2026-11-05 (Stage 9).

## Context
ADR 0190 renamed everything (`crm-app` → `ros-app`, the D1 database `crm` → `ros`, `crm-*` resources
→ `ros-*`, assets `crm-<version>.tar.gz` → `relationship-os-<version>.tar.gz`, product `crm` →
`relationship-os`, repo `timoconnellaus/crm` → `timoconnellaus/relationship-os`) and assumed no
installs existed. An install made from a pre-rename release, or from source, may still exist.
Renaming a deployed Worker orphans its Durable Objects (extension workspaces, integration hosts,
webhook endpoints); renaming a database, bucket, queue, index or Workflow orphans its data. A
deploy engine that only knows the new names would create a second, empty deployment next to the
old one.

## Decision
- **Nothing deployed is ever renamed.** A pre-rename install keeps `crm-*` for good. The deployment
  state maps the new manifest names onto the deployed ones: `workerNames` (existing) and a new
  `resourceNames` (D1, R2, KV, queues, Vectorize, Workflows).
- `adoptLegacyNames` (`packages/release/src/legacy.ts`) recognises a pre-rename state by its
  resource keys (`D1_ID(crm)`, …) or gatekeeper names, and re-keys it once: the install, repair and
  update paths all call it. It is a no-op for renamed states and for pre-rename manifests.
- **The first update across the rename runs from the new CLI.** Old updaters and the old CLI refuse
  the renamed release because its product is no longer `crm`, so they change nothing. The new code
  still reads pre-rename releases (product `crm`, `crm-<version>.*` assets, attestations built in
  `timoconnellaus/crm`), so rollback across the rename works.
- `locateDeployment` finds the `crm` database when there is no `ros` one. The self-updater reads
  `CRM_UPDATE_TOKEN` when `ROS_UPDATE_TOKEN` is unset; the CLI and `scripts/deploy.mjs` read the
  old `CRM_*` variables when the `ROS_*` ones are unset; `ROS_LEGACY_NAMES=on` keeps source deploys
  on the old names, and `deploy.mjs` refuses to create `ros-app` next to an existing `crm-app`.
- Extension source importing `@crm/sdk` still checks and builds. Applied migrations keep their
  original bytes, so their comments still say `@crm/*`.
- The API names inside extension code and SQL are domain words, not the product name, and stay:
  `codemode:crm`, `ctx.crm`, the `crm_*` views, `crm://schema`.

## Consequences
Old names live on in pre-rename accounts and in `legacy.ts`. Tests cover the update, a second
update, and a rollback of a pre-rename install (`packages/release/test/legacy.test.ts`) and the CLI
path with the old environment variables (`packages/create-relationship-os/test/cli.test.ts`).
