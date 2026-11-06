# ADR 0246: Leads ship as an extension; assignment rules are core

Status: accepted, 2026-11-06 (built; see the amendment). Proposed 2026-11-05 (stage 15 spec).
Follows [ADR 0026](0026-deals-extension.md).

## Context

The user decided that a Lead is a lightweight item linked to a person and an organisation, with
status, source and owner; that there is a leads inbox and "convert to deal" with no data copied; an
optional lifecycle stage on the person; and assignment rules (round-robin between chosen users, and
by field values with lists, ranges and a fallback owner). We were asked to decide whether Leads is
a core object or an extension like Deals.

## Decision

1. **Leads is a shipped extension**, `extensions/leads`, on the public contract only, as Deals is.
   It requires Deals and adds a read-only `lead` relation to `deals.deal`.
2. **Lifecycle stage is a separate shipped extension**, `lifecycle`, adding a field to `person`.
   Installing it is the opt-in.
3. **Assignment rules are core**: `core_assignment_rule`, `core_assignment_state` and a fallback
   owner per object, applied inside the create batch of every create path for any object with an
   owner field.

## Why

- **Leads as an extension.** ADR 0026's reasoning holds: if business objects can be built on the
  public contract, AI-written extensions can do the same. Leads is about deals (it converts into
  them) and is optional for teams that do not run a lead process. Everything it needs exists in the
  contract today (objects, relations to core and to another extension, select fields, views, record
  tabs, tools, automations, dashboards), and it needs no core migration.
- **Lifecycle separately,** because "optional" is best expressed as "installed or not", and a
  person field is useful without the Leads extension.
- **Assignment in core.** It must apply to core objects (people, organisations) and to every create
  path, including bulk imports, and the owner must be set in the same batch as the insert, so no
  unowned record is ever visible and stage 14's visibility rules hold from the first read. An
  extension could only assign after the fact, through an automation per record: a Workflow run per
  create, a window where the record is unowned, and races on the round-robin counter.

## Consequences

- Leads proves a second extension can depend on the first. If the reconciler does not already
  refuse a relation to a missing extension object, the contract gains `dependsOn`.
- Conversion is a tool making several CRM calls, not one transaction, so it is written to be
  idempotent.
- Every create path gains an assignment step; its cost is held by a `rows_read` budget.

## Amendment, 2026-11-06 (as built)

The stage 15 build followed this ADR and the user's decisions of 2026-11-05. What it added or did
differently:

- **Editable options.** Lead statuses and sources are admin-editable, so the contract gains
  `editableOptions` on select fields and `fixed` on options the extension's code relies on.
  `core_field_options` (migration 0310) holds the edit, the field registry applies it, and
  `fieldOptions.list` and `fieldOptions.update` (`extensions:manage`) read and write it, from
  Settings → Extensions. Records holding a removed option keep their value.
- **More contract keys, all general.** Object `owner`, `navigationOrder`, `requireOneOf` (the "at
  least one of person and organisation" check, in the host rather than in tools, so `record.create`
  and imports hold it too) and `titleDefault` (a lead left unnamed is "<person or organisation>
  lead", for every path and not only the form). Field `default` and `defaultSetting`. Tool
  `recordAction` (a button on the record page, with `confirm`, one `ask` choice and `hideWhen`).
  Automation `enabled: false`, read on first install.
- **Read-only fields** can be written by the declaring extension's own code, so `convert` can set a
  lead's `deal` and `convertedAt` and a deal's `lead`, and nobody else can.
- **`dependsOn` was not needed.** The install check already refuses a relation to an object of a
  missing extension. Boot installs shipped extensions in two passes, so order does not matter.
- **Optional shipped extensions.** `relationshipOs.optional` in `package.json` keeps `lifecycle` out
  of the boot install; `extension.list` reports it under `available`.
- **Lifecycle on conversion.** The user decided converting a lead moves the person to opportunity
  when `lifecycle` is installed. Stages past opportunity (customer, evangelist) are left alone.
  `lifecycleStageChangedAt` is kept by a shipped automation.
- **Round-robin state is not chosen by a subquery in the insert,** as the spec proposed. Rules have
  conditions that the handler must evaluate anyway, and the owner's name goes in the audit diff and
  on the timeline, so the handler reads the state and the batch advances it by a write guarded on
  the value read. A concurrent create makes the guard fail the batch's CHECK, and the pipeline runs
  the call again (up to five times). Single creates and import chunks use the same path, so
  assignment stays exact in sequence and an import chunk adds one state read and one write.
- **Rules run on create and on `assignment.apply` only,** as decided. Not on update.
- **`assignment.test`** was added for the Settings Test box. Read-only.
- **The tools' registry names** are `x.leads.convert` and `x.leads.disqualify`, as for every
  extension tool. The spec's `leads.convert` is shorthand.
- **Index:** `["status", "createdAt"]` replaces the spec's `["status"]`, because the inbox filters
  by status and sorts by newest.
