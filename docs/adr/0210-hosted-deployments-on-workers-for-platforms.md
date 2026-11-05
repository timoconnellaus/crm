# ADR 0210: Hosted deployments on Workers for Platforms, and the control plane

Status: accepted, 2026-11-05 (Stage 10). Builds on ADR 0191. Built and tested against fakes; not
deployed (`docs/saas-go-live.md`).

## Context
ADR 0191 decided one isolated deployment per customer in our account, on Workers for Platforms
(WfP), provisioned by the Stage 8 engine. Facts about WfP as of 2026-11-05 (developers.cloudflare.com,
`cloudflare-for-platforms/workers-for-platforms/…`):
- User Workers are uploaded with `PUT …/dispatch/namespaces/{ns}/scripts/{name}` (multipart, the
  same metadata as account scripts plus `tags`, at most 8). Secrets, settings, assets upload
  sessions and delete-by-tag exist per namespace.
- **No versions or gradual deployments for user Workers**: every upload is live at once.
- D1, KV, R2, Durable Objects, Queues (producer) and Workflows are listed as supported bindings.
  **Not documented** for user Workers: Cron Triggers, queue consumers, service bindings between two
  user Workers, Worker Loader, and Vectorize/Workers AI (in the upload schema, not in the guide).
- A dispatch Worker calls `env.DISPATCHER.get(name, …, { limits })`; a missing script throws
  "Worker not found". Routing by `*/*` on the SaaS zone covers subdomains and custom hostnames.
