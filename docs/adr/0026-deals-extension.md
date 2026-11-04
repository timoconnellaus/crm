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
