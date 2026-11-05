# Architecture

**Relationship OS** is an AI-native CRM that each organisation deploys to its own Cloudflare account.
An AI client over MCP (such as Claude) or the in-app assistant can do anything a user can, including
reshaping Relationship OS itself: new objects and fields, dashboards, automations and custom tools
are **code**, written by AI, approved, versioned and run safely. The code is FSL-1.1-ALv2 (ADR 0190;
`LICENSE`, `NOTICE`), and the landing page is `apps/marketing`.

Terms are defined in [`CONTEXT.md`](../CONTEXT.md). Decisions and their reasons are in
[`docs/adr/`](adr/). Build order is in [`docs/roadmap.md`](roadmap.md).

## Shape at a glance

```
                         ┌──────────────── one Cloudflare account = one org ────────────────┐
 Browser ── UI ────────► │  app Worker (TanStack Start + shadcn)                             │
 Claude ── MCP/OAuth ──► │   • UI routes + server functions                                  │
                         │   • /mcp  (OAuth 2.1 server → active identity adapter)            │
                         │   • operations registry  ──► approval pipeline ──► D1             │
                         │            │ service binding                                      │
                         │            ▼                                                      │
                         │  runner Worker                                                    │
                         │   • Extension workspace DO (@cloudflare/computer: files + git)    │
                         │   • Executor: Worker Loader dynamic workers, LOADER.get(stableId) │
                         │   • Workflows (long automations), Queues (record-change events)   │
                         │            │ service bindings (GATEKEEPER_*)                      │
                         │            ▼                                                      │
                         │  gatekeeper Workers (Google, Microsoft, email, Slack, MCP, …)     │
                         │   • OAuth accounts, capability APIs, actions + simulation         │
                         └─────────────────────────────┬─────────────────────────────────────┘
                                                       ▼
                                             external services
 D1 (one database) · R2 (files) · Vectorize (record embeddings) · AI Gateway → Workers AI by default / other providers optional (per model role)
```

## Layers

### 1. Deployment (trusted, changes with releases)

Everything in this repo. Each org runs its own copy ([ADR 0001](adr/0001-self-hosted-single-org.md)),
installed from a release bundle or a fork ([ADR 0012](adr/0012-distribution.md)). The deployment
owns the root of trust: identity, the approval pipeline's floor, the operations registry and the
gatekeepers.

- **`app` Worker**: TanStack Start (SSR + server functions) with shadcn/ui, plus `/mcp`.
- **`runner` Worker**: runs extension code, automations and Workflows.
- **Gatekeeper Workers**: one per external service, vendored from Cloudflare OS
  ([ADR 0007](adr/0007-integrations-are-gatekeepers.md)).

#### Distribution and updates (stage 8)

```
 tag vX.Y.Z ─► release.yml: build-release (twice, hashes compared) ─► attest ─► draft ─► smoke ─► publish
                    │ manifest generated from every wrangler.jsonc (placeholders, golden-tested)
                    ▼
 GitHub Release: relationship-os-X.Y.Z.tar.gz · relationship-os-X.Y.Z.manifest.json · SHA256SUMS · build attestation
                    │ downloaded + verified (sha256, attestation, every file vs manifest)
        ┌───────────┴─────────────┐
 npx create-relationship-os / ros upgrade    Settings → Updates (self-updater, optional ROS_UPDATE_TOKEN)
        └───────────┬─────────────┘
          packages/release: Cloudflare REST API (no wrangler) — provision, migrate, stage versions,
          switch all Workers, smoke-check; bookmark + restore for rollback
```

- **Release bundle** ([ADR 0160](adr/0160-release-manifest-and-bundle.md)): `scripts/release`
  builds every Worker with wrangler's dry run, ros-app's assets and the migrations into one
  reproducible tar.gz; the manifest is generated from the wrangler configs, with `$ACCOUNT_ID`,
  `$HOSTNAME`, `$SECRET(…)`, `$WORKER_NAME(…)` and resource placeholders.
- **Versions and channels** ([ADR 0161](adr/0161-versions-channels-and-release-workflow.md)):
  semver, stable and beta; the changelog is generated from PR titles.
- **Verification** ([ADR 0162](adr/0162-release-verification.md)): SHA256SUMS plus GitHub's
  attestation store; `gh attestation verify` in the CLI when available.
- **Deploy engine** ([ADR 0163](adr/0163-deploy-engine-over-the-cloudflare-api.md)) and the
  **create-relationship-os** CLI ([ADR 0165](adr/0165-installer-cli-and-deployment-state.md)); installer choices
  live in D1 (`core_install`) so every later deploy matches.
- **Self-updater** ([ADR 0054](adr/0054-self-updater.md), [ADR 0164](adr/0164-update-procedure-preflight-and-rollback.md)):
  `update.*` operations (human admins) behind an `UpdaterRuntime` port; preflight blocks an
  update that would break a runtime extension; history and bookmarks in `core_update_runs`.
- **Setup wizard** ([ADR 0167](adr/0167-first-run-setup-wizard.md)): `/setup` on the first admin
  visit; `setup.*` and `sample.*` operations.
- **No telemetry** ([ADR 0166](adr/0166-no-telemetry.md)). Real-account CI:
  [ADR 0168](adr/0168-real-account-install-test.md).

### 2. Operations registry (the one API)

Every thing a user or AI can do is an **operation** defined once in `packages/core`: name, zod input
and output, description (written for a model), required permission, and **risk class**
([ADR 0003](adr/0003-operations-registry.md)). Each operation is exposed three ways from that single
definition:

| Surface | Consumer |
| --- | --- |
| TanStack Start server function | the UI |
| MCP tool | Claude and other MCP clients |
| host module (`codemode:crm`) | extension code in dynamic workers |