- Pricing: $25/month including 20M requests, 60M CPU-ms and 1,000 scripts, then $0.02 per script.
- Account limits that matter (each product's limits page): **AI Gateway 20 gateways per account**;
  KV 1,000 namespaces (then $0.10 each); D1 100,000 databases included; Queues 10,000; Vectorize 50,000;
  R2 100,000 buckets; Workers scripts 500 per account outside a namespace.

## Decision
- **Two Workers in `apps/control`**: `ros-control` (app.relationshiposcrm.com: sign-up, billing,
  admin, jobs) and `ros-dispatch` (every other hostname on the zone). The control plane has its own
  D1 (`apps/control/migrations`) and is never part of a release (`NOT_RELEASED`).
- **Provisioning reuses Stage 8.** `installRelease` (packages/release) is the CLI's install
  without prompts. The deploy engine targets a namespace when the deployment state names
  `dispatchNamespace`: everything is uploaded whole (no versions), still staged first and switched
  back to back; crons, workers.dev and custom domains are skipped; scripts get the tag
  `tenant-<id>`. `runUpdate` and `runRollback` work unchanged, D1 bookmarks included.
- **Per-tenant names, nothing shared.** Tenant ids are `t` + 9 characters. Every Worker is
  `<tenant>-<name>`, every resource `<name>-<tenant>` (`resourceNames`, ADR 0193's mechanism), the
  AI Gateway `<tenant>-ros`. No shared D1; inside a deployment there are still no tenant ids (ADR 0001).
- **Dispatch by verified hostname only.** `ros-dispatch` looks up `host:<hostname>` in the `ROUTES`
  KV namespace, which only `ros-control` writes: when it assigns a subdomain, or once Cloudflare for
  SaaS reports a custom hostname active. It never derives a script from the Host header, so no
  request can reach a tenant's runner or gatekeepers, or another tenant. Per request: one
  edge-cached KV read (plus a 30 s isolate cache), no control-plane call.
- **Crons run from the dispatch Worker.** User Workers have no documented Cron Triggers, so
  `ros-dispatch`'s minute cron reads one KV key (`schedule`: running tenants' crons from their
  manifest) and calls `scheduled()` on each matching user Worker.
- **Lifecycle states** (`cp_instances.status`): active; **paused** (idle Free: routed, but out of the
  schedule; the first request wakes it through the `ControlRpc` service binding, once per isolate);
  **suspended** (billing or deletion: the dispatch Worker answers 402 without invoking the tenant).
- **Placements.** `namespace` (default); `account` (ordinary Workers in our account on a Custom
  Domain, ordinary crons: Stage 8 exactly) as the fallback if a WfP check at go-live fails, chosen by
  `DEFAULT_PLACEMENT`; `customer-account` (managed enterprise) recorded only, operated by runbook.
- **Enterprise.** *Dedicated* = a namespace deployment with an enterprise plan (no limits), a
  Cloudflare for SaaS custom hostname (created from the admin console, routed once active), SSO
  through the identity adapters, and the SLA in `cp_accounts.enterprise`. *Managed* = installed in
  the customer's account with `create-relationship-os`, updated with `ros upgrade` using a token
  held under contract; the control plane records it and never provisions or meters it.
- **The control plane never holds customer data.** It holds accounts, billing state, deployment
  state (resource ids, names, vars), usage totals and audit. It reads a customer database only for
  the grant row, the newest session time and the deployment state, and writes only
  `core_entitlements` and `core_support_grants`. Exports go from the customer's resources to the
  customer (ADR 0214).
- **Fakes until go-live.** `PLATFORM_MODE=fake` (the committed default) uses the fake Cloudflare API
  (with namespaces whose user Workers really run, through Worker Loader), a fake Stripe that posts
  signed webhooks to our own endpoint, and a mailbox table. `live` needs the secrets in `src/env.ts`.

## Cost per idle customer (Stage 10 AC5)
- **Paused (60 days without a sign-in, Free):** no requests, no crons, no Durable Object running.
  What remains is storage: an almost empty D1 (inside the account's included 5 GB), an empty R2
  bucket and KV namespace, an empty Vectorize index, and two scripts (inside 1,000 included, then
  $0.04/month). Roughly **$0.00–0.05 per month**, plus $0.10/month for its KV namespace beyond 1,000
  tenants.
- **Active but unused** (before the pause): the app's 10-minute and daily crons and the runner's
  minute cron, ~48,000 invocations a month at a few ms each: about **$0.02 per month**.
- No Durable Object is always on: DOs exist only for workspaces and integrations a customer uses
  and hibernate. The control plane is called per lifecycle change, never per request.

## Consequences
- **Go-live blockers** (all in `docs/saas-go-live.md`): AI Gateway's 20-gateway limit must be
  raised or the design changed before the 20th customer; service bindings, queue consumers, Worker
  Loader, Workflows and `Fetcher.scheduled()` must be verified for user Workers, falling back to
  `account` placement if any fail.
- An update of a namespaced tenant has no "staged version" step, so the gap between first and last
  Worker switching is an upload, not a deployment call. The smoke check and bookmark still cover it.
- One minute cron fans out to every running tenant: at ~1,000 tenants it needs sharding over a queue.

> **Amended 2026-11-05: no gateway per hosted deployment.** Hosted deployments no longer get their own AI
> Gateway (`<tenant>-ros`). Platform AI goes through one shared gateway with a tenant tag, and a
> customer's own keys are set as secrets on their tenant Worker and called directly (see the
> amendment to ADR 0213). This removes the 20-gateways-per-account limit as a go-live blocker.
> Provisioning stops creating a per-tenant gateway and token when that change is built.

> **Amended 2026-11-05: built.** A hosted deployment's state has `aiGateway: false`, so the
> Stage 8 engine creates no gateway or `AI_GATEWAY_TOKEN` for it (self-hosted installs are
> unchanged). Instead provisioning ensures the shared gateway (`PLATFORM_AI_GATEWAY`) and gives
> the AI Workers (ros-app, ros-runner) the vars `AI_PLATFORM_GATEWAY_ID`, `AI_PLATFORM_ACCOUNT_ID`
> and `ROS_TENANT_ID` and the secret `AI_PLATFORM_TOKEN`; ros-app also gets `ROS_CONTROL_URL` and
> the secret `ROS_CONTROL_KEY` ([ADR 0250](0250-deployment-to-control-plane-channel.md)). The
> tenant id is now visible inside a deployment as that var, never in its data. "Per-tenant names,
> nothing shared" has one exception: the Platform AI gateway, whose logs hold metadata only.
