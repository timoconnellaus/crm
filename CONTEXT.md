# Context: domain glossary

Use these words exactly, in code, docs and UI copy. Add to this file when a new term earns its place.

**Relationship OS**
The product: an AI-native CRM that runs in your own Cloudflare account (ADR 0190). Short name
`ros` in Worker and resource names (`ros-app`, `ros-runner`, `ros-records`), `relationship-os` in
package names (`@relationship-os/*`, `create-relationship-os`). "CRM" stays the category word, and
the name of the operations API inside extension code (`codemode:crm`, `ctx.crm`, the `crm_*` views).
_Avoid_: "the CRM" as the product name in UI copy

**Pre-rename install**
A deployment made by a release from before the rename: Workers `crm-app`, `crm-runner`,
`crm-gatekeeper-*`, the D1 database `crm` and `crm-*` resources. It keeps those names for good; the
deploy engine maps the new names onto them (`workerNames`, `resourceNames`).

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
and tags, the duplicate's affiliations, activity and task links moved over, and every extension
relation field that pointed at the duplicate re-pointed at the survivor (ADR 0247). The merged-away
record goes to Trash with a `merged_into_id` pointer and can be restored.
_Avoid_: dedupe (that is finding duplicates), combine

**Duplicate rule**
A plain rule in code that says two records may be the same, with a reason sentence ("Same name and
same organisation: Acme"). People: same email (creation and import only), same name and
organisation, same name and email domain, same phone number, same name only. Organisations: same
domain, same name. There is no score; a pair can match several rules and all are shown (ADR 0247).
_Avoid_: match score, similarity, confidence

**Name key**
A person's or organisation's name normalised by fixed code (`name_key`): lower case, diacritics
gone, "Family, Given" reordered, middle initials and legal forms dropped. Every write that sets a
name writes it, so duplicate rules are indexed lookups. Two records with equal keys have the same
name for every duplicate rule.

**Duplicate pair**
Two records the scan found by at least one duplicate rule (`core_duplicate_pair`), `open`,
`dismissed` ("Not duplicates", never suggested again) or `merged`. Pairs that share a record show
as one group on the Duplicates page, with a proposed survivor: more activities, then the older.

**Erase**
An admin-only hard delete for GDPR requests (`person.erase`, `organisation.erase`). Unlike a purge
it also **redacts** the audit log: content that mentions the record becomes `"[erased]"` (ADR 0019).
Activities and tasks only about the record are deleted; shared ones are scrubbed of its emails,
phone numbers and id, and the search index is purged of it. Pending actions that touch or mention
it are redacted, and rejected if still waiting. In-app assistant threads that referenced it
are redacted too (ADR 0019 amendment). It also reaches sync, extension data, run history,
notifications, events and synced email bodies, and puts a person's addresses on the
**erased-address list** (ADR 0320).

**Erased-address list**
`core_erased_address`: SHA-256 hashes of erased people's email addresses (never the addresses).
Sync drops a listed address from everything it ingests: participants, links, suggestions,
signatures and the sender's own words. An admin removes an entry with `erasure.allowAddress` when
the person comes back by consent.
_Avoid_: blocklist, suppression list (that is email sending)

**Erase log**
One R2 object per erase (and per allowed address) holding only hashes of the erased ids and
addresses, outside the restorable database. `erasure.reapply` reads it after a D1 restore and erases
again whatever came back.
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
Gate → policy adjudicator → human queue, configured per org. It decides whether an operation applies
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

**Policy adjudicator**
The optional AI reviewer (model role `review`) that judges each pending action the gate routed to
review against the org's **written policy**: `approve`, `deny` or `escalate`, with a confidence
and a reason (ADR 0031, ADR 0204). Its mode is `off`, `shadow` or `active`. In active mode an
`approve` at or above the confidence threshold is applied as the original actor and attributed to
the adjudicator (`decided_by = adjudicator`); everything else, a `deny` included, stays for a
person. It never approves what the **floor** or an always-reviewed operation (extension installs)
routed to review, nor outbound, schema or extension changes. Its **verdicts** are shown to human
approvers only, never to the actor, and every one is stored (`core_adjudication`) and audited
(`adjudicator.verdict`). Its **reviewer** is the LLM (model role `review`) or Jev through the
**Judge** (placement `adjudicator.policy`), Jev by default while the judge has a key (ADR 0204,
ADR 0230, ADR 0233).
_Avoid_: adjudicator alone in UI copy, AI approver

**Shadow mode**
The adjudicator's first mode once switched on: it judges and records verdicts, and approvers see
them next to each item in the Approvals inbox, but it never acts. The **agreement rate** (how its
approve and deny verdicts match people's decisions, with a verdict × decision confusion matrix, by
day or week) shows whether to trust it. Only an admin switches it to active, and only from shadow.

**Written policy**
The org's plain-language rules the policy adjudicator judges by: what may be approved, what must be
denied, what needs a person. Only human admins edit it (`adjudicator.setPolicy`, audited). Each
save is a new version with a SHA-256 hash; every verdict records the version it used. For the Jev
reviewer it is a list of **policy rules**: one per line, split and numbered by code (`policyRules`),
a section heading qualifying the rules beneath it ("Never: Delete any record"), at most 60. Jev
never sees the agent's reason, so a rule that allows a change only on what the reason says is
never met (ADR 0233).
_Avoid_: prompt, rules file

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

**Lead**
Inbound interest (`leads.lead`, from the shipped Leads extension, which requires Deals): a
lightweight item linked to a real person, a real organisation or both, with a lead status, a source
and an owner. A lead never holds copies of the person's or organisation's details.
_Avoid_: prospect, a "lead" person record

**Lead status**
Where a lead is: new, contacted, qualified, unqualified (with a reason) or converted. Admins can
add, rename and reorder statuses and sources under Settings → Extensions. Converted is set only by
conversion.

**Conversion**
Turning a lead into a deal with `leads.convert`: a deal on the lead's organisation and owner, with
the lead's person as a participant and each record linked to the other. Nothing is copied. Safe to
run again after a failure; a converted lead cannot be converted again.

**Lifecycle stage**
Where a person is in their relationship with you (subscriber, lead, marketing qualified, sales
qualified, opportunity, customer, evangelist, other), from the opt-in shipped `lifecycle` extension.
Conversion moves a person to opportunity; nothing else moves it automatically.

**Assignment rule**
A core rule per object with an owner field (person, organisation, leads, deals): ordered conditions
on the record or a record it links to, and a method (round-robin among chosen users, or one user).
The first enabled rule that matches owns a record created without an owner. Rules run on create and
when someone chooses Assign by rules, never on update.

**Fallback owner**
The owner an object's records get when no assignment rule matches. "No owner" is allowed.

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
`approvalDecided`, a `webhook` (a verified delivery to an endpoint, optionally of given event types)
or a `syncEvent` (email/calendar sync wrote, changed or removed an activity linked to a known
person or organisation; the activity is the trigger record).

**Connection binding**
A person's consent that an automation uses a connection: the automation declares named
connections it needs (`connections: [{ id, gatekeeper, purpose }]`) and someone binds each to a
connection they own (or, an admin, to an org connection). Steps then act through it as the
connection's owner. Recorded with who and when; revoking it, disconnecting or expiring the
connection, or deactivating its owner pauses the automation and tells the admins. An automation
with an unbound connection is "Waiting for connections".
_Avoid_: grant (that is a gatekeeper's resource access), run-as user

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
automations, approvals and the system. Its type routes it to email or Slack per the recipient's
preferences (ros-runner's minute cron delivers them, ADR 0172).
_Avoid_: alert, message (when you mean the stored notification)

**Notification preference**
A person's choice, per notification type, of whether a notice also reaches them by email or Slack
DM (in-app is always on), and whether they get the daily digest in the app (on by default) and by
email (off by default).

**Daily digest**
Once a day, from the admin's digest hour in the automation timezone, one summary per person:
changes others (including the assistant and automations) made to records they own or are assigned
in the last 24 hours, their tasks due today or overdue, the approvals waiting (for people who can
approve) and their unread notices. It arrives as an in-app `digest` notification when there is
news, and by email when they asked for it, at most once a day, optionally opening with a labelled
AI overview (ADR 0206). Activities are never part of it.
_Avoid_: daily summary, newsletter

**Channel route**
An admin rule that posts a short message with a link to a Slack channel when a record of an object
is created, updated, deleted or has a field change (e.g. deal won → #sales); activities are never
routed.

**Escalation**
An unread "Approvals waiting" notice sent again by email or Slack after the admin's delay; an
escalation is never escalated.

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
event (`email.received`, `meeting.updated`). Kept 90 days; ros-runner's minute cron turns them
into `webhook` and `syncEvent` triggers and marks them consumed.

**Outbox** (automation events)
Where an operation's automation events are written in the same batch as its change, sent to the
queue after commit and deleted; ros-runner's cron retries any that are left, so a failed send
never loses an event.

**Principal**
The authenticated caller of a request: `{ userId, email, name, roles }`, resolved by the identity
adapter for every route and server function.
_Avoid_: user (when you mean the caller of a request), session

**Identity adapter**
The deploy-time choice of how a Principal is resolved: `better-auth` (default) or
`cloudflare-access`, selected by `IDENTITY_PROVIDER`. Implements `IdentityProvider`.

**Assistant**
The in-app AI, named "Assistant" by default and renamed in Settings → General (`assistantName`;
never "Claude"). Each person has one, with one **thread**. Its front agent answers with the
`assistant.core` model role and acts as actor `assistant` for the signed-in person, as an MCP
client of our own MCP server (the same tools, gate, change sets and simulation as an external
client). It opens docked on any page, at `/assistant`, from "Ask AI" on records and "Ask about N
selected" on lists, and knows the page, record and selection (ADR 0030, ADR 0200, ADR 0340).
_Avoid_: Claude, chatbot, copilot

**Thread**
A person's one chat with their assistant, which never resets: an `AssistantAgent` Durable Object
named `user:<userId>` plus one `core_assistant_thread` row. A **turn** is one message and
everything the assistant did to answer it. Older messages stay searchable (`thread.search`). "Your
chat" in the UI (ADR 0340).
_Avoid_: conversation (stage 7b had many per person; there is now one), session

**Prefix** and **tail**
What a turn sends the model, in two parts (ADR 0341). The prefix (instructions, tools, memory, the
"where we left off" note, then the messages since) is byte-stable across turns so the provider's
prompt cache keeps hitting; its hash is recorded per turn. The tail is what changes every turn
(pending memory lines, page context, display facts, the time), sent as a `<context>` block at the
start of the new user message and kept with that message afterwards. The person never sees it.

**Playout**
What the person actually heard of a spoken reply: `spoken`, `partly_spoken` (with the words
`unsaid`) or `unspoken`, worked out from the milliseconds the browser played. The model is shown
only what was heard (ADR 0349).

**Dictation**
The mic in the chat box: words stream into the box, a cleanup pass tidies them, and the message
is sent as if typed. Not **voice chat**, where the assistant talks back and messages show in
italics with a mic (ADR 0349).
_Avoid_: voice input

**Thread compaction**
Folding a thread's older messages into a short "where we left off" note, keeping the last ~10
exchanges, when a cost model says it is cheaper, between 24k tokens and 80% of the model's window
(ADR 0341). The messages themselves stay, and stay searchable; the model just stops being sent
them. Different from **Compaction** of pending actions.

**Memory line**
One thing the assistant remembers about the person, shown on "What your assistant remembers":
**personal**; a **shortcut** ("the pipeline" means …); the **writing style** section;
**conditional**, with a view-style filter, used only on matching records; or **team**, shared and
governed by a workspace setting (open, approval, restricted). A **pending** line was saved since the
last thread compaction and sits at the end of the context until it is folded in. A **proposed** line
waits to be read back and confirmed, or for a team line's approval. Written inline, checked by Jev,
never a fact about a customer: those go on the record as a proposed note (ADR 0342).
_Avoid_: note (that is on a record), fact

**Routine**
A personal automation (`owner_user_id`, scope `personal`) that messages the person's thread: a
trigger, plain and Jev gates, and the step "message me in my chat". "My routines" in settings and
plugin pages; in chat the assistant offers the outcome and never says "routine" (ADR 0343). The
person turns it on from a **read-back** card with a **backtest** over the last 30 days. A delivered
message has an info dot with a **why panel**: what they asked, when, the trigger and the checks.
_Avoid_: reminder, alert, task

**Agent (UI) / job (code)**
Longer work the assistant hands off: an `AgentJob` Durable Object named `job:<jobId>`, awaited or in
the background, with a brief, the records, read-only memory and a **grant**. It stages changes for
review and never chats. "Agents" in the UI; `job` in code and storage (ADR 0344). A CRM **Task** is
a to-do on a record, and a **job change** is a person's new employer: both unrelated.
_Avoid_: task, subagent (in UI copy), worker

**Agent profile**
A named kind of agent (researcher, drafter, importer, analyst, or one from a plugin): instructions,
a default grant, a budget and a model role, never a model.
_Avoid_: job profile, persona

**Grant**
What one agent may do: operations, a target set (ids or a filter), count caps and an expiry. Never
wider than its starter (a user, routine or plugin), and checked by Jev against the brief (ADR 0344).
Different from a **Support grant**.
_Avoid_: permission (that is a role's), scope

**A2UI producer**
A saved Code Mode script, usually shipped in a plugin, that queries the CRM and returns an A2UI card
from the versioned catalogue with no model call, run on a stable loader id (ADR 0346). It reads as
the viewer and can change nothing. An A2UI card is a rich message from that catalogue, stored with
a text fallback. A button on a card the model or a producer wrote runs as the assistant, so the
approval policy applies.
_Avoid_: widget (that is on a dashboard), template

**Plugin**
A bundle of assistant and CRM items (skills, saved code, A2UI producers, routines, agent profiles,
presets, dashboards, views, extensions, connection needs) described by `plugin.json`, installed at
personal, team or role (optionally **locked**), or org scope (ADR 0347).
_Avoid_: extension (that is code that changes the CRM; a plugin may contain one), app, add-on

**Plugin copy**
What installing a plugin creates in the owning scope, stamped with the source version's
fingerprint. An unchanged copy updates by itself; an edited one is compared and merged; a detached
one ("Stop updates") no longer updates.

**Connected assistant**
A colleague's assistant, in the same workspace, that yours may exchange messages with under a
**contract**: numbered rules in plain English tagged Automatic, Asks you or Never, agreed by both
people. Every message is checked by Jev and logged (ADR 0348).
_Avoid_: agent-to-agent (in UI copy), connection (that is a gatekeeper account)

**Model role**
A named AI job (`build`, `assistant.core`, `assistant.subagent`, `summarise`, `extract`, `classify`,
`embed`, `vision`, `review`, `transcribe`, `speak`, `dictation.cleanup`; ADR 0351) mapped to a
provider + model in the model registry. Code asks for a role, never a model.

**Model role registry**
The core table (`packages/core/src/ai/roles.ts`) that resolves each model role to
`{ provider, model, params, fallback }` through three layers: shipped defaults (every text role on
Workers AI, the speech roles on AssemblyAI), deploy config (`AI_MODEL_ROLES`) and admin overrides (Settings → AI, stored in
`core_settings`, settings only). Each role declares the capabilities it needs (tool use, JSON
output, context size, vision, embeddings); the registry rejects a model that lacks one. "JSON
output" is met by JSON mode (`json_object`) or a JSON schema; no role sends a schema yet
(ADR 0192). Calls run through the AI SDK and AI Gateway: Workers AI over the binding, other
providers through the unified endpoint as `provider/model`, custom providers as
`custom-<slug>/<model>` (ADR 0150, ADR 0203). Provider keys are AI Gateway BYOK or Workers
secrets, never D1 (ADR 0151). On a hosted deployment Workers AI roles run as **Platform AI**.
_Avoid_: model config, LLM settings

**Judge**
The seam that asks typed questions about one piece of evidence (`state`) and gets answers with
probabilities, or "unavailable" with a reason: Choice (one label from a closed set), Noul (the
probability one condition holds) and Score (an ordered scale). Code holds every threshold and
decides what follows; an answer is a judgement, never permission, and each **placement** fails open
or closed by rule. Lives in `packages/core/src/judge/` and reaches operations as `ctx.judge`;
its provider is **Jev**. With no Jev key it is off, makes no network call, and nothing changes
(ADR 0230).
_Avoid_: reviewer (that is the adjudicator's), classifier, the `review` role

**Reviewer**
Who gives the policy adjudicator its verdict, behind the `PolicyReviewer` seam: the LLM reviewer
(model role `review`, through the `Reviewer` interface in `adjudicator/reviewers.ts`) or the Jev
reviewer, which asks the judge which rule stops the change and which allows it
(`judge/questions/adjudicator-policy.ts`). Unset, it is Jev whenever the judge has a key; when
Jev cannot answer, a person decides, never the LLM (ADR 0232, ADR 0233).
_Avoid_: judge (that is the Jev seam)

**Jev**
TypeSafe AI's decision model, the judge's provider, pinned to one version in code
(`JEV_MODEL`). It never writes text or acts. Reached through AI Gateway's custom provider
`custom-typesafe`; its key is BYOK or the Worker secret `TYPESAFE_API_KEY`, which an admin can
store from Settings → AI (on a hosted workspace through the control plane, ADR 0234). See
`docs/jev.md`.

**Placement**
A named place in the code that asks the judge (`authoring.intent`, `adjudicator.policy`,
`summary.statements`, `outbound.message`, `sync.jobChange`, `widget.shape`, `eval.*`), with its own
questions, thresholds, timeout and fail mode (open: carry on and say it was not checked; closed:
the safe outcome, such as escalating). Code asks for a placement, never a model. A placement that
sends record content is off by default; a deployment turns it on with the `JUDGE_PLACEMENTS` var,
and admins switch placements in Settings → AI's Judge section (`judge.update`, human admins only;
ADR 0232), which also shows each placement's **judge spend**: calls and input tokens counted in
`core_judge_usage` by a statement in the batch the placement already writes (ADR 0234).
_Avoid_: check (too general), hook

**Labelled set**
Hand-written cases for one judge question, each with the side of the threshold it should fall,
from which the threshold is set by `pnpm eval:calibrate` (three live runs per case, judged by the
median; `evals/judge/sets/`). A question cannot ship without a calibration record for its current
wording (`calibration.json`, ADR 0231), and CI replays the committed recordings.
_Avoid_: test set, golden set

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
One versioned, reproducible `relationship-os-<version>.tar.gz` (`crm-<version>.tar.gz` before the
rename, ADR 0190) holding every Worker's modules, ros-app's static
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

**Hosted deployment**
A deployment we run for a customer in our Cloudflare account (ADR 0210): user Workers in the
Workers for Platforms dispatch namespace, reached at `<org>.relationshiposcrm.com`. Only the
**control plane** calls it an *instance* (`cp_instances`) and knows its **tenant id** (`t…`), which
prefixes its Worker and resource names and never appears in the deployment's data. The deployment
sees it only as a deploy var (`ROS_TENANT_ID`), for the **tenant tag** on Platform AI calls and
for signing its calls back to the control plane.

**Control plane**
`ros-control` at app.relationshiposcrm.com (`apps/control`): sign-up, plans, billing, provisioning,
rollouts, support grants, export and delete. It never holds customer data. The **dispatch Worker**
(`ros-dispatch`) routes each verified hostname to its deployment and runs tenants' crons.

**Plan**
Free, Team, Business or Enterprise (ADR 0211). Its limits reach a hosted deployment as
**entitlements**: one `core_entitlements` row the control plane writes and the deployment enforces
(users, records, **Platform AI**: models we pay for, as opposed to the customer's own keys or MCP).
A self-hosted deployment has no entitlements and no limits.

**Platform AI**
The AI a hosted deployment's plan pays for and we bill (ADR 0213 and its amendment): Workers AI's
models, as the registry provider `platform`, called through the **one shared platform gateway** in
our account. On a hosted deployment every Workers AI role is Platform AI. Each call carries the
**tenant tag** (`cf-aig-metadata`: role, tenant, plan), set only by host code in the model client,
never by extension code; the gateway keeps metadata, tokens and cost, never prompts or replies,
and caches nothing. Metering filters the gateway's logs by the tag. Self-hosted installs have no
Platform AI: Workers AI runs through their own gateway (ADR 0180).
_Avoid_: built-in AI, credits

**Own key (hosted BYOK)**
On a hosted deployment, a provider key the customer adds in Settings → AI. The control plane sets
it as a secret on the tenant's Workers over the signed **deployment channel** (ADR 0250); calls
with it go directly to the provider (or through the customer's own AI Gateway, if connected),
never through the platform gateway. Shown in the workspace's usage, never billed, never in D1.
On a self-hosted install "BYOK" means keys stored in its own AI Gateway (ADR 0151, ADR 0180).

**Paused / suspended**
Hosted lifecycle states. *Paused*: an idle Free deployment whose crons are stopped; the next visit
wakes it. *Suspended*: traffic stopped for billing or pending deletion; data kept.

**Support grant**
Time-limited access for our staff to a hosted deployment, requested in the admin console and
approved by the customer's admin in Settings → Support access (ADR 0212). It acts through a
dedicated **support user**, never as the customer.
_Avoid_: impersonation

**Rollout**
A new release reaching hosted deployments in **waves**: the **canary** cohort, 10%, then all
(ADR 0215).
