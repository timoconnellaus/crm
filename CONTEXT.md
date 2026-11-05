# Context: domain glossary

Use these words exactly, in code, docs and UI copy. Add to this file when a new term earns its place.

**Deployment**
One installed copy of the CRM in one organisation's Cloudflare account. It holds one org's data and is
the isolation boundary. There is no tenant id in the data model.
_Avoid_: tenant, instance (except "Cloudflare OS instance" when quoting upstream)

**Org**
The organisation that owns a deployment. Its users, settings and policy live in that deployment.

**Core object**
A built-in record type with core tables and migrations: **Person**, **Organisation**, **Activity**,
**Task**.
_Avoid_: Contact (use Person), Company/Account (use Organisation)

**Affiliation**
A Person's link to an Organisation: title/role, start, end, `current`. One per person is primary.
Ending one and starting another is a **job change**.
_Avoid_: employment, membership

**Timeline-worthy field**
A field flagged `track: "timeline"`, whose changes post a `system` Activity on the record.

**Saved view**
A stored view of one object's records: a name and an object view spec (table, board, calendar or
gallery). Personal, or **shared** with the org (everyone sees it; its owner and admins change it).

**Board**
A view that groups records into columns by a single-select field, with a count and an optional
sum per column. Moving a card runs the object's update operation.
_Avoid_: kanban (in code and copy; fine as a synonym in prose)

**Dashboard**
A title, filters and widgets on a grid. Personal or shared; the shipped **Overview** lives in
code, and extensions can ship read-only dashboards (Deals' **Sales overview** and **Pipeline
health**). Any dashboard can be a user's **Home** (the page at `/`); the default is Sales overview
while Deals is installed, else the Overview.

**Widget**
One tile on a dashboard: KPI, bar, line, donut, funnel, table, leaderboard or markdown. Data
widgets run read-only SQL over `crm_*` views with named params bound from the dashboard's filters.

**Click-through**
A widget's filter template: clicking a segment, KPI or row opens the matching records as a
filtered list, exactly the records the widget counted.

**Relative value**
A filter value that resolves when the list runs: `{ "$relative": "me" }`, `"today"`,
`"startOfMonth"`, `"startOfQuarter"` and so on. Saved views such as "My open deals" use them so
they stay right for whoever opens them, whenever.

**Record tab / record panel**
A tab or side-panel card that an extension declares on another object's record page: a view spec
filtered to the records related to the one shown.

**Trash**
Soft-deleted records (people, organisations, activities and tasks), listed by `trash.list` and
restorable for 30 days before they are purged.

**Purge**
The scheduled hard delete of records that have been in Trash for more than 30 days. It runs daily
as an `automation` (`trash.purge`) and is audited like any operation. It removes deleted people,
organisations, activities and tasks, with their links and search entries. Live activities and
tasks linked to a purged record stay and lose only that link.

**Read counts**
Successful reads by non-human actors (MCP, assistant, extension, automation), counted per hour,
actor, user, caller and operation in `core_audit_read_counts` instead of one audit row each
(`audit.readCounts`). Failed or refused reads still get an audit row (ADR 0090).

**Audit retention**
How long write audits are kept: forever by default, or 1, 2 or 7 years (human admins only,
`audit.setRetention`). The daily cron's `audit.purge` deletes older audit rows through **purge
markers** (`core_audit_purges`), the only way past the append-only triggers besides erase.

**Compaction**
30 days after a pending action was decided or expired, its input, preview and simulated records
are replaced by a `summary` (records touched by action, sizes); who decided what, and when, stays.

**Merge**
Folding a duplicate record into a **survivor**: chosen field values, combined emails/phones/domains
and tags, and the duplicate's affiliations, activity and task links moved over. The merged-away
record goes to Trash with a `merged_into_id` pointer and can be restored.
_Avoid_: dedupe (that is finding duplicates), combine

**Erase**
An admin-only hard delete for GDPR requests (`person.erase`, `organisation.erase`). Unlike a purge
it also **redacts** the audit log: content that mentions the record becomes `"[erased]"` (ADR 0019).
Activities and tasks only about the record are deleted; shared ones are scrubbed of its emails,
phone numbers and id, and the search index is purged of it. Pending actions that touch or mention
it are redacted, and rejected if still waiting.
_Avoid_: purge (that is retention), delete (that is soft)

