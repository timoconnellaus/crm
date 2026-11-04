# ADR 0017: Audit log and change tracking

Status: accepted, 2026-11-04 (stage 1 interview).

## Decision
- `core_audit` is append-only. Every operation is recorded with actor, user, origin, redacted input, result, risk class, gate decision, timestamp and field-level before/after diffs.
- Field history (the record History tab) and the admin Audit page are views over it.
- **Timeline-worthy fields**: fields flagged `track: "timeline"` in the field registry post a `system` activity when they change. Core flags owner, organisation parent, organisation name and domains. Extensions can flag their own fields, e.g. deal stage.
- **Job changes** are a first-class operation (`person.changeJob`) that posts a Job change activity to the person and both orgs. Detecting job changes (email sync, enrichment) comes in later stages and calls this operation.
