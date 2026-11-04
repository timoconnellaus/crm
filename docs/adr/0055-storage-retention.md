# ADR 0055: Storage retention under D1's 10 GB cap

Status: accepted, 2026-11-04 (cost audit follow-up, decision D3 of
[the Cloudflare cost audit](../research/cloudflare-cost-audit.md)). Amends ADR 0017. Builds on
ADR 0019 and ADR 0022.

## Context
A D1 database cannot grow past 10 GB
([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)). The cost audit (findings
F6, F16, F17, F20) found four kinds of unbounded growth:

- every successful read by an MCP client, extension, automation or the assistant wrote a full
  `core_audit` row (about 6 rows written with its indexes, ~1 KB stored);
- `core_audit` refused every delete (ADR 0017), so write audits grew forever;
- `core_extension_runs` kept every run with its logs;
- decided pending actions kept their full input, preview and simulated records, and a large
  preview could exceed D1's 2 MB row limit and fail to queue at all.

## Decision

### 1. Successful non-human reads are counted, not logged row by row
- The pipeline upserts `core_audit_read_counts` (migration 0060) for a successful read by a
  non-human actor: one row per UTC hour, actor, user, **caller** (the connected app for MCP, the
  extension id, the automation id, else the MCP client id) and operation, with `count`,
  `simulated` (reads that saw the session's pending changes), `first_at` and `last_at`.
- **Writes stay fully audited**, with field diffs, as before.
- **Failed and refused reads stay individual audit rows** (outcomes `error`, `forbidden`,
  `denied`): they are the security-relevant ones.
- Human reads are still not recorded.
- `audit.readCounts` (admins) lists the counts; `audit.list` lists everything else.
- Rows hold ids and counts only, never inputs, so an erase (ADR 0019) has nothing to redact in
  them. This also removes personal data that read audits used to keep (search queries, ids).

We chose a D1 rollup over Analytics Engine or Logpush: it needs no extra binding or account
setup, `query.sql` and the Audit page can read it, and at hourly granularity it is small (one
row per active caller and operation per hour).

### 2. Audit retention, with a sanctioned purge path
- An org setting, `audit_retention` = `{"years": null | 1 | 2 | 7}`. `null` (the default, and the
  meaning of a missing or unreadable setting) keeps write audits forever.
- `audit.setRetention` changes it: `policy:manage` (admins), `actors: ["human"]`, risk
  `destructive`, not exposed to MCP. It is audited with a field diff. Settings → Storage asks for
  confirmation before shortening.
- **The purge path** (migration 0061), in the spirit of ADR 0019's redaction markers:
  - `core_audit_purges` holds append-only **purge markers**: cutoff, retention years, the purge's
    own audit row, who and when.
  - A `BEFORE INSERT` trigger accepts a marker only if its `retention_years` equals the current
    setting and its cutoff is at least that many years before the database clock. So no code path
    can purge what the admin's setting keeps.
  - The `BEFORE DELETE` triggers on `core_audit`, `core_audit_changes` and
    `core_audit_redactions` now allow a delete only while retention is not forever **and** the
    row (for a redaction marker, its target row) is older than the newest purge marker's cutoff.
    Every other delete still fails with "append-only", and `UPDATE` guards are unchanged.
  - Redaction markers are deleted with the rows they redacted, because their foreign keys would
    otherwise pin those rows forever. The erase's own audit row is newer and stays.
- `audit.purge` (actor `automation`, `mcp.expose: false`) does one round in one D1 batch: the
  marker, then the redaction markers, change rows and audit rows of the oldest audit rows past the
  cutoff (at most 2,000 audit rows and about 20,000 change rows), then read counts past the cutoff
  (at most 5,000). Its own audit row is the round's **summary row** (counts, cutoff, whether more
  is due). Like `trash.purge`, it is risk `write`: the destructive decision was the admin's
  setting, and carrying it out is a system write.
- The daily cron runs `runAuditPurge`: nothing at all (not even an audit row) while retention is
  forever or nothing is due, otherwise rounds until done or 10 rounds. A normal day is one round
  and one summary row; a backlog after first shortening retention takes more rounds, each with
  its own summary row.

### 3. Run history
The daily cron deletes extension and automation runs (`core_extension_runs`) that succeeded
more than 30 days ago, and failed ones (`error`, `timeout`) after 90, in chunks of 500 per outcome,
oldest first through a new `(outcome, started_at)` index (migration 0062).

### 4. Pending actions: caps at write time, compaction after 30 days
- **Caps** (`approvals/caps.ts`), applied when an action is queued:
  - input over 1 MB: not queued, with a clear "split it" error. It is re-run on approval, so it
    can't be shortened;
  - each preview before/after value whose JSON is over 2,000 characters becomes
    `{ "$truncated": true, head, length, hash }`. Approval compares the current value's length
    and hash, so "changed since queued" still works on long values;
  - the preview stops at 400 KB and simulated records at 400 KB. What was left out is recorded
    under `simulated.truncated` and shown as `truncated` by `approval.get` / `approval.list`.
  - So a row stays under about 1.8 MB, below D1's 2 MB row limit.
- **Compaction** (migration 0063): 30 days after a pending action was decided, or expired, the
  cron sets `input` to `null`, `preview` to `[]` and `simulated` to empty, and writes `summary` =
  `{ records, actions: { <action>: n }, inputBytes, previewBytes, simulatedBytes }` and
  `compacted_at`. Operation, risk, actor, user, status, decider, decision time, result, error and
  the `core_pending_action_records` links stay. A partial index on
  `coalesce(decided_at, expires_at)` over uncompacted, decided rows keeps it off a table scan.
- Extension proposals (`core_extension_proposals`, stage 3b) are capped and compacted with their
  pending action: the stored file diff is capped at 600 KB (later files keep path, status and
  line counts, with `truncated: true`), and compaction drops hunks and check details, keeping
  impact, file list and whether the check passed.

### 5. Storage gauge
Settings → Storage (admins) shows the database size against 10 GB, warning from 6 GB and
critical from 8 GB, plus row counts of the big tables. The size comes from D1's `meta.size_after`
([D1 result object](https://developers.cloudflare.com/d1/worker-api/return-object/)) on a
statement that reads no rows. D1 supports no `PRAGMA page_count`. Row counts need `count(*)`,
which reads every row, so they are measured once a day by the cron and cached in
`core_storage_stats`. `storage.refresh` re-measures on demand, at most every 10 minutes.

### Query discipline
Every purge and compaction statement is index-ordered and chunked. `test/retention.test.ts` runs
`EXPLAIN QUERY PLAN` on each statement and fails on a full scan of the audit, run or pending
tables, and holds `rows_read` budgets: an audit purge round reads about 20 rows per deleted audit
row (guards, foreign keys, index maintenance), and the daily check that nothing is due reads a
handful.

## Consequences
- Read audits no longer say exactly which record a client read, only how often it called which
  operation. Failed and refused reads keep full detail. A "who looked at this record" view would
  need a different design.
- With retention set, audit history before the cutoff is gone for good, apart from D1 Time Travel
  (30 days). The markers and summary rows show that it happened, when, by which setting and how
  much.
- Compacted pending actions can no longer show their diff in the Approvals inbox, only the
  summary.
- ADR 0019 erase still works: read counts hold no personal data, and compacted actions are
  matched through their record links and redacted like any other. `retention.test.ts` covers
  both.
- Email bodies (cost audit U1) are the next large source of growth. They are out of scope here.