Every call passes through the **approval pipeline** before it takes effect. In code that is
`invoke()` in `packages/core` (ADR 0018): validate → gate → role check → handler → one D1 batch
holding the handler's writes, timeline activities and the audit row with field diffs. Handlers
read with Kysely and queue writes; list operations take filter JSON validated against the **field
registry** and compiled to parameterised SQL. `packages/core/README.md` shows how to add one.

### 3. Data

One **D1** database per deployment, with real tables ([ADR 0002](adr/0002-d1-real-tables.md)).

- **Core schema** (`core_*` tables): our versioned migrations, applied on deploy or upgrade. It covers
  the minimal core objects (People, Organisations, Activities, Tasks), users, settings, the approval
  queue and the audit log. Deletes are soft (Trash); a daily cron trigger on `ros-app` purges
  people, organisations, activities and tasks after 30 days through the operations pipeline
  (`trash.purge`), and admin erase redacts the append-only audit log through a sanctioned path
  ([ADR 0019](adr/0019-audit-redaction-for-erasure.md)).
- **Storage retention** ([ADR 0090](adr/0090-storage-retention.md)): D1 stops at 10 GB, so the same
  cron keeps growth bounded. Successful reads by AI, extensions and automations are counted per
  hour (`core_audit_read_counts`) rather than audited row by row. Write audits are kept forever by
  default; an admin can choose 1, 2 or 7 years, and `audit.purge` then deletes older rows through
  a second sanctioned path (purge markers). Run history goes after 30 days (failures 90), decided
  pending actions are compacted to a summary after 30 days, and Settings → Storage shows the
  database size against the cap.
- **Extension schema** (`x_<extension>_*` tables): declared in extension code (`defineObject`) and
  reconciled into D1 by the host, additive-first. Core migrations never touch `x_` tables.
- **`crm.*` views**: generated read views with friendly names, spelled `crm_people`,
  `crm_organisations`, … because D1 has no schemas (ADR 0015 amendment). They are what list
  operations, dashboard SQL and AI queries run against. Since migration 0020 the person,
  organisation, activity and task views are owned by the schema reconciler: core migrations change
  their `core_base_*` views, and the reconciler regenerates `crm_*` over them with extension side
  tables and formulas joined in. Extension objects read through `crm_x_<ext>_<object>`.
- **R2** holds attachments (and, later, large imports: stage-1 CSV imports arrive inline,
  [ADR 0020](adr/0020-query-sql-validator-and-csv-import.md)).

Core migrations are plain SQL in `packages/db/migrations`. Both Workers point their `DB` binding's
`migrations_dir` there, so `wrangler d1 migrations apply` and the in-code runner (`applyMigrations`,
used by tests and upgrades) share one bookkeeping table, `core_migrations`. Each migration also
bumps `core_meta.schema_version`, which `/api/health` compares with the version the code expects.
Typed access to core tables uses Kysely ([ADR 0014](adr/0014-kysely-for-core-schema.md)).

### 4. Extensions (the AI-built layer)

An **extension** is code against one contract (`packages/sdk`): `defineObject`, `defineView` /
`defineDashboard`, `defineAutomation`, `defineTool` ([ADR 0005](adr/0005-extensions.md)).

- **Shipped extensions** live in `extensions/` and ship with releases. Deals/Pipelines is the first.
- **Runtime extensions** are written by Claude in-app or via MCP. They are stored in an
  `@cloudflare/computer` Workspace (a Durable Object filesystem with git), approved as a diff, and
  rolled back by reverting ([ADR 0006](adr/0006-dynamic-runtime-cloudflare-computer.md)).

Extension code runs in Worker Loader dynamic workers with **no network** (`globalOutbound: null`).
It can reach only the host modules it is given: CRM operations, the AI model roles, and enabled
gatekeepers.

How stage 3a built it ([ADR 0040](adr/0040-extension-runtime-build.md)):

- **Contract**: `defineExtension({ id, version, contractVersion, permissions, objects, fields,
  views, tools, automations })` in `packages/sdk`, with every field type and a typed formula
  language compiled to SQLite (`@relationship-os/sdk/formula`). See `packages/sdk/README.md`.
- **Reconciler** (`packages/core/src/extensions/reconciler.ts`): manifest → ordered DDL over
  `x_<ext>_<object>` tables and 1:1 side tables `x_<ext>_<target>`, plus regenerated `crm_*` views,
  dry-run by `extension.check` and applied atomically by `extension.install`.
- **Registry**: extension objects and fields join the field registry (refreshed per invocation), so
  `record.*` operations, filters, saved views, search, CSV export and history work for them. Tools
  are operations `x.<ext>.<tool>`.
- **Runtime** (`apps/runner/src/extensions/`, `apps/runner/src/executor/`,
  [ADR 0043](adr/0043-extension-executor-and-stable-loader-ids.md)):
  - **The workspace.** The `ExtensionWorkspace` DO holds each extension's source in its own git
    repo, plus the build cache. It runs no code.
  - **Builds.** A build is a transpile, an import check and a TypeScript type check against
    `@relationship-os/sdk`'s declarations. The type check runs in its own Dynamic Worker. Builds are cached by
    a content hash of the source.
  - **The executor.** It runs from ros-runner's stateless entrypoint, so runs execute in parallel.
    Tool and manifest workers come from `LOADER.get(stableId)`: the id hashes the extension,
    commit, host modules, SDK and runtime. Only Code Mode uses `load()`.
  - **Per-run context.** Each call gets its context as RPC arguments, including a per-run host
    `RpcTarget` serving the declared `codemode:crm`, `codemode:storage`, `codemode:log` and
    `codemode:ai` modules.
  - **Principal.** Code acts as `extension:<id>` (actor `extension`) within its declared
    permissions.
  - **Failures.** Runs are recorded. 3 consecutive failures quarantine an extension. Rollback
    reinstalls an earlier commit.
- **Shipped extensions** (`extensions/<id>/`; Deals is the first) are bundled as source at build time
  and installed through the same `extension.install` path at boot.