**Activity**
One entry on a record's timeline: a note, email, call, meeting or system event.

**Operation**
One thing a user or AI can do, defined once in the operations registry with zod input/output, a
model-facing description, a permission and a risk class. It is exposed as a server function, an MCP
tool and a host module.
_Avoid_: endpoint, action (an "action" is a gatekeeper term, below)

**Permission**
What an operation requires of the caller's role: `records:read`, `records:write`, `records:erase`,
`audit:read`, `users:manage`, `policy:manage`, `extensions:manage`, `settings:manage`. Viewers have read; members read and write; admins all.

**Field registry**
Per-object field definitions (name, type, filterable, sortable, `track`). Filters, sorts and
timeline tracking are validated against it.

**Risk class**
How dangerous an operation is: `read`, `write`, `bulk-write`, `destructive`, `schema`, `extension`,
`outbound`.

**Actor**
Who initiated an operation: `human`, `assistant` (in-app AI), `mcp` (an external MCP client),
`automation`, `extension` (extension code through `codemode:crm`).

**Approval pipeline**
Gate → adjudicator → human queue, configured per org. It decides whether an operation applies
automatically, is denied, or waits.

**Floor**
Deploy-time (env `APPROVAL_FLOOR`) rules the per-org policy can never loosen.

**Preset**
The org's approval policy: Cautious, Balanced (default) or Autonomous. Changed by human admins only.

**Pending action**
One operation call the gate routed to review, recorded instead of applied: operation, input, the
agent's reason, actor, user, origin, risk class, a diff preview, the simulated result and its
dependencies. It is `pending` until a person approves it (`applied`, or `failed` if the record
changed or vanished meanwhile) or rejects it (`rejected`), or until it is `skipped` because
something it depends on did not apply, or `expired` (after 7 days by default).
_Avoid_: draft, proposal, request

**Change set**
The pending actions a person reviews together. By default one per MCP session; Claude can open a
titled one with `changeset.begin` and finish it with `changeset.commit`. It is approved or
rejected whole or item by item in the **Approvals inbox** (`/approvals`).
_Avoid_: batch (that is a `*Many` operation), transaction

**Pending-change badge**
The badge on a record's header and list row while a pending action would change it. Its popover
lists the actions and links to their change set. The record itself still shows real data.

**Provisional ID**
The id a pending create gives its record (`per_pending_…`) so later pending actions in the same
session can refer to it, e.g. log an activity on a person not yet approved. Approval binds it to
the real id; it never reaches other sessions or the UI.

**Connected app**
An MCP client (Claude Desktop, claude.ai, Claude Code, …) a user authorized over OAuth, with the
scopes they granted (`read`, `write`, `admin`). It is also the MCP session that pending actions
belong to. Users revoke their own in Settings → Connected apps; admins can revoke anyone's.
_Avoid_: integration (that is a gatekeeper), token, client (when you mean the authorization)

**Adjudicator**
The optional AI reviewer (model role `review`) that judges pending changes against the org's
**written policy**.

**Extension**
A unit of customisation written as code against the SDK contract (`defineObject`, `defineDashboard`,
`defineAutomation`, `defineTool`). A **shipped extension** lives in `extensions/`. A **runtime
extension** is written by AI and stored in the extension workspace.
_Avoid_: package (that means a pnpm workspace package), plugin, app

**Extension workspace**
The `@cloudflare/computer` Workspace (Durable Object filesystem + git) that holds runtime extension
source and the build cache. A commit is a version, approval reviews a diff, and rollback is a
revert. It runs no code: the executor does.

**Executor**
What runs extension code, from ros-runner's stateless entrypoint (and from Workflow steps in stage
5). Each run gets a Dynamic Worker from `LOADER.get` with a **stable loader id**, and its context
arrives as RPC arguments.
_Avoid_: sandbox host (for the DO)

**Stable loader id**
The deterministic Worker Loader id of code that runs more than once. For a tool it hashes the
extension id, commit, host-module set, SDK and runtime hash, contract version and compatibility
settings. The same inputs always mean the same code. Only throwaway code (Code Mode scripts) runs
without one, through `load()`.

**Extension object**
A record type declared by an extension. It is stored in `x_<extension>_*` tables, which the host
reconciles from the declaration.

