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

## Amendment, 2026-11-04 (stage 1 build)
- **`crm.*` is spelled `crm_*`.** D1/SQLite has no schemas (and `ATTACH` is unavailable), so the
  read views are `crm_people`, `crm_organisations`, `crm_affiliations`, `crm_activities`,
  `crm_activity_links`, `crm_tasks`, `crm_task_links`, `crm_record_tags` and `crm_users`
  (migration 0007). Wherever the docs say `crm.people`, read `crm_people`. Core migrations may
  create views named `crm_*`; tables stay `core_*`.
- **Uniqueness across live records** (emails, domains) uses a `live` flag on the child row, kept
  in step with the parent's `deleted_at` by triggers, so a partial unique index enforces it.
  Restoring a record whose email or domain has since been taken fails with a conflict.
- **Tags** are one org-wide vocabulary (`core_tags`, case-insensitive unique names) applied through
  polymorphic links (`core_record_tags`: object type + record id), like activity links, so
  extension objects can be tagged too.
- **Rich text** (descriptions) is stored as Markdown.
- **Search** is an external-content FTS5 index (`core_search`) over `core_search_docs`, maintained
  entirely by triggers.
- More id prefixes: `tag_`, `eml_`, `phn_`, `dom_`, `adr_`, `aud_`, `vw_`, `usr_`.
