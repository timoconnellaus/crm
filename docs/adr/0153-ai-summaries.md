# ADR 0153: AI summaries, cached by a hash of their inputs

Status: accepted, 2026-11-05 (stage 7a build). The daily digest (stage 7 scope) is stage 7b: it
needs stage 5's notifications.

> Amended 2026-11-05 (stage 7b): the daily digest is built ([ADR 0206](0206-daily-digest.md)). Its
> AI overview is one `summarise` call per digest sent, made by ros-runner's cron, from the
> digest's facts (titles, field labels, counts; never activity text). It is not cached in
> `core_ai_summary`: the digest is written once a day and the overview lives in it, labelled
> AI-generated. Without AI, or on any error, the digest goes out without it.

## Context
Stage 7 adds four summaries made by the `summarise` role: a record summary for people,
organisations and deals; meeting prep for a meeting (including calendar events synced in stage
6a); one-line summaries of long emails and notes on a timeline; and a plain-English description
of a change set for its approver. They must be cached, invalidated when the record changes, and
labelled AI-generated, and must not cost a model call per page view or keystroke.

## Decision
- **Inputs are facts.** Each kind builds its input from live data as `- …` lines
  (`packages/core/src/ai/summaries.ts`):
  - **record**: the record's fields (relation ids resolved to titles), extension records that
    point at it (an organisation's deals, a person's deal participations), its open tasks and its
    12 latest non-private activities;
  - **meeting**: the meeting, its attendees with title and organisation, those organisations and
    their deals, the 8 latest notes, emails and calls with them, and open tasks;
  - **activity**: subject and full text (the R2 body for synced mail whose mailbox shares full
    content), only for bodies of at least 400 characters;
  - **changeset**: each pending action's operation, status, reason and field changes from its
    preview.
- **Freshness is a hash.** `input_hash` = SHA-256 of kind, the summarise role's provider:model,
  and the facts. A cached row (`core_ai_summary`, one per kind and subject, migration 0150) is
  fresh exactly when its hash equals today's. Any change (a new note, an edited field, a task
  closed, a deal moved, a different model) makes it stale with no invalidation code, and writes
  stay unaware of summaries.
- **Operations**:
  - `summary.get` (read): the cached text and `fresh | stale | missing | unavailable`. It builds the
    facts to compare hashes but never calls a model. Without AI it still returns cached text, as
    `unavailable`.
  - `summary.generate` (bookkeeping write, actors human and assistant): returns a fresh cached one
    without a call, otherwise calls the model and stores the result.
  - `summary.activityLines` (read) and `summary.activities` (bookkeeping write, at most 10 ids):
    the timeline asks once for the visible long activities and generates only the missing ones,
    in one batch.
  None is exposed to MCP: MCP clients are models and can summarise for themselves.
- **Labelled**: every output carries `aiGenerated: true`, and the UI shows an "AI-generated" badge.
- **Privacy**: private activities (`private_to`) and metadata-only synced mail are never used as
  input or summarised. `sources` lists every record id used, and an erase (ADR 0019) deletes every
  summary about, or built from, the erased records and their activities and tasks.

## Consequences
- Reading a summary costs the reads to build its facts (indexed: under 400 rows for a person on
  the seeded rows-read database, `ai-rows-read.test.ts`) and no model call. Generating is always a
  click, or a batch of at most 10 for a timeline.
- A stale summary stays visible, marked stale, until someone refreshes it.
- One row per subject: no history of earlier summaries.
- Summaries quote facts that may name people. The erase rule above covers summaries built from the
  subject's records; a summary of another record that mentions the subject only by name in free
  text is not found (the same limit as ADR 0019's free-text rule).

> Amended 2026-11-05 ([ADR 0230](0230-jev-as-the-typed-judge.md), proposed with stage 11): when
> the judge is on and placement `summary.statements` is switched on, `summary.generate` asks Jev
> about each statement against the facts it was written from (supported, adds, contradicts, not a
> claim). Statements that add to or contradict the facts are removed before the summary is stored,
> and it is flagged. The verdicts are stored with the cached row, so reading a summary still makes
> no model or judge call. A change-set summary that could not be checked is withheld from the
> approver.

> Amended 2026-11-05 (stage 11 step 6, [ADR 0237](0237-summary-statements-placement.md)): built
> as described above, in `summary.generate` only (record, meeting and change-set summaries; the
> timeline's one-liners are not checked). The check is stored in `core_ai_summary.checks`
> (migration 0255) and returned as `check` by `summary.get` and `summary.generate`. A change-set
> summary's judge facts leave out the agent's reasons, and a withheld change-set summary is not
> stored.
