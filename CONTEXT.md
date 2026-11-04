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
A user's stored list configuration (`object`, filter, sort, columns): the simplest kind of view spec.

**Trash**
Soft-deleted records (people, organisations, activities and tasks), listed by `trash.list` and
restorable for 30 days before they are purged.

**Purge**
The scheduled hard delete of records that have been in Trash for more than 30 days. It runs daily
as an `automation` (`trash.purge`) and is audited like any operation. It removes people and
organisations; deleted activities and tasks are not purged yet.

**Merge**
Folding a duplicate record into a **survivor**: chosen field values, combined emails/phones/domains
and tags, and the duplicate's affiliations, activity and task links moved over. The merged-away
record goes to Trash with a `merged_into_id` pointer and can be restored.
_Avoid_: dedupe (that is finding duplicates), combine

**Erase**
An admin-only hard delete for GDPR requests (`person.erase`, `organisation.erase`). Unlike a purge
it also **redacts** the audit log: content that mentions the record becomes `"[erased]"` (ADR 0019).
Activities and tasks only about the record are deleted; shared ones are scrubbed of its emails,
phone numbers and id, and the search index is purged of it.
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
`audit:read`, `users:manage`, `policy:manage`. Viewers have read; members read and write; admins all.

**Field registry**
Per-object field definitions (name, type, filterable, sortable, `track`). Filters, sorts and
timeline tracking are validated against it.

**Risk class**
How dangerous an operation is: `read`, `write`, `bulk-write`, `destructive`, `schema`, `extension`,
`outbound`.

**Actor**
Who initiated an operation: `human`, `assistant` (in-app AI), `mcp` (an external MCP client),
`automation`.

**Approval pipeline**
Gate → adjudicator → human queue, configured per org. It decides whether an operation applies
automatically, is denied, or waits.

**Floor**
Deploy-time (env `APPROVAL_FLOOR`) rules the per-org policy can never loosen.

**Preset**
The org's approval policy: Cautious, Balanced (default) or Autonomous. Changed by human admins only.

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
source. A commit is a version, approval reviews a diff, and rollback is a revert.

**Extension object**
A record type declared by an extension. It is stored in `x_<extension>_*` tables, which the host
reconciles from the declaration.

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

**View spec**
The JSON a dashboard or view is made of: widgets, their read-only SQL over `crm.*` views, and a chart
mapping. It is rendered by our components.

**Release bundle**
A versioned, prebuilt set of Workers + assets + manifest that the deploy service installs or upgrades
in an org's account.

**Stage**
One unit of the build roadmap. Each stage has an interview, an agreed spec in `docs/stages/`, and a
separate build session.
