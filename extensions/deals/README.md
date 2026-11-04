# Deals (shipped extension)

Pipelines of ordered, typed stages; deals that move through them; and the people on each deal
(ADR 0026). It is built only on the public contract (`@crm/sdk`) and runs through the same runtime
and permission model as AI-written extensions, as principal `extension:deals`.

## Objects

| Object | What | Notes |
| --- | --- | --- |
| `deals.pipeline` | A sales process: name, order, description | `navigation: "settings"`; seeded: New business, Renewals |
| `deals.stage` | A pipeline step: name, pipeline, order, type (`open`/`won`/`lost`), default probability, required fields | `navigation: "settings"`; seeded (below) |
| `deals.deal` | name, value (base currency), pipeline (required), stage, status, expected close, probability, probability set by hand, weighted value (formula), owner, organisation, source, lost reason, next step and date, won/lost date | stage behaviour, `timelineLinks: ["organisation"]`, 6 indexes |
| `deals.participant` | A person on a deal and their role (decision maker, champion, influencer, user, other) | `navigation: "none"` |

Seeded stages (stage rules in brackets):

- **New business**: Lead 10% → Qualified 25% [owner] → Proposal 50% [value, expected close] →
  Negotiation 75% [value, expected close, organisation] → Won 100% [value] / Lost 0%.
- **Renewals**: Upcoming renewal 60% [organisation] → Renewal in discussion 75% [value] →
  Renewal committed 90% [value, expected close] → Renewed 100% [value] / Churned 0%.
- Every lost stage also needs a lost reason (`requiredByType.lost`).

Edit them under Settings (Pipelines, Stages) or with `record.update`; required fields are a
multi-select of deal fields.

## Behaviour (enforced by the host, ADR 0100)

- A deal starts in its pipeline's first stage. A stage of another pipeline is refused.
- Entering a stage needs its required fields; otherwise the write fails with `invalid_input` and
  `details: { rule: "stage_required_fields", field, fields, labels, stage }`. This holds for the UI,
  MCP, Code Mode, other extensions and CSV import.
- Probability follows the stage unless set by hand; clear "Probability set by hand" to reset it.
- Status mirrors the stage type; the won/lost date is set on entering Won/Lost and cleared on
  reopening. Both are read-only.
- Every move is recorded in stage history (`crm_stage_history`) and posted as "Moved to <stage>" on
  the deal and its organisation.

## Tools

- `x.deals.stageMetrics { pipelineId, since? }` (read): per stage, deals entered, in it now and
  average days in it; for won deals, the count, average days from entering the pipeline to winning
  and the value won. It reads `crm_stage_history` through `query.sql`.

## Saved views

- Open deals (by expected close). Stage 4a's view types add the board, My open deals, Closing this
  month and Won this quarter.

## Demo data

`pnpm db:seed` adds 400 deals across both pipelines with consistent stage history once the app has
installed the extension (start the app once, then seed).

## Tests

- `test/deals.test.ts`: contract, formula and behaviour checks, seeds, the tool against the test host.
- `apps/runner/test/deals.test.ts`: install through the executor, stage rules for every actor,
  history and velocity on a fixed-clock dataset.
- `packages/core/test/deals.test.ts`: reconciler seeds and indexes, base currency, CSV import and
  export, rows-read budgets on 3,000 seeded deals.
