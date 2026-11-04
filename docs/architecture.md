# Architecture

An AI-native CRM that each organisation deploys to its own Cloudflare account. Claude (via MCP or the
in-app assistant) can do anything a user can, including reshaping the CRM itself: new objects and
fields, dashboards, automations and custom tools are **code**, written by AI, approved, versioned and
run safely.

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
                         │   • Worker Loader dynamic workers (extension code)                │
                         │   • Workflows (long automations), Queues (record-change events)   │
                         │            │ service bindings (GATEKEEPER_*)                      │
                         │            ▼                                                      │
                         │  gatekeeper Workers (Google, Microsoft, email, Slack, MCP, …)     │
                         │   • OAuth accounts, capability APIs, actions + simulation         │
                         └─────────────────────────────┬─────────────────────────────────────┘
                                                       ▼
                                             external services
 D1 (one database) · R2 (files) · AI Gateway → Workers AI / Anthropic / … (per model role)
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
  queue and the audit log. Deletes are soft (Trash); a daily cron trigger on `crm-app` purges
  people, organisations, activities and tasks after 30 days through the operations pipeline
  (`trash.purge`), and admin erase redacts the append-only audit log through a sanctioned path
  ([ADR 0019](adr/0019-audit-redaction-for-erasure.md)).
- **Extension schema** (`x_<extension>_*` tables): declared in extension code (`defineObject`) and
  reconciled into D1 by the host, additive-first. Core migrations never touch `x_` tables.
- **`crm.*` views**: generated read views with friendly names, spelled `crm_people`,
  `crm_organisations`, … because D1 has no schemas (ADR 0015 amendment). They are what list
  operations, dashboard SQL and AI queries run against.
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

### 5. Integrations

All external access goes through **gatekeepers**: reviewed Workers in the repo that own OAuth, expose
a capability API per resource, journal actions and simulate pending ones. We adopt Cloudflare OS's
gatekeeper interface and `gatekeeper-kit` rather than inventing our own. Extension code never reaches
the network directly. `gatekeeper-mcp` lets an admin connect any MCP server at runtime.

### 6. Approval pipeline

Configurable per org ([ADR 0011](adr/0011-approval-pipeline.md)):

1. **Deterministic gate** (code): actor × risk class → `auto` / `deny` / `review`, never below the
   deploy-time floor.
2. **Policy adjudicator** (optional): the `review` model role (Jev or a second LLM) judges the
   simulated change against the org's written policy → approve / deny / escalate.
3. **Human queue**: escalations, with the adjudicator's reasoning attached.

Only human admins can change the policy. Every decision is audited.

The human queue is built (stage 2, [ADR 0022](adr/0022-approval-queue-and-simulation.md),
[ADR 0032](adr/0032-mcp-sessions-and-approval-mechanics.md)); the adjudicator comes in stage 7.
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

### MCP

`/mcp` on `crm-app` ([ADR 0021](adr/0021-mcp-surface.md), ADR 0032): `workers-oauth-provider`
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

In `crm-app`, one TanStack Start request middleware resolves the **Principal** for every page
route, server route and server function call. Everything is private by default: only `/sign-in`,
`/api/health`, the adapter's own routes (`/api/auth/*`) and server functions in `*.public.ts` files
are reachable without one. The OAuth routes (`/oauth/*`, `/.well-known/oauth-*`) and `/mcp`
are handled before TanStack Start by the OAuth provider, which checks Bearer tokens itself. A request without a Principal is redirected to sign-in (pages, Better
Auth) or gets a 401 (APIs, server functions, and any request under Cloudflare Access).

### 8. AI

**Model roles** (`build`, `assistant`, `summarise`, `extract`, `classify`, `embed`, `vision`,
`review`) map to a provider and model in a core model registry, which checks capabilities. All calls
go through AI Gateway ([ADR 0009](adr/0009-model-roles.md)). Code asks for a role, never a model.

### 9. Dashboards and views

A view spec rendered by our own shadcn/chart components. Widgets query with read-only SQL over the
`crm.*` views: the SQL is checked by a SQLite-faithful tokenizer validator (one SELECT/WITH,
`crm_*` views only), takes bound params, and runs with row and time limits
([ADR 0020](adr/0020-query-sql-validator-and-csv-import.md); `validateReadOnlySql` in `@crm/core`,
used by `query.sql`). Computed widgets are extension code. Extensions never ship UI
([ADR 0010](adr/0010-dashboards-sql-views.md)).

## Repository layout

```
apps/
  app/                 TanStack Start + shadcn UI, server functions, /mcp       → Worker "crm-app"
  runner/              extension runtime, automations, Workflows, Queues         → Worker "crm-runner"
packages/
  core/                operations registry, risk classes, policy types, model-role registry (pure TS)
  db/                  core D1 migrations, typed core schema, (later) schema reconciler + crm.* views
  auth/                IdentityProvider interface; better-auth and cloudflare-access adapters
  sdk/                 the extension contract: defineObject / defineDashboard / defineAutomation / defineTool
  ui/                  shared shadcn/ui components and the view-spec renderer
  config/              shared tsconfig, biome and vitest presets
  gatekeeper-interface/ the gatekeeper RPC interface (vendored from cloudflare-os, see UPSTREAMS.md)
  gatekeeper-kit/      gatekeeper building blocks (vendored)
  gatekeeper-observability/, gatekeeper-configurator-ui/, mcp-shared/
                       what the vendored gatekeepers depend on (vendored subsets)
  gatekeeper-<name>/   gatekeeper Workers `crm-gatekeeper-<name>`: mcp and google so far (vendored,
                       not yet bound to the runner; stage 6 wires them in)
extensions/
  deals/               (stage 4) first shipped extension
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
  release/             (later) bundle builder + manifest
AGENTS.md              conventions every build session follows (CLAUDE.md points here)
CONTEXT.md             glossary
UPSTREAMS.md           vendored upstream code and the commit each copy tracks
```

## Prior art

- [`cloudflare/cloudflare-os`](https://github.com/cloudflare/cloudflare-os): gatekeepers,
  `gatekeeper-kit`, approval queue with simulation, release bundles and deploy page.
- [`cloudflare/computer`](https://github.com/cloudflare/computer): Workspace filesystem, git, the
  `worker-javascript` backend and host modules.
