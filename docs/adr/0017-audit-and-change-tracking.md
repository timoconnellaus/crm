# ADR 0017: Audit log and change tracking

Status: accepted, 2026-11-04 (stage 1 interview).

## Decision
- `core_audit` is append-only. Every operation is recorded with actor, user, origin, redacted input, result, risk class, gate decision, timestamp and field-level before/after diffs.
- Field history (the record History tab) and the admin Audit page are views over it.
- **Timeline-worthy fields**: fields flagged `track: "timeline"` in the field registry post a `system` activity when they change. Core flags owner, organisation parent, organisation name and domains. Extensions can flag their own fields, e.g. deal stage.
- **Job changes** are a first-class operation (`person.changeJob`) that posts a Job change activity to the person and both orgs. Detecting job changes (email sync, enrichment) comes in later stages and calls this operation.

## Amendment, 2026-11-04 (storage retention, ADR 0090)
- **Reads are counted, not logged.** A successful read by a non-human actor no longer writes a
  `core_audit` row. It is counted per hour, actor, user, caller and operation in
  `core_audit_read_counts` (`audit.readCounts`). Writes, with their field diffs, and every failed
  or refused call still get a full row. Human reads are still not recorded.
- **Append-only, with a retention window.** Write audits are kept forever by default. A human
  admin can set a retention of 1, 2 or 7 years (`audit.setRetention`, risk `destructive`). The
  daily cron's `audit.purge` then deletes older audit rows, their change rows and redaction
  markers through a sanctioned path: an append-only purge marker whose cutoff the database checks
  against the setting. Ordinary deletes are still refused, and each purge round is audited with
  one summary row.
