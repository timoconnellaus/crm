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
