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

## Amendment, 2026-11-05 (stage 7a: AI summaries and embeddings)
- **Summaries**: an erase deletes every `core_ai_summary` row about the erased records, their
  deleted activities and tasks, or built from any of them (`sources`), in the erase's own batch
  (ADR 0153).
- **Vectors**: an erase queues the erased records and every activity and task that held their
  text (their own, which are deleted, and shared ones, which are scrubbed) for the embedding
  drain, which runs right after the commit: records with no text left lose their Vectorize vector
  and `core_embedding` row; scrubbed shared ones are re-embedded from the scrubbed text
  (ADR 0154). `core_embedding` holds only ids and hashes. Tested in
  `packages/core/test/ai-embeddings.test.ts` ("erase removes the person's vectors…").

## Amendment, 2026-11-05 (in-app assistant conversations)
Stage 7b put assistant conversations in a Durable Object per conversation (ADR 0200), out of
reach of the SQL above, so an erased person's details survived in chat history: the tool calls
that looked them up, the records the tools returned, and what the person and the assistant wrote.
An erase now removes them there too, redacting rather than deleting, consistent with the audit log.
- **Finding them: an index.** `core_assistant_conversation_refs` (migration 0270) has one row per
  conversation and referenced person or organisation id, or email address as
  `email:<sha256 of the lower-cased address>` (a conversation that names someone only by email is
  found without D1 storing the address). The conversation object extracts them from each finished
  turn's messages and page context and sends them in `assistant.finishTurn`, the one D1 write a
  turn already makes, as one `INSERT … SELECT FROM json_each` in that batch: no extra request,
  nothing per token or tool call. Until such an update succeeds for a conversation (one from
  before 0270, or after a failed update) the object sends its whole history's refs. The migration
  indexes existing conversations' context (record and selection ids).
  `assistant.deleteConversation` deletes its refs.
- **Scrubbing them.** `queueErase` looks the subject's ids and hashed emails up in the index (live
  conversations only) and calls `AssistantConversationStore.scrub(conversationId, { terms, names
  })` for each, which ros-app implements with the object's `scrub` RPC. In stored messages:
  - a **tool call** whose input mentions the subject gets input `{ "erased": true }`, and a
    **tool result** whose output mentions them gets output `"[erased]"`, whole, as an audit row's
    input does;
  - **text** (the person's messages, the assistant's replies, reasoning) and turn errors have each
    mention replaced with `"[erased]"`.
  "Mentions" means the ids, emails and phone numbers above (case-insensitive; phone numbers in any
  formatting), plus the subject's **names** as whole words (a person's display, given and family
  names of 3+ characters; an organisation's name). Names are matched here, unlike in the audit log
  and shared activities, because these conversations are known to be about the subject. A turn
  running during the erase has its in-memory events redacted and its messages redacted before they
  are stored.
- **Before the commit, failing closed.** The objects are scrubbed in the handler, before the batch
  commits; if one cannot be reached, or the caller has no store (only ros-app's UI adapter wires
  one), the erase fails with a `config` error and nothing is erased, so it can be retried
  (scrubbing is idempotent). A scrub that succeeded before a failed commit only removed data that
  was about to be erased. While an erase is only simulated (an approval preview, test mode)
  nothing is scrubbed.
- **D1 side, in the erase's batch.** The conversations' list rows lose mentions in `title` and
  `preview`; a `context` that mentions the subject becomes null; the subject's refs are deleted.
  `person.erase` and `organisation.erase` report `conversationsScrubbed`.
- **Limits.** A conversation that names the subject only in free text, without their id or email
  (no lookup, no context), is not indexed and not found (the free-text rule above). A turn that
  first looks the subject up while the erase runs is indexed after it, so its refs and messages
  can survive; erase is rare and admin-run. Other text the assistant repeated from a record (a job
  title, a city) stays where it is not inside an erased tool result. ADR 0153's summaries need
  nothing more: they live in D1 and are already deleted.
