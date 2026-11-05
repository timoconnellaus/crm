# Stage 15: Leads and assignment rules

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md)
(Extensions), [`CONTEXT.md`](../../CONTEXT.md), ADRs [0023](../adr/0023-extension-contract.md),
[0024](../adr/0024-schema-reconciler.md), [0025](../adr/0025-extension-authority-and-runtime.md),
[0026](../adr/0026-deals-extension.md), [0056](../adr/0056-view-spec-union-and-shared-views.md),
[0058](../adr/0058-record-tabs-panels-and-extension-settings.md),
[0100](../adr/0100-stage-behaviour-and-object-contract-additions.md),
[0102](../adr/0102-record-csv-import.md), [0103](../adr/0103-shipped-views-dashboards-and-relative-filters.md),
[0130](../adr/0130-automation-runtime.md), and this stage's
[0246](../adr/0246-leads-as-an-extension-and-assignment-rules-in-core.md).

Builds on stages 3 and 4 (the extension runtime and Deals). Independent of 12, 13 and 16.

## Goal

Inbound interest (a form fill, a referral, a list from an event) lands as **leads**: lightweight
items linked to a person and an organisation, with a status, a source and an owner. Salespeople
work them from a leads inbox, qualify or disqualify them, and convert the good ones into deals.
New leads, people and organisations get an owner automatically by plain assignment rules:
round-robin among chosen users, or by field values such as country or company size, with a fallback
owner. Optionally, people carry a lifecycle stage.

## What exists today (from the code)

- Deals is a shipped extension (`extensions/deals/index.ts`): objects `pipeline`, `stage`, `deal`,
  `participant`, generic `record.*` operations, `owner: { type: "user" }`, `organisation` relation,
  `source` select, saved views (`myOpenDeals` uses `owner eq {$relative: "me"}`), record tabs on
  person and organisation, settings, automations, dashboards. No "convert" operation exists
  anywhere.
- Extensions can add fields to core objects (`fields.person.…`, side tables) and to other
  extensions' objects; can ship views, tabs, panels, settings, tools (`defineTool`, risk up to
  `bulk-write`) and automations; cannot ship UI; run background code only through automations.
