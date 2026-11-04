# ADR 0026: Deals as the first shipped extension

Status: accepted, 2026-11-04 (stage 4 interview).

## Decision
- Deals, Pipelines, Stages and Deal participants live in `extensions/deals/` and run through the extension runtime. Nothing about them is core.
- Each deployment has **one base currency**. Multi-currency and FX are deferred.
- Pipelines have ordered stages. Each stage is typed `open | won | lost`, with a default probability and required fields (stage rules). The rules are enforced in operations, so they apply to every actor.
- Stage is timeline-worthy, and a stage-history table records entered and left times for velocity and time-in-stage.
- Probability defaults from the stage unless overridden.
- The contract gains `recordTabs` / `recordPanels` (declarative, view-spec based) and typed extension `settings`.

## Why
If Deals can be built entirely on the public contract, AI-written extensions can do anything Deals does.

## Note, 2026-11-05 (stage 4b build)
- Stage rules, probability, status, the won/lost date, stage history and the "Moved to" timeline
  posts are a declarative stage behaviour in the contract (`stages`), enforced by the host in the
  record operations: [ADR 0100](0100-stage-behaviour-and-object-contract-additions.md). The same
  ADR adds `readOnly` fields, `timelineLinks`, `indexes`, `seed` records (the default pipelines)
  and `navigation`.
- The base currency is a setting: [ADR 0101](0101-base-currency.md). Deals CSV import:
  [ADR 0102](0102-record-csv-import.md).
- A deal's pipeline defaults to the Default pipeline setting (phase 2, ADR 0103); its stage
  defaults to the pipeline's first stage. The lost reason is
  required by `requiredByType.lost`, so editing the Lost stage cannot drop it.
