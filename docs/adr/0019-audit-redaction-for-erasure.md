# ADR 0019: Redacting personal data from the append-only audit log

Status: accepted, 2026-11-04 (stage 1 build, record operations).

## Context
`core_audit` and `core_audit_changes` are append-only: triggers refuse every `UPDATE` and `DELETE`
(migration 0005, ADR 0017). They hold personal data: validated inputs (`person.create` with names,
emails, phones), result summaries, error details (a conflict names the taken email), and field
diffs with before/after values. `person.erase` / `organisation.erase` exist for GDPR erasure
requests (ADR 0015), so they must be able to remove that data. ADR 0018 left the mechanism open.

Options considered:
1. **Overlay table joined into reads.** A `core_audit_redactions` table lists what is erased, and
   readers hide it. Rejected: the personal data is still stored, so it is not erasure, and every
   reader (the Audit page, History tab, `query.sql`, exports) must remember to join.
2. **Delete the audit rows.** Rejected: it destroys the record of who did what, and an
   append-only log that can be deleted from by one code path can be deleted from by any.
3. **Encrypt personal data per subject and drop the key** (crypto-shredding). Strong, but it needs
   key management, makes the audit log unreadable to `query.sql`, and is far more machinery than
   stage 1 needs. Revisit if we ever need to prove erasure from backups.
4. **A sanctioned, narrowly scoped `UPDATE`, enabled by a marker.** Chosen.

## Decision
Migration 0008 adds `core_audit_redactions` and replaces the two `UPDATE` guards. `DELETE` stays
refused on both tables, unconditionally.

- **Markers.** A row in `core_audit_redactions` names exactly one target (`audit_id` or
  `change_id`, enforced by `CHECK`) and records the erased record (`object_type`, `record_id`), the
  operation that erased it and the acting user and time. Each target can be marked once. The table
  is itself append-only (no `UPDATE`, no `DELETE`), so a redaction is never silent.
- **Canonical redaction.** Inserting a marker fires an `AFTER INSERT` trigger that rewrites its
  target to fixed values:
  - `core_audit`: `input` → `"[erased]"`, `result` → `"[erased]"` (if set), `error` →
    `{"code": <kept>, "message": "[erased]"}` (if set). `at`, `operation`, `risk`, `actor`,
    `user_id`, `origin`, `gate_decision` and `outcome` are kept.
  - `core_audit_changes`: the `diff` keeps its field names and every before/after value becomes
    `"[erased]"`. `audit_id`, `object_type`, `record_id`, `action` and `at` are kept.
- **Guards.** The `BEFORE UPDATE` triggers refuse any update unless the row has a marker, every
  kept column is unchanged and the redacted columns equal the canonical values computed from the
  old row. So the only thing that can ever be written over audit content is `"[erased]"`, and
  only for rows an erase has visibly marked. Ordinary updates and deletes still fail with
  "append-only" (tested in `packages/db/test/schema.test.ts` and `packages/core/test/erase.test.ts`).
- **What an erase marks** (`packages/core/src/records/erase.ts`), in the erase operation's own
  batch, before its own audit row is written:
  - change rows about the erased records, or whose diff mentions one of their ids or (for people)
    emails and phone numbers;
  - audit rows that own one of those change rows, or whose input, result or error mentions those
    ids, emails or phone numbers (case-insensitive, terms of 6+ characters).
  Matching is done in SQL against the stored text, so it also catches failed calls that never
  produced a change row (e.g. a create refused because the email was taken).
- **The erase itself** is audited normally (input `{ id }`, an `erase` change row with an empty
  diff). Records merged into the erased one are erased with it.

## Consequences
- Erasure removes the personal data from D1 while the audit log still shows that something
  happened, when, by whom and to which record id.
- Redaction is deliberately over-inclusive: an audit row for a multi-record call (a merge, an
  `updateMany`) that mentions the subject loses its whole input. The other records' own change rows
  are untouched unless they also mention the subject.
- Free text is not searched by name: a note body or a search query that names the person without
  their email or phone stays (activities and tasks linked only to the person are deleted with it;
  shared ones only lose the link). Callers handling an erasure request should review shared notes.
- Erase scans the audit tables (`instr` over text), which is linear in audit size. Erase is rare
  and admin-only; revisit with an index on subject ids if it becomes slow.
- D1's Time Travel and backups still contain the old values until they age out; this ADR covers
  the live database only.

## Amendment, 2026-11-04 (stage 1 integration of the record and activity slices)
- **Shared activities and tasks are scrubbed, not just unlinked.** An activity or task that is
  also about other records stays, but `queueErase` now removes what identifies the subject from
  it: payload entries whose value is one of their emails, phone numbers (any formatting) or ids
  (a meeting attendee, an email's from/to/cc, a call's phone number) are dropped, and exact
  mentions of those strings in subject, body, title or notes become `[erased]`. Their search
  documents follow by trigger. A name in free text is still not matched (see Consequences).
- **The search index is merged after an erase.** FTS5 keeps deleted terms in older index
  segments until they are merged, so an erase ends with `INSERT INTO core_search(core_search)
  VALUES('optimize')`, after every delete, in the same batch. This is linear in index size; erase
  is rare.
- **Audit rows written by the activity slice** (`activity.*`, `task.*`, `import.csv.commit`,
  `search.global` / `query.sql` reads by non-human actors) need no special handling: their inputs
  and diffs carry the subject's ids (as links, `personId`) or emails, which the existing matching
  catches. Change rows written in chunked `json_each` statements (ADR 0018 amendment) are ordinary
  rows, so markers and guarded triggers apply unchanged. `packages/core/test/erase.test.ts` covers
  notes, tasks, a CSV import and search together.

## Amendment, 2026-11-04 (storage retention, ADR 0090)
- **Redaction markers can now be purged.** When audit retention is set, the retention purge
  deletes a redaction marker together with the audit or change row it redacted (its foreign key
  would otherwise pin that row forever). The guard allows this only for markers whose target is
  older than a purge marker's cutoff. The erase's own audit row is newer and stays. Markers are
  still never updated, and are never deleted any other way.
- **Erase and the new storage.** Read counts (`core_audit_read_counts`) hold only ids and counts,
  so there is nothing in them to redact. Compacted pending actions are still found through
  `core_pending_action_records` and redacted as before. `packages/core/test/retention.test.ts`
  covers both.
