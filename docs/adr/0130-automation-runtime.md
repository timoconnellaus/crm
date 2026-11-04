# ADR 0130: Automation runtime: events, queue, Workflows, replay, rails and review pauses

Status: accepted, 2026-11-05 (stage 5). Implements [ADR 0028](0028-automations.md); the contract,
summary and diagram are [ADR 0131](0131-automation-contract-summary-and-diagram.md), test mode is
[ADR 0133](0133-automation-test-mode.md).

## Context

Automations are extension code (`defineAutomation`) that must run durably, survive redeploys,
never double-run on a redelivered event, pause for approval like any other AI change, and stop
runaways before they cost money or flood the CRM. Cloudflare gives us Queues (at-least-once
delivery), Workflows (durable steps, sleeps and waits) and Worker Loader (sandboxed extension
code). This ADR records how they fit together.

## Decision

### Events

- After an operation's D1 batch commits, `invokeOperation` turns its record changes into queue
  messages and calls `InvocationContext.events` (an `EventSink`) **once per operation**. Changes
  are chunked: at most 100 per message (`EVENT_CHANGES_PER_MESSAGE`) and 120 KB per message; the
  sink sends at most 100 messages and 250 KB per `sendBatch`. A 5,000-record import is 50
  messages in one `sendBatch` call, not 5,000 sends.
- Message ids are `<auditId>:<chunk>`, stable across redelivery. Diff values are capped
  (`capValue`). Reads, refusals, failures and test-mode calls emit nothing. No D1 write is added.
- Every message carries an `EventOrigin`: actor, user, operation, `rootEventId`, cascade `depth`
  and `chain`, the automation and run that caused it, and `bulk` (bulk size > 1, `*Many`,
  `import.*`).
- `approval.approve`, `approval.reject` and the expiry sweep send `approval` messages (one per
  decided action, with the action's original origin; provisional ids replaced by the real ids the
  action bound).
- crm-app (UI, MCP, the daily cron's expiry) and crm-runner (automation steps) produce to the
  `crm-automation-events` queue. A failed send is logged; the change itself is committed.

### Consumer and trigger sources

- crm-runner's `queue()` handler passes the batch to `dispatchAutomationMessages(env, messages)`
  and acks it, or retries the whole batch (`max_retries` 5, then `crm-automation-events-dlq`).
  Batches are up to 100 messages and 5 seconds.
- Dispatch is by message kind through a **TriggerSource** registry
  (`packages/core/src/automations/sources.ts`): `record` (trigger types `record`, `fieldChanged`)
  and `approval` (`approvalDecided`). A source is pure: message + enabled automations → run
  candidates. `fieldChanged` with `{ stageType }` compares the object's `stages.status` field
  before and after.
- **Stage 6b seam.** Stage 6a stores webhooks and sync events in `core_integration_event` rather
  than on the queue. 6b registers a source for `integration` messages with
  `registerTriggerSource(source)` (trigger types `webhook`, `syncEvent`, added to the SDK's
  `AutomationTrigger` union and `automationTriggerSchema`), polls unconsumed rows from crm-runner's
  cron, builds `IntegrationEventMessage`s (id = the row id) and calls the same
  `dispatchAutomationMessages`. Nothing else changes.
- Automations are loaded through `core_automations_trigger_idx` (enabled, not paused, not removed,
  by trigger type and object) joined to active extensions. `extension.install` keeps
  `core_automations` in sync with the manifest in the install's own batch (new rows enabled;
  `enabled` and pauses kept on upgrade; dropped ones get `removed_at`).

### Rails (before any Workflow exists)

In order, in `startRuns` (`apps/runner/src/automations/dispatch.ts`):

1. **Kill switch** (setting, human admins only): nothing starts. The cron checks it too, and every
   advance checks it before running (running runs end `cancelled`, "Stopped by the kill switch").
2. **Cascade depth**: an event at depth ≥ 3 (`MAX_CASCADE_DEPTH`) starts nothing; a run started
   from a depth-d event has depth d + 1 and its writes carry it. Dropped candidates are logged and
   kept as `skipped` runs.
