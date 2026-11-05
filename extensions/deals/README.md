# Deals (shipped extension)

Pipelines of ordered, typed stages; deals that move through them; and the people on each deal
(ADR 0026). It is built only on the public contract (`@relationship-os/sdk`) and runs through the same runtime
and permission model as AI-written extensions, as principal `extension:deals`.

## Objects

| Object | What | Notes |
| --- | --- | --- |
| `deals.pipeline` | A sales process: name, order, description | `navigation: "settings"`; seeded: New business, Renewals |
| `deals.stage` | A pipeline step: name, pipeline, order, type (`open`/`won`/`lost`), default probability, required fields | `navigation: "settings"`; seeded (below) |
| `deals.deal` | name, value (base currency), pipeline (default: the Default pipeline setting), stage, status, expected close, probability, probability set by hand, weighted value (formula), owner, organisation, source, lost reason, next step and date, won/lost date | stage behaviour, `timelineLinks: ["organisation"]`, 6 indexes |
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

## Automations (stage 5, ADR 0028)

Shipped in `automations.ts`, run as actor `automation` under `extension:deals`. Each one appears
under Automations and can be turned off on its page (Pause) or with
`automation.disable { id: "deals.<key>" }` (`automation.enable` turns it back on); the kill switch
in Settings → Automations stops all of them.

| Key | Label | Trigger | What it does |
|---|---|---|---|
| `stalledDeal` | Stalled deal follow-up | schedule `0 8 * * *` (automation timezone) | Open deals with no change and no timeline activity for 14 days, and no open "Follow up:" task, get a task "Follow up: &lt;deal&gt;" for their owner, due that day, linked to the deal (at most 100 a day, oldest first). |
| `wonOnboarding` | Won deal → onboarding | `stage` changes to a won stage | Creates Kick-off call, Send welcome pack and Set up account for the owner, linked to the deal; notifies the owner ("Deal won 🎉 onboarding tasks created"); after 3 days, if any of those tasks are still open, notifies the owner's manager ("Onboarding not started for &lt;deal&gt;"). |
| `closeDatePassed` | Close date passed | 1 day after `expectedClose`, open deals only | Notifies the owner to update the date or close the deal. |

**Manager field.** Core users have no manager field, so "the owner's manager" resolves to the
**admins** (the notification records the note "Users have no manager field: sent to the admins
instead"). When a manager field exists, only recipient resolution changes.

Permissions this adds: write `task`, read `activity`, and the operation `notification.send`.
The daily scans are indexed: deals by `(status, updatedAt)` and `(status, expectedClose)`, task
and activity links by record.

## Views, tabs, settings and dashboards

- **Saved views** (shared, read-only, in the Deals views menu): My open deals (owner = you),
  Closing this month, Won this quarter (relative values, ADR 0103), and Pipeline board (a board by
  stage summing value; dragging a card runs the stage rules, and a refusal asks for the missing
  field, e.g. the lost reason, then retries).
- **Record tabs and panels** (ADR 0058): Deals on organisation pages (tab) and an Open deals panel;
  Deals on person pages (the deals they take part in, with their role); People on a deal.
- **Settings** (Settings → Extensions): Default pipeline (by name or id; "New business"), used
  when a deal is created without a pipeline or stage.
- **Dashboards** (read-only, copyable; ADR 0103):
  - **Sales overview**, the default Home: won (vs the previous period), win rate, average deal
    size, open pipeline, open pipeline by stage, weighted forecast by close month (value ×
    probability), open pipeline by owner, won by month. Filters: Closed (date range, default this
    quarter) and Owner.
  - **Pipeline health**: slipped close dates and value at risk, days in current stage, stalled
    deals (no activity or stage move in 14 days) and slipped deals.
  - Every widget's click-through opens exactly the deals it counted
    (`packages/core/test/deals-dashboards.test.ts`).

## Demo data

`pnpm db:seed` adds 400 deals across both pipelines with consistent stage history once the app has
installed the extension (start the app once, then seed).

## Tests

- `test/deals.test.ts`: contract, formula and behaviour checks, seeds, the tool against the test host.
- `test/automations.test.ts`: the three automations run in memory (`host.runAutomation`): steps,
  tasks, notifications, waits, conditions, dedupe keys.
- `apps/runner/test/deals.test.ts`: install through the executor, stage rules for every actor,
  history and velocity on a fixed-clock dataset.
- `packages/core/test/deals.test.ts`: reconciler seeds and indexes, base currency, CSV import and
  export, rows-read budgets on 3,000 seeded deals.
