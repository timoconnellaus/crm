# ADR 0240: Imports run as one background job, recorded in one ledger, undone as a whole

Status: proposed, 2026-11-05 (stage 12 spec). Extends [ADR 0020](0020-query-sql-validator-and-csv-import.md)
and [ADR 0102](0102-record-csv-import.md). Touches [ADR 0022](0022-approval-queue-and-simulation.md)
and [ADR 0090](0090-storage-retention.md).

## Context

The user decided that an import handles up to 100,000 rows as a background job with progress, that
each import is "one change set", and that it can be undone as a whole.

Today's importers are stateless operations with the CSV inline in the input: `import.csv.commit`
writes up to 20,000 rows in the operation's one D1 batch, and `import.records.commit` writes 100
rows per call. An AI caller's import becomes one pending action, but the queue refuses inputs over
1 MB. There is no undo of any applied write. In this codebase a **change set** is a group of
pending actions reviewed together (ADR 0022); 100,000 pending actions would be absurd to review and
would hit every cap in `approvals/caps.ts`.

D1 limits apply: 30 s per batch, 100 KB per statement, 1,000 queries per invocation, rows read and
written are billed, and the database stops at 10 GB.

## Decision

1. **Files live in R2**, uploaded through an authenticated route. Operation inputs carry the import
   id and the confirmed plan only, so they stay far below the queue's 1 MB cap.
2. **One Workflow instance per import** (`ros-import` in ros-runner, id `import:<id>`). Each step
   writes one chunk (500 core rows, or 100 extension rows) as one D1 batch of `json_each`
   statements, with lookups done once per chunk per key kind through indexes. Steps are retried by
   the Workflow; a chunk is idempotent because rows already in the source id map are skipped.
3. **"One change set" means one approval and one undo**, not one pending action per row:
   - For an AI actor, `import.start` is gated as usual and, under Balanced, becomes **one pending
     action** in the caller's change set. Its preview is the dry run's counts and samples.
     Approving it starts the job.
   - For a human, `import.start` applies at once.
   - Either way the import is one unit in the **import ledger** (`core_import_record`): every
     record it created or updated, with the before values of the fields it changed.
4. **Undo is an operation over the ledger** (`import.undo`, human only), run as its own Workflow:
   trash what was created, restore before values where the current value still equals the imported
   value, delete imported activities. Records changed since the import are listed and kept unless
   the person forces it. The window is 30 days, matching Trash purge.
5. **Audit is per chunk, not per record.** One audit row per chunk names the import and holds
   counts. A record's history reads "Imported in <import>" from the ledger. This keeps a
   100,000-row import to a few hundred audit rows instead of 100,000 rows plus their field changes.
6. **A source id map** (`core_import_key`) resolves links between files by the source's own ids. It
   and the ledger are purged when the undo window ends (ADR 0090's retention cron).

## Why

- A Workflow gives durable, retried, resumable steps with no extra always-on cost, as automations
  already use; one chunk per step keeps every batch far inside D1's 30 s.
- Reviewing an import as one item matches what the person is deciding ("import this export") and
  keeps the approvals inbox usable.
- The ledger is the cheapest data that makes a whole-import undo exact. Rebuilding undo from
  `core_audit_changes` would need the per-record audit we are choosing not to write.

## Consequences

- An import is not one transaction. A failure midway leaves the chunks written so far, which undo
  can remove.
- Per-record audit history for imported records is the ledger entry for 30 days, then the
  per-chunk audit row only. Changes after the import are audited as usual.
- Undo after 30 days is not possible.
- `import.csv.*` and `import.records.*` stay for small synchronous imports and existing callers,
  and should later become thin wrappers over the job.
- `CONTEXT.md`'s "Change set" entry gains a note: an import is one pending action when an AI starts
  it, and one ledger entry either way.