**Extension principal**
The identity an extension's code acts as: `extension:<id>`, a `core_user` row of kind `extension`
that never signs in. Its calls go through the gate as actor `extension`, limited to the extension's
declared permissions (objects it may read or write, operations, host modules). Those permissions
are approved like OAuth scopes: a version that asks for more (**widening**) is shown as such on its
proposal and always waits for an admin.

**Working copy**
An extension's files in the extension workspace as they are now, including edits not yet
committed. `extension.write` changes it; `extension.check` checks it; `extension.propose` commits
it. Nothing in a working copy is live.
_Avoid_: draft (in the approval sense), branch

**Extension proposal**
A committed version of an extension waiting for approval: one pending action (`extension.apply`)
in the proposer's change set, with the diff from the installed version, the host-computed impact
(schema changes, permissions requested or widened, host modules, tools, triggers), the check
result and an AI-written summary. Approving it installs that commit.

**Eject**
Taking over a shipped extension as a runtime one: `extension.eject` copies its source into its
working copy, and once a proposal for it is approved it is a runtime extension that new releases no
longer update. Without ejecting, a shipped extension can only be **extended** (fields on its
objects, views and tools from another extension), never modified.
_Avoid_: fork

**Code Mode**
The MCP `code` tool: a short ES module the client model writes runs in a throwaway sandbox as the
connected user (actor `mcp`), calling operations through `codemode:crm` under the same gate and
simulation as the other tools. It needs write permission, runs one script per user at a time, and
is rate limited.

**Extension tool**
A function an extension declares with `defineTool`. It is an operation named `x.<extension>.<tool>`
and runs in the sandbox.

**Formula field**
An extension field computed from other fields of the same record by a small typed expression
(`coalesce(budget, 0) - coalesce(spent, 0)`). It is parsed and type-checked by `extension.check`,
compiled to SQL in the `crm_*` view, so it can be filtered and sorted, and it is never written. No
cross-record rollups.

**Deal**
A potential sale (`deals.deal`, from the shipped Deals extension) moving through a pipeline: value
in the base currency, stage, probability, owner, organisation, expected close, and a won/lost date
set automatically. **Deal participants** are the people on it, each with a role.
_Avoid_: opportunity

**Pipeline**
An ordered set of stages deals move through ("New business", "Renewals"). Pipelines and their
stages are records, edited under Settings or by AI through record operations.

**Pipeline stage**
One step of a pipeline: its order, its type (`open`, `won` or `lost`), a default probability and
its **stage rules**. In code and UI copy "stage" means this when talking about deals; the build
roadmap's stages are a different word (see **Stage** below).

**Stage rule**
A field a stage requires before a record may enter it (Proposal needs a value and an expected close
date; Lost needs a lost reason). The host enforces it in the record operations for every actor and
refuses a move with an error naming the missing fields.

**Stage behaviour**
The contract's declarative `stages` key (ADR 0100): it makes an extension object move through stage
records with stage rules, probability, status, a closed date, stage history and "Moved to" posts.
Deals uses it; AI-written extensions can too.

**Stage history**
One row per stage a record has been in, with entered and left times (`crm_stage_history`). It powers
time in stage and velocity.

**Base currency**
The deployment's one currency (Settings → General). Currency fields without their own currency
show in it. Changing it relabels amounts; there is no FX.

**Seed record**
A record an extension declares to be created once when its object is installed (the default
pipelines and stages), with a deterministic id.

**Quarantine**
What happens to an extension after 3 consecutive failed runs: it is disabled (status
`quarantined`, with the reason), admins see it on Settings → Extensions, and its last-known-good
version is offered for rollback. Enabling it again resets the failure counter. Failures that are
the caller's (invalid input, unknown tool) do not count.

**Last-known-good**
The most recent installed version (commit) of an extension that completed a run without failing.

**Automation**
Extension code declared with `defineAutomation`: a **trigger**, optional declarative conditions,
declared **steps** (with intents: what they read, write, notify and wait for) and a `run` handler
shaped like a Cloudflare Workflow. The host renders its plain-English **summary** and **step
diagram** from the declarations, never from AI. Enabled, disabled (an admin's choice) or paused (a
safety rail tripped). Id `<extension>.<key>`, e.g. `deals.wonOnboarding`.
_Avoid_: workflow (that is the Cloudflare primitive a run executes on), rule, flow

