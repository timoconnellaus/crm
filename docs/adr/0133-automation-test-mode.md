# ADR 0133: Automation test mode

Status: accepted, 2026-11-05 (stage 5). Part of [ADR 0028](0028-automations.md); runtime in
[ADR 0130](0130-automation-runtime.md).

## Context

People (and Claude, over MCP) need to see what an automation would do to a real record before it
runs for real: which records it creates or changes, who it notifies, and which changes would wait
for approval under the current policy. Nothing may be written while testing, and the report must
match what the real run then does.

## Decision

- `automation.test` (risk `read`, `records:read`, curated MCP tool) calls ros-runner's
  `testAutomation`, which makes **one executor call in `test` mode**: the SDK runtime runs `run` to
  the end, runs every `step.do`, and skips sleeps and waits (recording how long they would have
  been; waits return null).
- Every operation the run calls goes through the full pipeline with
  `InvocationContext.simulate` (a `TestSimulation`, `packages/core/src/automations/simulate.ts`):
  - the gate is evaluated exactly as for a real run, and its decision recorded (test mode does not
    turn provisional ids into a `review`, since they stand for real ids);
  - a write is **dry-run** by the same machinery the approval queue uses (`prepareQueuedAction`:
    the handler runs with its statements discarded, then `simulateRecords`), and the records it
    would create or change are added to an **in-memory overlay** (the `Overlay` of ADR 0022), so
    later reads in the run (`task.get`, `person.list`, …) see them under provisional ids;
  - a write the gate would queue answers with the pending envelope (as in a real run) and is
    listed under `approvals`, with the reason (preset, actor, risk, bulk size, floor);
  - `notification.send` is dry-run too: its resolved recipients are listed as "would notify";
  - no audit row, read count, pending action, notification or queue event is written.
- The trigger is simulated from the chosen record: record triggers use their first event,
  `fieldChanged` treats the record's current value as the change (`before` null, `after` the
  current value), schedules and date-relative triggers use the current period. `matched` reports
  whether the record is of the trigger's object and meets the conditions (a real run would not
  start otherwise); the steps still run so the report shows what would happen.
- The report (`AutomationTestReport`) lists the steps with their operations (undeclared writes
  flagged), the writes (`for`: a task's assignee), the notifications, the approvals and the policy
  preset. It is stored as a test run (`test = 1`) for the automation page's latest test; that run
  row is the only write.

## Consequences

- Test mode runs real extension code against real data, so a test costs one Dynamic Worker call.
- Records the overlay cannot simulate in full (extension object creates read back by later steps)
  appear with their ids and titles but without every computed field.
- The same dry-run path backs the approval queue, so a change to how a handler previews applies to
  both.

> Amended 2026-11-05 (stage 7b): **draft tests.** `automation.test` also takes a proposed, not yet
> installed automation: `{ proposal: { actionId, key }, record? }` instead of `{ id, record? }`
> (exactly one). `actionId` is the `extension.apply` pending action `extension.propose` queued;
> the core handler reads `core_extension_proposals` for its extension and commit, only while the
> action is `pending` (not expired), and visible as `approval.get` is (people see every proposal,
> other actors only their own). ros-runner's `testAutomation({ draft: { extensionId, commit, key
> } })` evaluates the manifest at that commit (the evaluation check and install use, cached by
> source hash), takes `automations[key]` and runs the same test-mode path at that commit
> (`LOADER.get` with the stable tool worker id, ADR 0043), with the draft manifest's permissions
> under the extension's principal. The report says `draft` and `stored: false`: a draft's test run
> is **not stored**, since there is no automation page for it (and an installed older version's
> page must not show it). An unknown key (`unknown_automation`) or a commit that does not evaluate
> (`evaluate_failed`) is an `invalid_input` error naming the cause; a decided or expired proposal
> is `invalid_input` with its status. One extra write: the extension's principal user row
> (`extension:<id>`, kind `extension`), created if missing exactly as install would, because
> operations check their caller and default assignee exist. The assistant shows the report next to
> the proposal before an approver approves it. Objects a draft adds are not reconciled until
> install, so a draft automation that reads or writes its own new objects or fields can fail at that
step in the test.

> Amended 2026-11-05 (core fixes): **a sample decision for `approvalDecided`.** Test mode used to
> run an `approvalDecided` automation with no `event.approval`, and code written for it usually
> returns when that is missing, so the report showed nothing. ros-runner now passes a sample
> decision (`sampleApproval`, `packages/core/src/automations/sample.ts`): the newest of the last
> 50 pending actions that touch records and match the trigger's `operation`, `object` and the
> chosen record, preferring one decided the way the trigger wants (`applied` counts as
> approved); its records come from `core_pending_action_records`. With none, a made-up decision
> (`actionId` `pac_sample`, the trigger's operation or `<object>.update`, the chosen record).
> Without a chosen record the run gets the decision's first matching record, as a real run does.
> The report labels it: `sample { kind: "approval", source: "recent" | "synthetic", label,
> approval }`, and `matchReason` starts with the label ("Sample decision: …"), which the
> automation page, the assistant's inline report and the evals already show.
