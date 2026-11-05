# ADR 0160: Release manifest and bundle format

Status: accepted, 2026-11-05 (stage 8 build). Implements ADR 0053.

## Context
ADR 0053 asks for byte-identical bundles of every Worker plus assets and a manifest with placeholders,
following Cloudflare OS's `scripts/release` (`manifest-lib.ts`, `hash-lib.ts`, the golden-file test).
Stages 5 and 7a add bindings (Queues, Vectorize, Workflows) in parallel, so the manifest must not be
a hand-kept list.

## Decision
- **Generated, not written.** `scripts/release/manifest-lib.ts` reads every `apps/*/wrangler.jsonc`
  and `packages/*/wrangler.jsonc` (crm-app, crm-runner, every gatekeeper) and turns each binding
  into its Workers script-upload metadata shape (D1 `database_id`, R2 `bucket_name`, KV
  `namespace_id`, `service`, `durable_object_namespace`, `workflow`, `queue`, `vectorize`, `ai`,
  `ratelimit`, `worker_loader`, `send_email`, `version_metadata`, `browser`, `analytics_engine`,
  `plain_text`/`json` vars, `secret_text` secrets), plus resources to provision, crons, Durable
  Object migration history and queue consumers. A wrangler key it does not know **fails the build**
  (as upstream's `HANDLED_CONFIG_KEYS`), so a new kind of setting needs a decision.
  Shapes: [multipart upload metadata](https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/),
  [script upload](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/).
- **Secrets and inputs** come from `secrets.required` in wrangler.jsonc (required), the Deploy
  button's `cloudflare.bindings` descriptions in package.json (optional), and a gatekeeper's
  `deploy-inputs.json` (as upstream). Each becomes a `secret_text` binding `$SECRET(NAME)` with a
  source: generated (BETTER_AUTH_SECRET), installer (BETTER_AUTH_URL, CRM_UPDATE_TOKEN, Access) or
  user.
- **Placeholders** (closed list, `MANIFEST_VERSION` 1): `$ACCOUNT_ID`, `$HOSTNAME`, `$SECRET(…)`,
  `$WORKER_NAME(…)`, `$D1_ID(…)`, `$KV_ID(…)`, `$R2_NAME(…)`, `$QUEUE_NAME(…)`,
  `$VECTORIZE_NAME(…)`. The renderer refuses anything else. `assertUnresolved` fails a build whose
  bindings carry a 32-hex id, a workers.dev host or a non-placeholder resource reference (AC1).
  Release-time vars: crm-app's `CRM_RELEASE_VERSION` (the version) and `CRM_ACCOUNT_ID`
  (`$ACCOUNT_ID`); crm-runner's `APP_ORIGIN` and gatekeepers' `BASE_URL` (`https://$HOSTNAME…`).
- **Also in the manifest:** core migrations with sha256, `CORE_SCHEMA_VERSION`, the extension
  contract (`CONTRACT_VERSION` and supported versions from `packages/sdk`), the repository, commit
  and pinned wrangler version. No build time, so it is reproducible.
- **Bundle:** one deterministic `crm-<version>.tar.gz`: `manifest.json`, `modules/<sha256>`,
  `assets/<asset hash>`, `migrations/<name>`. Entries are sorted, headers have mode 0644, uid/gid 0
  and mtime 0, and the gzip header's time and OS bytes are pinned. Modules are wrangler's own
  `deploy --dry-run --outdir` output (source maps dropped); crm-app's assets are `dist/client`
  minus `.assetsignore`. Asset keys are SHA-256 of base64(contents) + extension, 32 hex, as in
  upstream's `hash-lib` (the upload API treats the key as opaque:
  [direct upload](https://developers.cloudflare.com/workers/static-assets/direct-upload/)).
- Opening a bundle checks every file against the manifest's hashes and refuses extra files and
  unsafe paths, so a swapped module is caught even inside a bundle whose outer digest someone made
  match.
- **Tests:** a golden file (`scripts/release/test/testdata/golden-manifest.json`, regenerate with
  `UPDATE_GOLDEN=1`) generated from the real configs with fixture modules; tests that a queue and an
  index added to a config reach the manifest unchanged, that unknown keys fail, and that two
  builds of the same inputs hash identically. The release workflow builds twice (the second
  uncached) and diffs SHA256SUMS.

## Differences from Cloudflare OS
One tarball instead of an R2 mirror (we publish to GitHub Releases, ADR 0161); several ESM modules
per Worker are allowed (TanStack Start emits chunks); resources are listed explicitly; secrets carry a
source; no router or asset variants.

## Consequences
- Any change to a Worker's config fails the golden test until the golden file is regenerated and
  reviewed: a deliberate pause to think about installed deployments.
- KV namespaces, which wrangler provisions by binding, are named `<worker>-<binding>` in releases
  (`crm-app-oauth-kv`).

## Amendment, 2026-11-05: stage 7a's optional AI bindings
Stage 7a's `ai` and `vectorize` bindings are remote-only, so the committed `wrangler.jsonc` files
leave them out and `scripts/deploy.mjs` adds them to a git-ignored `wrangler.deploy.jsonc`
(ADR 0156). The generator does not read that file. Instead:

- `apps/app/deploy-inputs.json` and `apps/runner/deploy-inputs.json` declare them under
  `features.ai`, and `apps/app/deploy-inputs.json` `vectorize` says how `crm-records` is created
  (384 dimensions, cosine, a string metadata index on `object`). `scripts/deploy.mjs` reads the
  same files, so both deploy paths install the same thing.
- In the manifest those bindings and the index carry `feature: "ai"`. The deploy engine uploads
  them, and provisions the index, only when the deployment's `ai` state is not `false`. It strips
  the tag before the upload. `create-crm --ai off` (or `CRM_AI=off`) records `ai: false` in
  `core_install`, so upgrades and the self-updater keep the choice.
- A feature may only add the binding kinds the generator lists (`ai`, `vectorize`). Any other key
  fails the build, as unknown wrangler keys do.
- `CLOUDFLARE_ACCOUNT_ID` (a stage 7a var) is templated to `$ACCOUNT_ID`. `AI_GATEWAY_ID` is an
  installer input (`--ai-gateway`). Settings → AI's `CLOUDFLARE_API_TOKEN` and `AI_GATEWAY_TOKEN`
  are optional secrets from `deploy-inputs.json`.
- Updates now create any resource the target release needs that the deployment does not have yet,
  before switching Workers (ADR 0164, step 4). That covers a release that adds a queue or an index,
  and AI turned on by a re-install.

> Amended 2026-11-05 ([ADR 0180](0180-ai-gateway-provisioned-per-deployment.md)): the manifest
> has an optional top-level `aiGateway` block, copied from `apps/app/deploy-inputs.json`: the
> gateway's settings and its custom providers. `AI_GATEWAY_ID` defaults to a gateway named after
> the install, which the installer and the updater create. `AI_GATEWAY_TOKEN` is generated by the
> installer (its source is `installer`).