**Trigger**
What starts an automation's runs: a record event (`created`, `updated`, `deleted`, `restored`), a
field change (from / to), a `schedule` (cron in the automation timezone), `dateRelative` (N days
before or after a date field, daily), `manual` (a record button or bulk action) or
`approvalDecided`. Webhooks and sync events arrive in stage 6b.

**Run**
One execution of an automation, on a Cloudflare Workflow whose id derives from the run's
idempotency key, so a duplicate event never runs twice. Statuses: queued, running, waiting (a
sleep or wait), review (paused on a pending action), completed, failed, cancelled, expired,
skipped. Kept 30 days (failures 90). Each `step.do` runs in a Dynamic Worker as actor `automation`.

**Test mode**
A dry run of an automation against a chosen record through the simulation overlay: nothing is
written, waits are skipped and shown, and it reports the writes, notifications and approvals the
real run would produce.

**Cascade**
Automation-caused changes triggering further automations. Events carry the cascade depth and chain;
depth is capped at 3 (deeper events are dropped and logged) and an automation never retriggers
itself on the same record within one cascade (cycle detection).

**Kill switch**
An org setting that pauses every automation at once: no new runs start and running ones stop at
their next step. Only a human admin can engage or release it.
_Avoid_: emergency stop, pause all

**Notification**
A typed message to one user in the in-app notification centre (the bell and inbox), with a link
to a record, approval, automation or run, read or unread. Sent with `notification.send` by
automations, approvals and the system. Its type lets stage 6b route it to email or Slack.
_Avoid_: alert, message (when you mean the stored notification)

**Host module**
A `codemode:*` import that extension code can call, backed by trusted host code. Examples:
`codemode:crm` (operations), `codemode:ai` (model roles), `codemode:<gatekeeper>`.

**Gatekeeper**
A Worker that mediates all access to one external service. It handles OAuth accounts, exposes a
capability API per resource, journals actions and simulates pending ones. The term and interface
come from Cloudflare OS.
_Avoid_: connector, integration (when you mean the Worker)

**Integration**
The user-facing name for a connected gatekeeper ("Gmail integration").

