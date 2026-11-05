# ADR 0246: Leads ship as an extension; assignment rules are core

Status: proposed, 2026-11-05 (stage 15 spec). Follows [ADR 0026](0026-deals-extension.md).

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