- **Stage behaviour** ([ADR 0100](adr/0100-stage-behaviour-and-object-contract-additions.md)):
  an object's declarative `stages` key is enforced by the host inside `record.create`,
  `record.update` and `import.records.commit` (`packages/core/src/records/stages.ts`): stage rules
  (a `StageRuleError` naming the missing fields), default stage and pipeline, probability,
  status and won/lost date, `core_stage_history` rows (read as `crm_stage_history`) and
  "Moved to <stage>" timeline posts on the record and its `timelineLinks`. The reconciler also
  creates declared `indexes` (partial, live rows) and inserts `seed` records once.
- **UI**: generic list and record pages at `/x/<ext>.<object>` (with CSV import and export),
  field widgets for every type, extension fields on core record pages, Settings → Extensions, set-up
  objects (`navigation: "settings"`, e.g. pipelines) under Settings, and Settings → General (the
  base currency, [ADR 0101](adr/0101-base-currency.md)).
- **Shipped views and dashboards** ([ADR 0103](adr/0103-shipped-views-dashboards-and-relative-filters.md)):
  `view.list` adds active extensions' `views` (read-only, `vw_x_…`) and `dashboard.*` their
  `dashboards` (read-only, `dsh_x_…`); an extension dashboard marked `home` is the default Home.
  Filter values `{ $relative }` resolve in the pipeline per call. Boards group by a select or by a
  relation (a deal's stage, columns in stage order).

How stage 3b added authoring ([ADR 0041](adr/0041-extension-authoring-and-proposals.md)):

```
 MCP client ── extension.write ──► working copy (/extensions/<id>/, uncommitted)
            ── extension.check ──► evaluate + typecheck + contract + formulas + dry-run reconcile
            ── extension.propose ─► commit ─► check ─► diff + host-computed impact (+ build-role
                                    summary) ─► pending action `extension.apply` (risk extension)
 Approvals inbox ── approve ──► approval.approve re-runs extension.apply as the proposer
                                 └─► installExtension: DDL + state + audit + pending status, one batch
```

- `extension.apply` is `alwaysReview`: whatever the actor or preset, it is queued, so a version
  that widens permissions never auto-applies. Approving one needs an admin (`extensions:manage`).
  `extension.approve` / `extension.reject` are the same decision as the inbox, for one proposal.
- The review detail (diff, impact, check, AI summary) is stored by proposal in
  `core_extension_proposals` (migration 0030) and shown on the approval screen.
- Shipped extensions can be extended from another extension but not written in place;
  `extension.eject` copies one into the working copy, and its approved proposal turns it into a
  runtime extension that releases no longer update.
- **Code Mode** ([ADR 0042](adr/0042-code-mode.md)): the MCP `code` tool (operation `code.run`)
  runs a client model's script in a throwaway Dynamic Worker as the connected user's `mcp` actor.
  - **Calls.** Each `crm.call` goes through the pipeline with that user's role, scopes and
    session, so gates, pending actions and simulated reads behave exactly as for tool calls.
  - **Limits.** It needs `records:write`. It runs one script per user at a time and is rate
    limited per user (ADR 0043).

How stage 5 runs automations ([ADR 0130](adr/0130-automation-runtime.md), test mode
[ADR 0133](adr/0133-automation-test-mode.md)):

```
 operation batch (change + outbox row, ADR 0171) ─► after commit: EventSink (≤100 changes/message,
   one sendBatch per operation, origin-tagged), outbox row deleted on success
   ─► Queue ros-automation-events ─► ros-runner queue() ─► dispatchAutomationMessages
        TriggerSource per message kind (record, approval, integration)
        ─► rails: kill switch, depth ≤ 3, cycle, bulk, debounce, conditions, fan-out, rate limits
        ─► run row (INSERT … ON CONFLICT DO NOTHING on the Workflow id) ─► createBatch
 ros-runner cron (* * * * *) ─► schedules in the automation timezone, daily date-relative scan,
        outbox retry (rows left by failed sends, dispatched directly), integration events
        (unconsumed core_integration_event rows → webhook / syncEvent triggers, ADR 0173)
 AutomationWorkflow: start ─► advance:<n> (executor.runAutomation via LOADER.get) ─► sleep / wait
        ─► review pause (waitForEvent approval-<actionId>) ─► finish (counters, history)
```

- **Registry.** `extension.install` syncs `core_automations` from the manifest; the consumer and
  cron load enabled automations through `core_automations_trigger_idx`.
- **Replay.** Each advance replays the extension's `run` with the journal of finished steps in the
  extension's tool worker; one new `step.do` runs per advance, sleeps and waits are Workflow
  sleeps and waits. Steps act as actor `automation` under the extension principal, with cascade
  tags on their origin.
- **Review pause.** A gated write becomes a pending action in one change set per run; the
  Workflow waits for the decision (approval resumes, rejection follows `onRejected`, expiry ends
  the run `expired`).
- **Test mode.** One executor call with `InvocationContext.simulate`: gates recorded, writes
  dry-run into an in-memory overlay, nothing written, no events. A proposed automation is tested
  at its proposed commit with `proposal { actionId, key }` (stage 7b; report not stored).
- **Operations.** `automation.list/get/test/enable/disable/runs/run/retry/replay/cancel/explain/
  killSwitch/settings/updateSettings` (`packages/core/src/operations/automation.ts`); ros-app
  reaches the runner's `AutomationHost` RPC for test, run, retry, replay and cancel.
- **History.** `core_automation_runs` and `core_automation_run_records`, purged by the daily cron
  (30 days, failed 90).
- **Run-as** ([ADR 0170](adr/0170-automation-run-as-bindings.md)). Automations that declare
  `connections` wait until a person binds each to a connection (`automation.bindConnection`,
  `core_automation_binding`, the consent). In a run, `codemode:<gatekeeper>` resolves the slot to the
  bound connection and calls it as the connection's owner; a pending outbound action pauses the run
  like a gated write. Disconnecting, expired credentials or `user.deactivate` revoke the bindings,
  pause the automations and notify the admins.

### 5. Integrations

All external access goes through **gatekeepers**: reviewed Workers in the repo that own OAuth, expose
a capability API per resource, journal actions and simulate pending ones. We adopt Cloudflare OS's
gatekeeper interface and `gatekeeper-kit` rather than inventing our own. Extension code never reaches
the network directly. `gatekeeper-mcp` lets an admin connect any MCP server at runtime.

Stage 6a ([ADR 0110](adr/0110-integration-host-per-connection.md) to
[ADR 0114](adr/0114-own-gatekeepers-pickers-and-host-modules.md)):

- **Integration host**: one Durable Object per **connection** in `ros-runner`
  (`INTEGRATION_HOST.getByName(connectionId)`). It holds the gatekeeper account, one facet per bound
  resource (recreated from its stored class stub after a restart), hook controllers and sync state.
  D1 (`core_integration_connection`) mirrors connections for the UI. Operations reach it through the
  `IntegrationRuntime` port (`packages/core/src/integrations/runtime.ts`), over RPC from `ros-app`.
- **Connect flow**: `connection.create` → provider popup → `/gatekeeper/<vendor>/*` (proxied by
  `ros-app` to the gatekeeper through `ros-runner`) → `/connect/handoff#ticket` →
  `connection.completeConnect`, which activates the account only for the user who started the flow
  and the popup's nonce.
- **Outbound actions**: a gatekeeper's `submitAction` is gated as risk `outbound` by action kind and
  mirrored into the approval queue; approval calls `applyAction` on the facet, in order per facet.
- **Sync**: hook-driven, alarm-chunked mail and calendar sync per connection (90 days by default),
  written by `sync.ingest` with an indexed external key, bodies in R2 (`ros-blobs`), sharing level per
  connection, private activities, suggested contacts and job-change suggestions.
- **Code**: `integration.call` (MCP), and `codemode:<gatekeeper>` host modules for extension tools and
  Code Mode.
- **Gatekeepers we wrote**: `gatekeeper-email-send`, `gatekeeper-slack-post`, `gatekeeper-webhook`.
  Inbound webhooks and sync events land in `core_integration_event`; ros-runner's cron turns them
  into `webhook` and `syncEvent` automation triggers (ADR 0173), dropping private activities.
- **Notification delivery** ([ADR 0172](adr/0172-notification-delivery.md)): ros-runner's minute
  cron reads new `core_notifications` rows behind a 30 s lag through a keyset cursor and sends each
  to the email/Slack channels its recipient chose, escalates unread approval notices and sends the
  daily digest ([ADR 0206](adr/0206-daily-digest.md)): changes others made to my records (read once
  a tick through `core_audit_at_idx`), tasks due, approvals waiting and unread notices, as an
  in-app `digest` notification (on by default) and by email when asked for. Every send is claimed in `core_notification_delivery` first and goes through the
  integration host as a system outbound action on the admin-chosen org email-send / Slack
  connection, gated like any outbound action. The automation consumer also posts admin channel
  routes for record events, once per event, route and record.

### 6. Approval pipeline

Configurable per org ([ADR 0011](adr/0011-approval-pipeline.md)):

1. **Deterministic gate** (code): actor × risk class → `auto` / `deny` / `review`, never below the
   deploy-time floor.
2. **Policy adjudicator** (optional): a second LLM (the `review` model role) or Jev (the judge) judges the
   simulated change against the org's written policy → approve / deny / escalate.
3. **Human queue**: escalations, with the adjudicator's reasoning attached.

Only human admins can change the policy. Every decision is audited.

The human queue is built (stage 2, [ADR 0022](adr/0022-approval-queue-and-simulation.md),
[ADR 0032](adr/0032-mcp-sessions-and-approval-mechanics.md)); the policy adjudicator in stage 7b
([ADR 0204](adr/0204-policy-adjudicator.md)), described at the end of this section.
A `review` decision dry-runs the operation and records a **pending action** (diff preview,
simulated result, dependencies, the agent's reason) in a **change set**, then returns
`pending_approval`. The originating MCP session's reads (`get`, `list`, `search.global`,
`activity.listForRecord`) see its pending actions applied, with **provisional IDs** for creates;
everyone else reads real data. A person approves or rejects (`approval.approve` / `reject`):
approval re-runs each action through the pipeline as the original actor, binding provisional to
real ids, and fails an action cleanly if its record changed or was deleted meanwhile. Rejection
cascades to dependents; pending actions expire after `APPROVAL_EXPIRY_DAYS` (default 7).
People review in the **Approvals inbox** (`/approvals`: change sets with readable diffs, approve or
reject whole or per item), with a count in the sidebar and **pending-change badges** on record
headers and list rows (`approval.pendingForRecord`). An erase also scrubs pending actions that
mention the erased record (ADR 0032 amendment).

**Policy adjudicator** (stage 7b, [ADR 0031](adr/0031-policy-adjudicator.md),
[ADR 0204](adr/0204-policy-adjudicator.md)). Admins set its mode (`off` / `shadow` / `active`,
core_settings `adjudicator`), a confidence threshold and the **written policy**
(`core_written_policy`, versioned and hashed) under Settings → Policy adjudicator, all through
human-only `adjudicator.*` operations. The pipeline records on each pending action *why* it went to
review (`review_source`: the preset, the floor, `alwaysReview`, or a pending dependency) and, after
the review batch commits, calls the context's `onQueued` hook; ros-app's runs the adjudicator in
the background (`waitUntil`), so the caller gets `pending_approval` exactly as before, and the
10-minute cron sweeps up anything missed (ros-runner's queued actions included). With the mode off
that is one settings read and no writes. The adjudicator asks the `review` role in JSON mode, with
the policy and instructions as the system message and the change as fenced, escaped data
(`reviewPendingItem`, through the `Reviewer` interface), validates the reply with zod (one repair round; invalid, empty or cut off →
`escalate`, confidence 0), and stores one verdict per action in `core_adjudication` with an
`adjudicator.verdict` audit row. In shadow mode that is all. In active mode a valid `approve` at or
above the threshold, for an action the preset (or a dependency) routed to review, whose risk is not
outbound, schema or extension and whose dependencies are applied, is applied through the approval
machinery as the original actor with `decided_by = adjudicator`; every other verdict, `deny`
included, stays pending for a person with the reason shown. Verdicts appear beside each item in the
Approvals inbox for people who may approve, and never in what `approval.*` or `audit.list` return
to the assistant, MCP clients, automations or extensions. `adjudicator.agreement` (Settings) reports
the agreement rate against people's decisions.

### MCP

`/mcp` on `ros-app` ([ADR 0021](adr/0021-mcp-surface.md), ADR 0032): `workers-oauth-provider`
wraps the Worker (OAuth 2.1, dynamic client registration, PKCE, one-hour access tokens and
30-day refresh tokens in the `OAUTH_KV` namespace). `/oauth/consent` signs the user in through
the identity adapter and grants scopes `read`, `write` and (admins only) `admin`; effective
permission is role ∩ scopes. Each authorization is a **connected app** (`core_connected_app`),
which is also the MCP session; revoking it stops its tokens at once. `/mcp` is the Agents SDK's
stateless Streamable HTTP handler with an MCP SDK v2 server per request
(`apps/app/src/server/mcp/`): curated tools (operations flagged `mcp: { curated: true }`),
`describe_operations` / `call_operation` for every other MCP-exposed operation, the
`crm://schema` resource and server instructions. Calls run as actor `mcp` with origin
`{ surface: "mcp", clientId, clientName, sessionId }`, rate-limited per connected app. See
[`docs/mcp.md`](mcp.md).

### 7. Identity

A deploy-time **identity adapter** ([ADR 0008](adr/0008-identity-adapters.md)): Better Auth (the
default) or Cloudflare Access, selected by env var. The MCP OAuth 2.1 server sits on top and delegates
login to the active adapter. Identity is never runtime-pluggable.

In `ros-app`, one TanStack Start request middleware resolves the **Principal** for every page
route, server route and server function call. Everything is private by default: only `/sign-in`,
`/api/health`, the adapter's own routes (`/api/auth/*`) and server functions in `*.public.ts` files
are reachable without one. The OAuth routes (`/oauth/*`, `/.well-known/oauth-*`) and `/mcp`
are handled before TanStack Start by the OAuth provider, which checks Bearer tokens itself. A request without a Principal is redirected to sign-in (pages, Better
Auth) or gets a 401 (APIs, server functions, and any request under Cloudflare Access).

### 8. AI

**Model roles** (`build`, `assistant`, `summarise`, `extract`, `classify`, `embed`, `vision`,
`review`) map to a provider and model in the core **model role registry**
(`packages/core/src/ai/roles.ts`, [ADR 0009](adr/0009-model-roles.md),
[ADR 0150](adr/0150-model-role-registry-and-ai-sdk.md)). Code asks for a role, never a model.

```
 operation ── ctx.models.run("summarise", …) ──► registry: shipped (Workers AI) → AI_MODEL_ROLES → Settings → AI
                                                    │ capability check (tools, JSON, context, vision, embeddings)
                                                    ▼
                                AI SDK ── workers-ai-provider ── AI binding, gateway: { id, metadata: { role } } ──► AI Gateway ─► Workers AI
                                       └─ @ai-sdk/openai-compatible ── …/{gateway}/compat, model "provider/model" ─► AI Gateway ─► provider
                                            (cf-aig-metadata: role, cf-aig-authorization; BYOK: no Authorization)
                                          no gateway (--ai-gateway off): binding without the option; provider's own URL
 hosted (AI_PLATFORM_GATEWAY_ID set):
   Workers AI roles = Platform AI ── @ai-sdk/openai-compatible ── api.cloudflare.com/…/ai/v1 + cf-aig-gateway-id ─► shared platform gateway ─► Workers AI
                                       (cf-aig-metadata: role, tenant, plan; cf-aig-collect-log-payload: false; cf-aig-skip-cache)
   own keys (AI_KEY_<P> secrets) ─────── provider's own URL, or the customer's own gateway (AI_CUSTOMER_GATEWAY)
```

- **The registry** resolves each role through shipped defaults (every role on Workers AI),
  deploy config (`AI_MODEL_ROLES`) and admin overrides (`core_settings.ai_settings`), rejecting
  models without the role's capabilities, with one fallback per role. ros-app passes the runner to
  operations as `ctx.models`; ros-runner uses the same registry for `codemode:ai` and proposal
  summaries. Every call goes through AI Gateway when `AI_GATEWAY_ID` is set, tagged with its role;
  the installer and the updater create a gateway per deployment and set it
  ([ADR 0180](adr/0180-ai-gateway-provisioned-per-deployment.md)).
- **Providers** (gateway-first, [ADR 0203](adr/0203-gateway-first-model-registry.md)):
  Workers AI (the binding, with its `gateway` option) and, optionally, OpenAI, Google AI Studio,
  OpenRouter, DeepSeek, Anthropic and AI Gateway **custom providers**, called through the
  gateway's unified endpoint (`…/{gateway}/compat`) with `provider/model` ids
  (`deepseek/deepseek-flash`, `custom-<slug>/<model>`). Embeddings use the provider-native path.
  Other OpenAI-compatible endpoints are called directly. With no gateway every provider
  is called at its own URL. A deployment can pick a **model role preset**
  (`create-relationship-os --model-roles deepseek-flash`), stored as its `AI_MODEL_ROLES` in the deployment
  state, and `AI_GATEWAY_BYOK` says which providers' keys the gateway holds
  ([ADR 0192](adr/0192-deepseek-provider-and-model-role-presets.md)). The shipped defaults stay
  on Workers AI.
- **Settings → AI** (`ai.*` operations, admins): per role provider, model, fallback, capability
  badges, a Test button and a warning when `review` shares the assistant's model (ADR 0031);
  provider keys stored as AI Gateway BYOK (the default with a gateway, through
  `CloudflareClient.setGatewayProviderKey`) or as Workers secrets, **never in D1** ([ADR 0151](adr/0151-provider-keys-as-workers-secrets-or-byok.md));
  usage and spend per role from AI Gateway's logs, cached 10 minutes
  ([ADR 0152](adr/0152-usage-and-spend-per-role.md)).
- **Hosted placement** ([ADR 0213 amendment](adr/0213-ai-usage-billing.md),
  `packages/core/src/ai/platform.ts`): the same code, switched by deploy vars the control plane
  sets. Every Workers AI role becomes **Platform AI** (registry provider `platform`), called over
  Workers AI's REST endpoint through the one shared platform gateway; the model client forces the
  tenant tag, payload-logging off and cache-skip onto every such request at the fetch, so nothing
  a caller passes (extension code through `codemode:ai` included) can re-tag it. `platformAi`
  entitlements gate it. The customer's own keys are Workers secrets on the tenant Workers, set
  through the control plane over the signed deployment channel
  ([ADR 0250](adr/0250-deployment-to-control-plane-channel.md)), called directly (or through
  their own connected gateway), never billed. Usage is counted in `core_ai_usage` and shown in
  Settings → AI, split into billed and own-key.
- **Summaries** (`summary.*`, [ADR 0153](adr/0153-ai-summaries.md)): record summaries (people,
  organisations, deals), meeting prep, one-liners for long emails and notes, and change-set
  summaries for approvers. Cached in `core_ai_summary` by a SHA-256 of their facts and the model,
  so any change makes them stale; generated only on request; labelled AI-generated. The daily
  digest ([ADR 0206](adr/0206-daily-digest.md)) opens with a one or two sentence AI overview (one
  `summarise` call per digest, in ros-runner's cron, labelled AI-generated; the plain digest
  without AI or on any error).
- **Semantic search** ([ADR 0154](adr/0154-embeddings-queue-and-vectorize.md),
  [ADR 0155](adr/0155-hybrid-search-similar-records-and-retrieval.md)):

```
 write ─► pipeline commit ─► stage 5 record events (Queue) ─► ros-runner consumer ─► embedRecordEvents
         (no Vectorize, erase, sync: core_embedding_queue rows in the batch ─► onCommitted ─► drain)
                                       10-minute cron (ros-app) ─► backfill + drain retries
 drain: text per record ─► SHA-256 unchanged? skip : embed role (≤100 per call) ─► Vectorize (ros-records)
 search.hybrid: FTS5 (all words, any word) + Vectorize nearest ─► reciprocal rank fusion ─► Cmd-K, retrieval
 record.similar: the record's stored vector ─► Vectorize nearest ─► "Similar records"
```

  Private and metadata-only synced activities are never embedded; an erase deletes vectors and
  summaries. Changed records are embedded from stage 5's record events by ros-runner's queue
  consumer; the D1 queue is only the fallback (ADR 0154 amendment).
- **Bindings are optional** ([ADR 0156](adr/0156-optional-ai-bindings-and-local-stand-ins.md)):
  `pnpm run deploy` adds `ai` (both Workers) and `vectorize` (ros-app). Without them AI features
  say AI is not configured and search is full-text only. Locally `AI_FAKE_MODEL=true` answers
  every role with deterministic stand-ins and keeps vectors in memory.
- **The in-app assistant** ([ADR 0030](adr/0030-in-app-assistant.md),
  [ADR 0200](adr/0200-in-app-assistant-build.md), [ADR 0201](adr/0201-assistant-reasoning-content.md)):

```
 Cmd-J panel · /assistant · Ask AI · Ask about N selected ─ POST /api/assistant/turn (SSE) ─┐
   (page, record, selection)                     GET …/conversations/:id[/stream?after=N] │
                                                                                          ▼
 ros-app: AssistantConversation DO (one per conversation, SQLite: messages, turns; no alarms)
   └─ turn: chatModels("assistant") ─► AI SDK streamText loop ─► tools = MCP client ──► createCrmMcpServer
        (primary, then fallback)        (≤16 steps)              (in-process transport)  (actor assistant,
                                                                                          session = asc_…)
                                                     ─► pipeline: gate · change set · simulation · audit
```

  The assistant is an MCP client of the same server `/mcp` builds per request, connected in
  process, so its tools, descriptions and results are an external client's. It acts as actor
  `assistant` for the signed-in person (role, no scopes) with origin `{ surface: "assistant",
  sessionId: <conversation> }`; its pending actions group in that session's change set and are
  shown inline with Approve / Reject. The conversation object stores the AI SDK's model messages
  with their reasoning (DeepSeek's thinking mode needs `reasoning_content` replayed) and streams
  each turn's events to any number of readers, who resume with `?after=<seq>`. D1 holds only the
  conversation list (`core_assistant_conversation`, one write per turn through
  `assistant.finishTurn`) and, in the same write, the people, organisations and (hashed) emails
  each turn referenced (`core_assistant_conversation_refs`), so an erase finds the conversations
  to redact and asks their objects to scrub them before it commits (ADR 0019 amendment).
  `EVAL_VIA=assistant` runs the stage 2–5 eval sets through it.

- **The judge** ([ADR 0230](adr/0230-jev-as-the-typed-judge.md),
  [ADR 0232](adr/0232-judge-defaults-and-user-decisions.md), [`docs/jev.md`](jev.md); stage 11,
  the seam, `authoring.intent`, `summary.statements`, `outbound.message` and `widget.shape`
  built, the adjudicator's Jev reviewer and `sync.jobChange` to come): a seam beside the
  registry, not a model role (`packages/core/src/judge/`, `ctx.judge` built by `judgeFor`).
  Code asks it typed questions (Choice, Noul, Score) at a named **placement** and gets
  probabilities; code holds the thresholds and decides. Its provider is **Jev**, pinned in code,
  reached through AI Gateway's custom provider `custom-typesafe`, with its key as BYOK or the
  `TYPESAFE_API_KEY` secret. Placements: does a proposed automation or extension do what the
  person asked (advice), the adjudicator's Jev reviewer (fails closed), each summary statement
  against its facts, model-written outbound messages (fails closed), job changes from signatures
  and the shape of a described widget. Without a key the judge is off and nothing changes.
  Each placement is on or off by layers: shipped default (on unless it sends record content),
  the `JUDGE_PLACEMENTS` deploy var, then human admins (`judge.update`). Built so far:
  `authoring.intent` asks five Choices per added or changed automation in `extension.check`
  (given a request) and `extension.propose`, adds `intent/*` warnings, stores the verdicts on
  the proposal row (`intent_check`) and shows them on the approval screen; the assistant passes
  the person's own words (`personsWords`, set by its Durable Object). Thresholds come from
  labelled sets (`pnpm eval:calibrate`, `evals/judge`), and tests and CI only replay committed
  recordings ([ADR 0231](adr/0231-judge-calibration-and-replay.md)). The automations eval grades
  intent with the same questions. `summary.generate` checks each statement of a new summary and
  removes what the facts do not say, storing the verdicts with the cached row (`checks`); a
  change-set summary the judge could not read is withheld ([ADR 0237](adr/0237-summary-statements-placement.md)).
  `submitOutbound` (ros-runner's integration queue) reads a message an AI actor wrote: a finding
  or no answer turns an automatic send into a review, with the findings on the pending action
  (`outbound_check`) for human approvers ([ADR 0238](adr/0238-outbound-message-placement.md)).
  `widget.describe` asks which shape the prompt wants before generation and sends a widget of a
  type that cannot show it back once ([ADR 0239](adr/0239-widget-shape-placement.md)). On a hosted
  deployment the placements that send record content stay off in code.

```
 placement ── ctx.judge.ask({ placement, state, questions }) ──► off? JudgeUnavailable("off")
                                                                    │ on: key via BYOK or TYPESAFE_API_KEY
                                                                    ▼
                    jevJudge (fetch) ─► AI Gateway custom-typesafe ─► api.typesafe.ai/v1/systemone (JEV_MODEL)
                                                                    │
 typed answers (validated) or JudgeUnavailable { reason } ◄────────┘  ─► code: thresholds, fail open or closed
```

### 9. Dashboards and views

A view spec rendered by our own shadcn/chart components. Widgets query with read-only SQL over the
`crm.*` views: the SQL is checked by a SQLite-faithful tokenizer validator (one SELECT/WITH,
`crm_*` views only), takes bound params, and runs with row and time limits
([ADR 0020](adr/0020-query-sql-validator-and-csv-import.md); `validateReadOnlySql` in `@relationship-os/core`,
used by `query.sql`). Computed widgets are extension code. Extensions never ship UI
([ADR 0010](adr/0010-dashboards-sql-views.md)).

How stage 4a built it:

- **View types** ([ADR 0056](adr/0056-view-spec-union-and-shared-views.md)): the view spec is a
  union (`table | board | calendar | gallery | dashboard`, `packages/core/src/views/spec.ts`).
  Saved views (`view.*`) store any object view and can be shared. List pages switch type with
  `vt`/`layout` search params; boards move cards through each object's update operation (stage
  rules apply), with `record.groups` for column counts and sums.
- **Dashboards** ([ADR 0057](adr/0057-dashboards-params-cache-and-click-through.md)):
  `core_dashboards` plus the code-defined Overview, Home per user (`core_user_home`). Widget SQL
  uses named params (`:date_from`, `:owner`, `:now`, …) rewritten to `?N` and run through
  `runReadOnlySql`; results are cached 60 s in the Workers Cache API by a hash of SQL, params and
  visibility scope; click-through templates resolve to list filters.
- **Record tabs and panels, settings** ([ADR 0058](adr/0058-record-tabs-panels-and-extension-settings.md)):
  extensions declare `recordTabs`, `recordPanels` and typed `settings`; `view.recordViews` and
  `extensionSettings.*` serve them to the UI.
- **Describe a widget** ([ADR 0059](adr/0059-describe-a-widget.md)): `widget.describe` asks the
  `build` role (Workers AI through the optional `AI` binding on ros-app) for a widget, validates
  and previews it; without AI it says so.

### 10. Hosted SaaS (stage 10)

Besides self-hosting, we run deployments for customers (ADR 0191). Each is still one isolated
deployment with its own D1, R2, KV, queues and Vectorize index: no shared database and no tenant id
in its data. The one shared piece is the Platform AI gateway (below). Built and tested against
fakes; switched on by `docs/saas-go-live.md`.

```
 browser ─► <org>.relationshiposcrm.com ─► ros-dispatch ─(KV host:<hostname>, verified only)─► <tenant>-ros-app
                                              │ minute cron: runs active tenants' crons     (user Workers in the
                                              │ (paused / suspended tenants: none)           WfP dispatch namespace
                                              ▼                                              ros-customers)
 browser ─► app.relationshiposcrm.com ─► ros-control: sign-up, plans, Stripe, admin console, jobs queue
                                              │ Stage 8 engine (installRelease, runUpdate, runRollback)
                                              ▼ writes: core_entitlements, core_support_grants (customer D1)
 <tenant>-ros-app ─(signed: x-ros-tenant/timestamp/signature)─► ros-control /api/deployment/ai-secret
                                              └─► WfP script secrets AI_KEY_<P> / AI_CUSTOMER_GATEWAY on the tenant's AI Workers
```

- **Control plane** (`apps/control`, [ADR 0210](adr/0210-hosted-deployments-on-workers-for-platforms.md)):
  `ros-control` with its own D1 (accounts, instances, rollouts, usage, audit; never customer data)
  and `ros-dispatch`. Provisioning uses Stage 8 bundles and the deploy engine, which can target a
  dispatch namespace (`dispatchNamespace` in the deployment state; per-tenant names and tags).
  States: active, paused (idle Free, woken by the next visit), suspended (billing). Placements:
  namespace, account (fallback), customer-account (managed enterprise, by runbook).
- **Plans and entitlements** ([ADR 0211](adr/0211-plans-and-entitlements.md)): Free / Team /
  Business / Enterprise. The control plane writes one `core_entitlements` row; the deployment
  enforces users, records and platform AI (`PlanLimitError`). Self-hosted: no row, no limits.
- **Support grants** ([ADR 0212](adr/0212-customer-approved-support-grants.md)): requested by
  staff, approved by the customer's admin in Settings → Support access, time-limited, a dedicated
  support user, audited on both sides; entry by an Ed25519-signed token (`/support/enter`).
- **AI billing** ([ADR 0213](adr/0213-ai-usage-billing.md) and its amendment) from the shared
  platform gateway's logs, filtered by tenant tag (`ros-platform`, created by provisioning with
  caching off and logs on, checked on every provision): cost + 20%, allowance per plan, overage as
  Stripe meter events, Free credit in dollars; the customer's own keys and MCP free. Hosted
  deployments get no gateway or gateway token of their own (`aiGateway: false`), only
  `AI_PLATFORM_GATEWAY_ID`, `AI_PLATFORM_ACCOUNT_ID`, `ROS_TENANT_ID`, the shared
  `AI_PLATFORM_TOKEN` and, on ros-app, `ROS_CONTROL_URL` and `ROS_CONTROL_KEY`.
  **Stripe and lifecycle** ([ADR 0214](adr/0214-stripe-billing-and-account-lifecycle.md)):
  webhooks drive suspend and resume; export and delete. **Rollouts**
  ([ADR 0215](adr/0215-staged-rollouts.md)): canary → 10% → all, pause on failures, bookmark rollback.

## Repository layout

```
apps/
  app/                 TanStack Start + shadcn UI, server functions, /mcp       → Worker "ros-app"
  runner/              extension runtime, automations, Workflows, Queues         → Worker "ros-runner"
  control/             hosted SaaS control plane and dispatch Worker (stage 10)  → "ros-control", "ros-dispatch"
  marketing/           the landing page relationshiposcrm.com                    → Worker "ros-marketing"
packages/
  core/                operations registry, risk classes, policy types, model role registry (ai/), the judge (judge/), schema reconciler
  db/                  core D1 migrations (incl. core_base_* views), typed core schema
  auth/                IdentityProvider interface; better-auth and cloudflare-access adapters
  sdk/                 the extension contract (defineExtension, defineTool), formula language, test harness
  ui/                  shared shadcn/ui components and the view-spec renderer
  config/              shared tsconfig, biome and vitest presets
  release/             release bundles, manifest types, verification, the Cloudflare API deploy
                       engine, preflight and the update procedure (Node and Workers)
  create-relationship-os/          the installer CLI: npx create-relationship-os, ros upgrade / rollback / status
  gatekeeper-interface/ the gatekeeper RPC interface (vendored from cloudflare-os, see UPSTREAMS.md)
  gatekeeper-kit/      gatekeeper building blocks (vendored)
  gatekeeper-observability/, gatekeeper-configurator-ui/, mcp-shared/
                       what the vendored gatekeepers depend on (vendored subsets)
  gatekeeper-<name>/   gatekeeper Workers `ros-gatekeeper-<name>`: vendored (google, microsoft, slack, mcp,
                       email, zoominfo, websearch) and ours (email-send, slack-post, webhook); bound to
                       ros-runner as GATEKEEPER_<NAME> per deployment (docs/integrations.md)
extensions/
  deals/               (stage 4) Deals: pipelines, stages, deals, participants (ADR 0026, 0100)
  deals/               (stage 4) first real shipped extension
docs/
  architecture.md      this file
  roadmap.md           stage order and status
  adr/                 one record per significant decision
  stages/              per-stage agreed spec + acceptance criteria
  spikes/              time-boxed experiments and their findings
  deploying.md         install, secrets, Deploy button, upgrades
scripts/
  deploy.mjs           deploy both Workers and apply migrations (`pnpm run deploy`)
  dev-setup.mjs        local .dev.vars + local migrations (runs before `pnpm dev`)
  vendor-gatekeepers.mjs  re-copy the vendored cloudflare-os packages from an upstream checkout
  gatekeeper-worker-types.mjs  `wrangler types` for the gatekeeper Workers (`pnpm types`)
  release/             release build, manifest generator (golden test), changelog
  setup-ci-cloudflare.sh  wizard: the CI test account and its GitHub secrets
AGENTS.md              conventions every build session follows (CLAUDE.md points here)
CONTEXT.md             glossary
UPSTREAMS.md           vendored upstream code and the commit each copy tracks
```

## Prior art

- [`cloudflare/cloudflare-os`](https://github.com/cloudflare/cloudflare-os): gatekeepers,
  `gatekeeper-kit`, approval queue with simulation, release bundles and deploy page.
- [`cloudflare/computer`](https://github.com/cloudflare/computer): the Workspace filesystem and
  git. Its `worker-javascript` backend ran extension code until ADR 0043.