3. **Cycle**: a run's `chain` holds `<automationId>:<object>:<recordId>` of every run in the
   cascade; an automation never retriggers itself on the same record (`skipped` run).
4. **Bulk**: events from bulk operations start runs only for triggers with `includeBulk`.
5. **Debounce**: `updated` events for a record trigger use the key
   `<recordId>:debounce:<floor(at / window)>` (window: the automation's rail or the setting,
   default 30 s), and the Workflow sleeps until the window ends before reading the record. Updates
   in one window land on the same instance id: one run.
6. **Conditions**: the declarative conditions (the view filter language, `compileFilter`) are
   checked against the current record, one query per 50 ids, before any run row is written.
7. **Fan-out budget**: at most 500 runs per root event (`FAN_OUT_BUDGET`, cost audit U3), counted
   through `core_automation_runs_root_idx`.
8. **Rate limits**: runs per minute via the `AUTOMATION_RATE_LIMIT` binding (period 60, keyed per
   automation; a stricter per-automation rail counts the last minute's runs through the index);
   writes per hour via `core_automation_counters` (one upsert per finished run). Exceeding either
   **auto-pauses** the automation (`paused_reason`) and sends one `automation.paused` notification
   to the admins per pause. `automation.enable` clears it.
9. Quarantine still applies: a failed advance counts towards the extension's 3 failures.

### Idempotency

The Workflow instance id is `workflowInstanceId(automationId, key)` (a SHA-256 prefix; ids are
≤ 100 chars of `[a-zA-Z0-9_-]`). Keys: `<eventId>:<recordId>` for record events, the message id
for approvals, the local minute for schedules, `<recordId>:<date>` for date-relative matches, a
random nonce for manual runs, retries and replays. Run rows are inserted `ON CONFLICT DO NOTHING`
on the unique `workflow_id`; only rows still `queued` are passed to `createBatch` (≤ 100 per call;
existing ids are reported, not thrown). A redelivered message therefore finds its row and either
skips it or re-creates a Workflow that already exists: one run either way.

### Execution: replay on Workflows

- `AutomationWorkflow` (crm-runner) runs `start` (reads the trigger record, marks the run
  running), then loops `step.do("advance:<n>", { retries: 3, exponential, timeout 2 min }, …)`.
- An advance is one executor call: `Executor.runAutomation` gets the extension's worker with
  `LOADER.get(toolWorkerId(...))` (the same stable id as its tools; never `load()`) and calls the
  entry module's `runAutomation(request, host)`. The SDK runtime replays `run` with the journal:
  journaled steps return their stored values, the first new `step.do` runs and stops the advance;
  a new `sleep` / `waitForEvent` stops without running anything. Step names must be declared, of
  the matching kind (the declarations are the contract).
- The Workflow journals each result: `do` values come from the stored advance result, so after a
  restart or redeploy Workflows replays `run()` with cached step results and the next advance
  continues where it left off. Sleeps are `step.sleep`; waits are `step.waitForEvent` with the
  declared event type and timeout (null on timeout).
- Step code calls operations as actor `automation`, user = the extension principal, with
  `ctx.extension` = its declared permissions (the pipeline applies `checkGrant` to actor
  `automation` as to `extension`) and origin `{ surface: "automation", automationId, runId,
  extensionId, depth, chain, rootEventId }`. Writes a step did not declare are still gated and are
  flagged `undeclared` in the run history.
- Permanent failures (extension disabled or quarantined, no build, unknown automation, undeclared
  step) throw `NonRetryableError`; anything else retries, then the run ends `failed` and the admins
  get one `automation.failed` notification.

### Review pause

A write whose gate decision is `review` is queued as a pending action. All of a run's actions go in
**one change set per run** (its session key is `run:<runId>`), whose creation notifies the admins
(`approval.pending`, ADR 0132). `ctx.crm.call` returns the pending envelope. After the step the
Workflow marks the run `review` and waits `step.waitForEvent("decision:<n>:<k>", { type:
"approval-<actionId>", timeout: until the action expires })`. The consumer forwards `approval`
messages whose action origin has a `runId` to `instance.sendEvent`. Approved: continue. Rejected:
`onRejected` (`stop` → `cancelled`; `continue`; `{ notify }` → notify, then `cancelled`). Failed on
apply → `failed`. Timeout or expiry → `expired`, ending cleanly.

### Schedules and date-relative triggers

crm-runner's `* * * * *` cron evaluates each schedule automation's 5-field cron in the automation
timezone (setting; `Intl.DateTimeFormat`, so DST is handled), and from 00:05 local once a day
(a marker row in `core_automation_counters`) scans date-relative matches with a range on the date
field over the object's view (declare an index on the field; capped at the fan-out budget).

### Run history and retention

`core_automation_runs` (status, steps JSON with operations and logs, writes, change set, wait
until, retry/replay links, test reports) and `core_automation_run_records` (records a run touched,
for the per-record Automations section). `purgeRunHistory` (ADR 0090) also deletes finished runs
after 30 days (failed after 90) with their run records, and counters after 2 days. Every query has
a `rows_read` budget and an `EXPLAIN QUERY PLAN` check (`apps/runner/test/automations-rows-read.test.ts`).

### Retry, replay, cancel

`automation.retry` starts a new run (`retry_of`) whose journal holds the failed run's completed
steps (values kept in the steps JSON up to 64 KB each), so they are not repeated. `automation.replay`
starts a new run (`replay_of`) from the start against current data. `automation.cancel` terminates
the instance and marks the run `cancelled`.

## Cloudflare facts relied on (checked 2026-11-05)

- Queues: `sendBatch` ≤ 100 messages and 256 KB, message ≤ 128 KB, consumer batches ≤ 100 and
  ≤ 60 s, `max_retries` (default 3), dead-letter queues, at-least-once delivery.
  <https://developers.cloudflare.com/queues/configuration/javascript-apis/>,
  <https://developers.cloudflare.com/queues/platform/limits/>,
  <https://developers.cloudflare.com/queues/configuration/batching-retries/>,
  <https://developers.cloudflare.com/queues/reference/delivery-guarantees/>,
  <https://developers.cloudflare.com/queues/platform/pricing/>
- Workflows: `step.do` with retries (default 5, exponential) and per-attempt timeout,
  `NonRetryableError`, `step.sleep`, `step.waitForEvent` (throws on timeout; event types
  `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`, ≤ 100 chars; events sent early are buffered), instance ids ≤ 100
  chars and unique while retained, `createBatch` ≤ 100 with duplicates reported, `sendEvent`,
  `terminate`; 10,000 steps per instance; waiting instances do not count towards concurrency.
  <https://developers.cloudflare.com/workflows/build/workers-api/>,
  <https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/>,
  <https://developers.cloudflare.com/workflows/build/events-and-parameters/>,
  <https://developers.cloudflare.com/workflows/reference/limits/>,
  <https://developers.cloudflare.com/workflows/reference/pricing/>
- Rate Limiting binding: period 10 or 60 s, approximate per location.
  <https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/>
- Cron triggers run in UTC. <https://developers.cloudflare.com/workers/configuration/cron-triggers/>
- Tests: `introspectWorkflow` / `introspectWorkflowInstance` (`disableSleeps`, `mockStepError`,
  `forceEventTimeout`), `createMessageBatch` / `getQueueResult`.
  <https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/>

## Consequences

- A run costs one Workflow instance plus one step per advance, sleep and wait; waiting is free.
  Bulk operations cost one queue operation per 100 changes and start nothing by default.
- Extension code must be deterministic in the order of its steps: branching on the clock or on
  randomness between replays is detected and fails the run.
- A lost queue send (the producer failing after commit) loses that event; it is logged. The
  Workflow side is exactly-once per idempotency key.
- The debounce delays `updated` record runs by up to the window.

## Amendments

- 2026-11-05 (stage 6b): events are no longer lost when the post-commit send fails: they are
  written to an outbox in the operation's batch and retried by crm-runner's cron
  ([ADR 0171](0171-automation-events-outbox.md)). The `integration` source is registered and its
  events polled from `core_integration_event` ([ADR 0173](0173-integration-trigger-source.md)).
  Automations that declare connections wait for them to be bound ([ADR 0170](0170-automation-run-as-bindings.md)).
