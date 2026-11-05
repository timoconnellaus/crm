# ADR 0171: The automation events outbox

Status: accepted, 2026-11-05 (stage 6b). Amends [ADR 0130](0130-automation-runtime.md) ("A lost
queue send … loses that event"). Migration 0171.

## Context

Stage 5 sent automation events to the queue after the operation's batch committed and only logged
a failed send. A queue hiccup at that moment silently lost the event: the change happened, its
automation never ran. Workflows already make runs exactly-once per idempotency key; what was
missing was at-least-once delivery from the producer.

## Decision

- An operation that produces events (record changes) inserts its messages into
  `core_automation_outbox` **in the same D1 batch** as the change: one row per operation (chunked
  at ~900 KB, so a 5,000-record import is one or a few rows), never one per record, never on reads,
  refusals, failures or test mode. This is the only per-request write stage 6b adds.
- After commit the pipeline sends the row's messages (`deliverOutbox`) and deletes the row. A
  failed send leaves the row; it never fails the caller (the change is committed).
- Approval decisions are known only after the decision: `approval.reject` writes its outbox rows in
  its own batch; `approval.approve` and the expiry sweep write them right after (`emitDurably`),
  then send.
- ros-runner's minute cron (`retryOutbox`) reads at most 50 rows in primary-key (time) order, takes
  those past `next_at` (a 60 s grace for the in-flight post-commit send, then backoff 1, 2, 4 … 60
  minutes), and dispatches them **directly** with `dispatchAutomationMessages`, so a queue outage
  does not block it. Success deletes the row; failure bumps `attempts` and `last_error` (logged
  loudly from 10 attempts).
- No secondary index: the table is empty unless sends fail, so the cron's page costs nothing.

## Consequences

- Delivery is at least once. A send that succeeded but whose delete was lost is sent again; the
  Workflow id derived from the event id makes the second delivery start nothing.
- One extra row write and delete per event-producing operation.
- A row that never succeeds stays (visible, logged); it is not dropped silently.
