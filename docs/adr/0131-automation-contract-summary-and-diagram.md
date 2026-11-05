# ADR 0131: Automation contract checks, host summary and step diagram

Status: accepted, 2026-11-05 (stage 5). Builds on [ADR 0028](0028-automations.md) and
[ADR 0023](0023-extension-contract.md).

## Context

Automations are AI-written extension code. A person approves them by reading what the host says
they do, so that description must come from something the host can check, not from the code's
comments or a model's paraphrase. The automation declares its trigger, conditions and steps (with
intents); the runtime holds `run` to those declarations. This ADR records the checks on them and
how the summary and diagram are rendered.

## Decision

### Contract checks (`extension.check`, `packages/sdk/src/automation-check.ts`)
`validateManifest` runs them for every automation after the zod structure check. Each issue names
the fix in terms a model can act on (the fields that do exist, the permission to add):
- camelCase automation and step names; step names unique; at least one step;
- the trigger object exists; `fieldChanged` names a field of it; `dateRelative` a `date` or
  `datetime` field; `{ stageType }` only on the object's `stages.field` (core objects have no
  stages); `from` and `to` not equal; `approvalDecided.operation` is an operation name;
- `schedule.cron` has 5 valid fields (`*`, numbers in range, names, ranges, lists, steps);
- conditions only on triggers with a record, over fields of that object;
- recipients `{ field }` / `{ managerOf }` (in `notifies`, `assignTo`, `onRejected`) are `user`
  fields of the trigger object, and need a trigger with a record;
- `writes` objects need `permissions.write` (own objects are always writable), `reads` need read;
- any `notifies` or `onRejected.notify` needs `notification.send` in `permissions.operations`;
- sleeps positive; waitForEvent event types match the Workflows charset (no dots); all waits in a
  run (sleeps plus waitForEvent timeouts, default 7 days) add up to at most 365 days.

Field types come from the extension's own objects, a built-in table of core object fields
(`CORE_AUTOMATION_FIELDS`, user fields `ownerId`, `assigneeId`, `authorUserId`, `createdBy`), and,
for other extensions' objects, the host's `ValidateOptions.objectFields`; unknown objects' fields
are not checked.

### Summary and diagram (`packages/core/src/automations/summary.ts`)
- Rendered from the manifest only, deterministically, without AI. The same functions feed
  `automation.get`, the automation page and the extension proposal screen
  (`ExtensionImpact.triggers[].summary`).
- The summary is sentences with the subject "it": `<trigger>[, if <conditions>], it <clauses>.`;
  each sleep or wait starts a new sentence (`After 3 days, …`); a condition step adds `if …,` to
  the next group of clauses. Clauses come from intents: `creates 3 onboarding tasks for the
  deal's owner` (the qualifier comes from the step label's words between the verb and the
  object), `updates the deal`, `notifies the owner's manager`; a recipient repeated in a row is
  "them"; steps without effects say `checks <objects>` or `runs <label>`. Objects, fields,
  values, counts, durations and recipients are `strong` segments.
- A condition step may declare `clause` (how the summary says it after "if"); otherwise its label
  is used, lower-cased, without the question mark. This is the one free-text part of the summary,
  and it is the author's declaration, shown verbatim on the diagram.
- Diagram nodes: the trigger, a node for declarative conditions, `Step N · create|update|delete|
  write|notify|run` for `do` steps (numbered; titles in the muted detail; a risk badge
  `write ×N` / `delete`), `Step N · wait` for sleeps (`3 days (durable; survives redeploys)`) and
  waits, and unnumbered `Condition` nodes. `{record}` in a declared message shows as `{deal}`.
- Schedules are put in words for common cron shapes (`Every weekday at 09:30`) with the
  automation timezone; anything else is shown as the cron itself.
- Snapshot tests (`packages/core/test/automation-summary.test.ts`) cover every trigger type and
  step kind, and the Deals onboarding automation word for word against the reference design.

### `ctx.notify`
`notificationInput(event, to, message, key)` (SDK) maps `ctx.notify` to a `notification.send`
input: field and manager recipients point at the trigger record, `{record}` becomes its title,
and the dedupe key is `<runId>:<step>:<n>` (n counts notify calls within that step), so a step
that is retried or replayed notifies once. `AutomationEvent.record.title` carries the title.

### Testing harness
`createTestHost(ext).runAutomation(name, options)` runs `run` in memory: conditions checked,
`step.do` runs, sleeps and waits return at once with how long they would have waited, step names
and kinds held to the declarations, writes and notifications not declared by their step listed
in `undeclared`. It does not use the host's replay runtime, so extension authors can test without
the engine.

## Consequences
- A model gets an actionable issue for every mismatch between declarations and the extension's
  schema or permissions before anyone reviews it.
- The summary can only say what the declarations say; undeclared effects are still gated at run
  time and flagged in run history.
- Adding a trigger type or step kind means adding its phrase, node and a snapshot case.

## Amendment, 2026-11-05 (core fixes): what notifications say
A reviewer could see who would be notified but not what they would be told. Each `notifies`
clause in the summary now ends with the declared title in quotes, and the body in parentheses
when one is declared (`NotifyIntent.body`, new and optional), each shortened at a word (80 and
120 characters), with `{record}` shown as the trigger record's token (`{deal}`, as the diagram
does): "…it notifies the admins with “Deal lost: {deal}” (“Ask the owner why…”)." Nothing else
in the summary is phrased differently.