**Connection**
One connected gatekeeper account: **personal** (a user's own; only that user's actors may use it)
or **org** (set up by an admin, e.g. a shared inbox or the company Slack; everyone's actors use it).
It has an owner, a sharing level, a status (connecting, active, expired, error, disconnected) and
its bound **resources** (a mailbox, a calendar, a Drive folder, a Slack workspace, a webhook
endpoint), each served by one gatekeeper facet. Settings → Integrations manages them.
_Avoid_: connected app (that is an MCP client), account (the provider's side)

**Integration host**
The Durable Object in ros-runner, one per connection, that implements the Workshop side of the
gatekeeper interface: it owns the connection's account, facets and hooks, runs the connect handoff,
decides outbound actions and observations, and runs sync. D1 only mirrors its state for the UI.

**Sharing level**
How much a connection's synced mail and meetings disclose to the CRM, chosen by its owner: *full*
(subject, participants, time and content), *metadata* (subject, participants and time) or *none*
(don't sync). Writing into the shared CRM is the point of disclosure. A synced activity can also be
marked **private** afterwards (only its owner sees it).

**Outbound action**
A side effect a gatekeeper submits (send an email, post to Slack, spend ZoomInfo credits). It is
gated as risk `outbound` by its **action kind** (`email.send`, `slack.post`); under Balanced it
waits in the Approvals inbox unless the gatekeeper marks the kind auto-approvable and an admin
enabled it. Approving it makes the gatekeeper apply it, in order per resource.
_Avoid_: operation (an outbound action is not in the registry)

**Suggested contact**
An external address the org has exchanged mail with at least twice that matches no person,
shown grouped by domain in the Suggested contacts inbox for one-click add. Nothing is created
automatically. The inbox also lists suggested **job changes** from mail (a bounce, a new signature,
a new domain), applied with `person.changeJob` on confirmation.

**Integration event**
An inbound event for automations: a verified webhook delivery (typed, e.g. `invoice.paid`) or a sync
event (`email.received`, `meeting.updated`). Kept 90 days; stage 5 turns them into triggers.

**Principal**
The authenticated caller of a request: `{ userId, email, name, roles }`, resolved by the identity
adapter for every route and server function.
_Avoid_: user (when you mean the caller of a request), session

**Identity adapter**
The deploy-time choice of how a Principal is resolved: `better-auth` (default) or
`cloudflare-access`, selected by `IDENTITY_PROVIDER`. Implements `IdentityProvider`.

**Model role**
A named AI job (`build`, `assistant`, `summarise`, `extract`, `classify`, `embed`, `vision`, `review`)
mapped to a provider + model in the model registry. Code asks for a role, never a model.

**Model role registry**
The core table (`packages/core/src/ai/roles.ts`) that resolves each model role to
`{ provider, model, params, fallback }` through three layers: shipped defaults (every role on
Workers AI), deploy config (`AI_MODEL_ROLES`) and admin overrides (Settings → AI, stored in
`core_settings`, settings only). Each role declares the capabilities it needs (tool use, JSON
output, context size, vision, embeddings); the registry rejects a model that lacks one. "JSON
output" is met by JSON mode (`json_object`) or a JSON schema; no role sends a schema yet
(ADR 0192). Calls run through the AI SDK and AI Gateway (ADR 0150). Provider keys are Workers
secrets or AI Gateway BYOK, never D1 (ADR 0151).
_Avoid_: model config, LLM settings

**Model role preset**
A named, ready deploy-config layer (`ROLE_PRESETS` in `roles.ts`) that one deployment chooses
with `create-relationship-os --model-roles <name>` (or `ROS_AI_MODEL_ROLES` for `pnpm run deploy`). It
becomes that deployment's `AI_MODEL_ROLES` and never changes the shipped defaults. The first is
`deepseek-flash`: every role but `embed` on DeepSeek V4.1 Flash with Workers AI fallbacks
(ADR 0192).
_Avoid_: profile, model pack

**AI summary**
Text written by the `summarise` role about a record, a meeting (meeting prep), a long activity
(one-liner) or a change set, cached in `core_ai_summary` by a hash of its inputs and the model:
it is stale as soon as anything it was built from changes. Always labelled "AI-generated" and only
generated on request (ADR 0153).

**Semantic search**
Search by meaning: records' text embedded by the `embed` role into Vectorize, re-embedded only
when the text's hash changes, merged with full-text results by rank (hybrid search). Powers Cmd-K's
"Related by meaning", Similar records and the assistant's retrieval (ADR 0154, ADR 0155).
_Avoid_: vector search (for the feature; Vectorize is the store)

**View spec**
The JSON a view is made of, rendered by our components: a discriminated union of `table`, `board`,
`calendar`, `gallery` and `dashboard` (filters and widgets with read-only SQL over `crm_*` views
and a chart mapping). See ADR 0056 and ADR 0057.

**Release bundle**
One versioned, reproducible `crm-<version>.tar.gz` holding every Worker's modules, ros-app's static
assets, the core migrations and the **release manifest** (generated from the `wrangler.jsonc` files,
with placeholders such as `$ACCOUNT_ID` and `$D1_ID(ros)` for account-specific values). Published as
a GitHub Release asset with SHA256SUMS and a build attestation; `create-relationship-os` installs it and the
**self-updater** upgrades to it. See ADR 0053 and ADR 0160.
_Avoid_: build, artifact (for the bundle as a whole), package

**Channel**
Which releases a deployment is offered: **stable** (`X.Y.Z` only) or **beta** (also `X.Y.Z-beta.N`).
Set in Settings → Updates. See ADR 0161.

**Preflight**
The check before an update, computed from the installed and target manifests and the database: runtime
extensions against the new extension contract, pending core migrations, gatekeeper changes and new
secrets or inputs. A **blocker** refuses the update and says what to do. See ADR 0164.

**Self-updater**
Settings → Updates: a deployment updating itself from GitHub Releases with an optional scoped API
token (`ROS_UPDATE_TOKEN`). It runs the same procedure as `ros upgrade`: pause automations, take a D1
Time Travel bookmark, migrate, switch all Workers together, smoke-check, resume; **rollback**
redeploys the previous bundle and restores the bookmark. See ADR 0054 and ADR 0164.

**Setup wizard**
The first-run steps an admin sees after install (`/setup`): account, organisation, AI, approval policy,
connect or import, sample data. Skippable and resumable. **Sample data** is removed in one click. See
ADR 0167.

**Stage**
One unit of the build roadmap. Each stage has an interview, an agreed spec in `docs/stages/`, and a
separate build session.
