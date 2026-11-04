# ADR 0015: Core data model

Status: accepted, 2026-11-04 (stage 1 interview).

(ADR 0014 is reserved for the stage-0 ORM choice.)

## Decision
- **Core objects**: Person, Organisation, Affiliation, Activity, Task, plus Users, with `admin / member / viewer` roles and all records visible to all users. Record-level visibility is deferred to the `crm.*` views layer.
- **Person ↔ Organisation** is many-to-many through **Affiliation** (title/role, start, end, `current`), with exactly one primary per person. This keeps job history.
- **Activities** link to many records through `core_activity_links` (object type + record id). Tasks use the same pattern. Activity `type` is a column with a typed JSON payload.
- **Extension fields on core objects** live in 1:1 side tables `x_<ext>_<object>`, joined into `crm.*` views. Core tables are never altered by extensions.
- **IDs** are prefixed and time-sortable (UUIDv7/ULID), e.g. `per_…`, `org_…`, `act_…`, `tsk_…`.
- **Deletion** is soft, into a Trash with 30-day restore, then purged. Delete is `destructive` risk, and an admin `erase` handles GDPR.
- **Emails** are unique across live people and **domains** across live orgs, which powers dedupe and email → org matching.