- Extension objects can be imported with `import.records.*` (and with stage 12's importer).
- There is no assignment or round-robin code. Automations have `assignTo` recipients for tasks only.

## Scope

### The Leads extension (`extensions/leads`, ADR 0246)
- **Object `lead`** (`x_leads_lead`, view `crm_x_leads_lead`):
  - `name` (text, the title; defaults to "<person or organisation> lead" in the create form)
  - `person` (relation to `person`), `organisation` (relation to `organisation`); at least one is
    required (an object-level check in the create and update tools, since field `required` is per
    field)
  - `status` (select: `new`, `contacted`, `qualified`, `unqualified`, `converted`; `converted` is
    set only by conversion), `track: "timeline"`
  - `source` (select: website, referral, event, outbound, partner, import, other)
  - `owner` (`user`), declared as the object's owner for stage 14 (`owner: "owner"`)
  - `unqualifiedReason` (select: no budget, no need, no authority, bad timing, competitor,
    unresponsive, other) and `notes` (long text)
  - `deal` (relation to `deals.deal`, read-only) and `convertedAt` (date, read-only)
  - `timelineLinks: ["person", "organisation"]`, so lead activity shows on both
  - indexes: `["owner", "status"]`, `["status"]`, `["person"]`, `["organisation"]`
- **A field on deals:** `deals.deal.lead` (relation to `leads.lead`, read-only), so a deal shows
  where it came from.
- **Requires Deals.** Installing Leads without Deals is refused. If the reconciler does not already
  refuse a relation to a missing extension object, the contract gains `dependsOn: ["deals"]`.
- **Views:** the **Leads inbox** (table: status `new` or `contacted`, newest first, with owner,
  source, person, organisation and age in days), **My leads** (`owner = me`), **Unassigned**
  (`owner` empty), and a **board** by status. Record tabs `personLeads`, `organisationLeads`, and a
  panel on the lead linking its deal.
- **Navigation:** Leads appears in the sidebar above Deals.
- **Tools (operations):**
  - `leads.convert { leadId, dealName?, pipeline?, stage?, value?, expectedClose? }` (risk
    `write`): creates a deal with `organisation` = the lead's organisation, `owner` = the lead's
    owner, `lead` = the lead, and the pipeline's first stage unless given; adds the lead's person as
    a participant; sets the lead's `status = converted`, `deal` and `convertedAt`. **No data is
    copied:** the deal links to the same person and organisation records. Converting is idempotent
    (a re-run finds the deal by its `lead` field and finishes), because a tool's CRM calls are
    separate operations, not one transaction. A converted lead cannot be converted again.
  - `leads.disqualify { leadId, reason }` sets `unqualified` and the reason.
- **Settings:** default source for manually created leads; whether converting also opens the new
  deal.
- **Automations shipped disabled:** "Notify the owner of a new lead" (record created), "Remind the
  owner of a lead still `new` after 2 days" (`dateRelative` on creation date).
- **Dashboard:** "Leads" with counts by status, by source and by owner, leads created per week, and
  conversion counts (leads converted this month). Counts only; no scores.

### Lifecycle stage (optional, its own shipped extension `lifecycle`)
- Adds `person.lifecycleStage` (select: subscriber, lead, marketing qualified, sales qualified,
  opportunity, customer, evangelist, other, as HubSpot names them) and
  `person.lifecycleStageChangedAt`, `track: "timeline"`. Installing it is the opt-in; it is not
  installed by default.
- A shipped view "People by lifecycle stage" (board). No automatic stage changes in this stage; a
  person can describe an automation for that.

### Assignment rules (core, ADR 0246)
- **Where they apply:** any object with an owner field: person, organisation, and extension objects
  declaring `owner` (leads, deals). Applied when a record is **created without an owner** by any
  actor or path (`person.create`, `organisation.create`, `record.create`, stage 12's import chunks,
  `import.csv.*`, `import.records.*`, `suggestedContact.add`), inside the create's own batch, so the
  record never exists unowned.
- **Rules** (`core_assignment_rule`): per object, ordered; the first enabled rule whose conditions
  all match wins.
  - **Conditions:** several, all of which must hold. Each names a field of the object (or, for
    leads, of its organisation or person: for example the organisation's country or employee
    count) and an operator: equals, is one of (a list), between (a range, for numbers, currency and
    dates), is empty, is not empty. They reuse the field registry and filter compiler
    (`compileFilter`).
  - **Method:** **round-robin** among chosen users (deactivated users are skipped), or **one user**.
- **Fallback owner** per object, used when no rule matches; "no owner" is allowed.
- **Round-robin state** (`core_assignment_state (rule_id, next_index)`) is advanced in the same
  batch as the insert, with the owner chosen by a subquery on that state, so assignment is exact in
  sequence. Imports assign a chunk's rows in order from the state read at the chunk's start and
  write the new state in the chunk's batch, guarded by the old value (a conflict retries the chunk).
- **Manual re-run:** `assignment.apply { object, ids }` (risk `bulk-write`) applies the rules to
  existing records, from a list's bulk actions ("Assign by rules").
- **Operations:** `assignment.list`, `assignment.get`, `assignment.create|update|delete|reorder`,
  `assignment.setFallback` (`settings:manage`, human admins; exposed read-only to MCP).
- **UI:** Settings → Assignment rules: per object, an ordered list, a rule editor (conditions as
  in the filter builder, method, users), the fallback owner, and a "Test" box that shows which rule
  a sample record would match.
- **Territory routing** is these rules on country, region or postcode fields. Territory
  management (territory objects, hierarchies, reports) is deferred.
- Assignment is recorded in the record's audit diff (owner set) with the rule's name in the
  origin, and on the timeline as "Assigned to X by rule Y".

### Jev
No placement. Assignment is exact rules over field values (`docs/jev.md` rule 1), and conversion
and status changes are a person's decisions.

## Out of scope
- Web forms and booking links that create leads (roadmap Later list). Leads arrive by hand,
  import, MCP, the assistant, automations and inbound webhooks (stage 6).
- Lead scoring of any kind.
- Territory management beyond rules; capacity-based or availability-based assignment.
- A separate lead person record: a lead always points at a real person and organisation.

## Acceptance criteria
1. **Install:** Leads installs through the extension runtime, adds its tables, views, tabs, panel,
   navigation and the `deals.deal.lead` field; it is refused without Deals; uninstall follows the
   reconciler's rules.
2. **Leads:** create, edit, list, board and inbox work for leads linked to a person, an
   organisation or both; one of them is required; timeline entries appear on the person and the
   organisation.
3. **Convert:** `leads.convert` creates a deal linked to the lead's organisation, owner and person
   (as a participant) with no fields copied; sets the lead `converted` with its deal and date; a
   re-run after an injected failure between calls finishes without a second deal; a converted lead
   cannot be converted again.
4. **Lifecycle:** installing `lifecycle` adds the person field, tracked on the timeline, and its
   board view; not installing it leaves people unchanged.
5. **Assignment:** for person, organisation and `leads.lead`: rules with several conditions (lists,
   ranges on numbers and dates, empty checks, a field of the lead's organisation) assign the first
   matching rule's owner; round-robin rotates exactly across 100 sequential creates and skips
   deactivated users; the fallback applies when nothing matches; a record created with an owner
   keeps it; assignment happens in the create's batch (no unowned record is ever readable).
6. **Paths:** UI, MCP, the assistant, `import.csv.*`, `import.records.*`, stage 12's importer (when
   built) and `suggestedContact.add` all assign; `assignment.apply` reassigns selected records.
7. **Authority:** rule and fallback changes are refused for non-human actors and are audited.
8. **Cost:** assignment adds a fixed number of indexed reads per create (rules for the object are
   one query; conditions on the record's own row and its organisation's row) with a `rows_read`
   budget; an import chunk adds one state read and one write.
9. **Visibility (once stage 14 is on `main`):** leads have a policy; the inbox shows only visible
   leads; "Unassigned" follows stage 14's unowned rule.
10. `pnpm lint typecheck test` and e2e (create a lead, auto-assign it, convert it) pass in CI. ADRs,
    `CONTEXT.md` (Lead, Lead status, Conversion, Lifecycle stage, Assignment rule, Fallback owner)
    and `docs/architecture.md` (Leads as the second shipped business extension) are updated.

## Dependencies
- Needs stages 3 and 4 on `main`.
- **Stage 14** adds the `owner` contract key Leads declares; if 15 is built first, Leads declares
  it as soon as 14 lands, and 14's tests cover `leads.lead`.
- **Stage 12** imports leads as an extension object with no importer change, and runs assignment
  for rows without an owner.
- **Stage 13**: a lead's person can be enrolled in a sequence.

## Parallel build
The Leads and lifecycle extensions are extension code plus one field on Deals: they can be built in
a parallel session with no core migration. Assignment rules are core (migrations) and touch create
paths, so they are a separate PR.

## Migrations and numbers
Migrations 0310–0319 (assignment rules only; block J in `docs/parallel-work.md`). ADR 0246.

## Suggested build order
1. The Leads extension: object, views, tabs, `deals.deal.lead`, tools, settings, dashboard,
   automations.
2. The lifecycle extension.
3. Assignment rules: tables, operations, the create-path hook, round-robin state, settings UI.
4. Import paths and `assignment.apply`.

## Open questions
- **Lead statuses and sources:** fixed in the manifest (proposed) or admin-editable options? Select
  options are manifest-defined today, so editable options would be a contract addition.
- **Assignment on update:** should rules also run when a record's matching fields change (for
  example a lead's country) and it has no owner? Proposed: no, only on create and on demand.
- **Lifecycle stage moves:** should converting a lead set the person's lifecycle stage to
  "opportunity" when `lifecycle` is installed? Proposed: no; describe it as an automation.
