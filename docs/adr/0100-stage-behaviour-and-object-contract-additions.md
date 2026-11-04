# ADR 0100: Stage behaviour and object contract additions

Status: accepted, 2026-11-05 (stage 4b build). Refines ADRs 0023, 0024 and 0026.

## Context
ADR 0026 puts Deals in a shipped extension built only on the public contract, with stage rules
"enforced in operations, so they apply to every actor". Extension objects are written by the
generic `record.*` operations, and stage 3's contract had no way to say what a stage is, which
fields a stage needs, or that probability, status and the won/lost date follow the stage. Running
extension code on every write (a "before write" hook) would make every deal update a Dynamic Worker
call, and its result could not be simulated for the approval queue without running it again.

## Decision

**A declarative stage behaviour.** An object may declare `stages` (SDK `StagesSpec`):

- `field`: its relation (one) to a stage object of the same extension;
- `stage.type` (a select with `open`, `won`, `lost`), `stage.order`, and optionally
  `stage.requiredFields` (a multiSelect whose options are the object's field names),
  `stage.probability` and `stage.group` (the stage's pipeline);
- optionally `group` (the record's pipeline, matching `stage.group`), `probability`
  (`{ field, overridden }`), `closedDate`, `status` and `requiredByType`.

The host enforces it inside `record.create`, `record.update` and the record CSV import
(`packages/core/src/records/stages.ts`), so it holds for people, MCP clients, Code Mode scripts,
extensions and approved pending actions alike, and in the approval queue's dry run:

- A record without a stage starts in its group's first stage (by order); a stage alone sets the
  group; a stage of another group is refused; changing the group without a stage moves the record
  to the new group's first stage.
- Entering a stage (or creating a record in one) needs every field the stage lists plus
  `requiredByType[type]` to have a value. Later writes may not empty them. A refusal is a
  `StageRuleError`: code `invalid_input` and details
  `{ rule, object, field, fields, labels, stage: { id, title, type } }`; `field` is the first missing
  field, which a UI asks for.
- `probability` follows the stage's default unless set by hand; setting it marks `overridden`,
  clearing `overridden` resets it.
- `status` mirrors the stage type; `closedDate` is set on entering a won or lost stage and cleared on
  reopening. Both must be `readOnly` fields.
- Every stage change closes the record's current `core_stage_history` row and opens a new one
  (entered and left times, stage, group, stage type, who) in the same batch (migration 0100).
  `crm_stage_history` exposes it to `query.sql` with `days_in_stage`.
- When the stage field is `track: "timeline"`, the timeline post reads "Moved to <stage>" and its
  change carries the stage titles (`beforeLabel`, `afterLabel`).

**Other object keys.**

- `readOnly` on a field: set only by the host (the stage behaviour), refused by record operations.
- `timelineLinks`: relation fields whose records also get the object's timeline posts (a deal's
  moves appear on its organisation's timeline). `RecordChange.timeline` carries the subject, links
  and labels to the pipeline.
- `indexes`: up to 16 indexes of up to 4 own single-valued fields. The reconciler creates them as
  `<table>__<column>[__<column>…]` partial indexes on live rows (`WHERE deleted_at IS NULL`, which
  the `crm_x_*` views always filter on) and drops ones it owns that are no longer declared.
  Migrations still never touch `x_*` tables.
- `seed`: records inserted once, in the install batch that creates the object, with deterministic
  ids (`rec_0000000000` + a hash of extension, object and key) so seeds can reference each other
  (`{ seed: "newBusiness" }`) and demo data can name them. Later releases never re-apply seeds, so
  people may edit or delete them. Seeds do not run the stage behaviour.
- `navigation`: `main` (sidebar, default), `settings` (Settings → set-up, e.g. pipelines and
  stages) or `none` (reached from other records, e.g. deal participants).

All of it is validated by `extension.check` (`packages/sdk/src/behaviour.ts`) with structured
issues, so AI-written extensions can declare their own stage-like objects.

## Consequences
- Stage rules cost one stage read per write (cached per call during an import) and two
  stage-history statements per move. A stage move reads well under 200 rows
  (`packages/core/test/deals.test.ts`).
- The behaviour is deliberately narrow: one stage field per object, required fields, probability,
  status and a closed date. Automations on stage change are stage 5.
- Deleting a deal leaves its stage history; queries join the live `crm_x_deals_deal` view.
- 4a's `recordTabs`, `recordPanels` and `settings` are separate additions on the same contract
  version.
