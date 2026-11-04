# Stage 4: Deals, views and dashboards

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md),
[`CONTEXT.md`](../../CONTEXT.md), ADRs [0005](../adr/0005-extensions.md),
[0009](../adr/0009-model-roles.md), [0010](../adr/0010-dashboards-sql-views.md),
[0016](../adr/0016-operation-conventions.md), [0020](../adr/0020-query-sql-validator-and-csv-import.md),
[0023](../adr/0023-extension-contract.md), [0025](../adr/0025-extension-authority-and-runtime.md),
[0026](../adr/0026-deals-extension.md), [0027](../adr/0027-view-types-and-dashboards.md).

Builds on Stage 3: extension contract, reconciler, runtime, generic object pages.

## Goal

Deals and pipelines ship as the first real **shipped extension**, which proves the contract. Every
object gains Board, Calendar and Gallery views. Dashboards built from read-only SQL can be created by
hand, by Claude over MCP, or from an in-app "Describe a widget" box.

## Scope

### Deals extension (`extensions/deals/`, ADR 0026)
Replaces `extensions/example/`.
- **Objects:**
  - **Pipeline**: name and order.
  - **Stage**: pipeline, name, order, type (`open | won | lost`), default probability, and required
    fields.
  - **Deal**:
    - name, value (currency, in the deployment's base currency), pipeline, stage, expected close date
    - probability: defaults from the stage and can be overridden; an `overridden` flag tracks this
    - owner, organisation (relation), source (select), lost reason (select; required when lost)
    - next step and next-step date, won/lost date (set automatically)
  - **Deal participant**: deal ↔ person with a role (decision maker, champion, influencer, user,
    other).
- **Base currency** setting (Settings → General), used by the currency field type's display.
- **Stage behaviour:**
  - Stage is `track: "timeline"`, posting "Moved to Proposal" on the deal and its organisation.
  - A **stage history** table records entered and left timestamps per stage, which powers
    time-in-stage and velocity.
  - **Stage rules** are required fields per stage, enforced in the operations, so they apply to UI,
    MCP and AI edits alike.
  - Probability auto-updates on stage change unless overridden.
  - Won/lost date is set on entering a won or lost stage, and cleared on reopening.
- **Seeded defaults:**
  - **Pipelines:** "New business" (Lead → Qualified → Proposal → Negotiation → Won / Lost) and
    "Renewals". Both are editable in settings and by AI via operations.
- **Shipped extras:**
  - Deals tab on Organisation and Person pages (via `recordTabs`).
  - Deals in Cmd-K search and CSV import/export.
  - Saved views: My open deals, Closing this month, Won this quarter.
  - Dashboards:
    - **Sales overview**: open pipeline by stage, weighted forecast by close month (value ×
      probability), won this quarter vs last, win rate, average deal size, and deals by owner.
    - **Pipeline health**: stalled deals (no activity in 14 days), slipped close dates, and
      time in stage.

### Contract additions (ADR 0026)
- `recordTabs` and `recordPanels`: declarative tabs and side panels on any object's record page.
  Each references a view spec filtered by the current record (e.g. deals where
  `organisation = this`). Rendered by our components; extensions still ship no UI.
- `settings`: an extension can declare typed settings, such as default pipeline, rendered in Settings
  → Extensions.

### View types (ADR 0027)
The view spec grows from `type: "table"` to a discriminated union, usable for any object (core or
extension), saved per user or shared:
- **Table** (exists).
- **Board / Kanban**: grouped by a single-select (or stage-like relation) field. Dragging a card calls
  the update operation, so stage rules apply and a failing rule opens a dialog asking for the missing
  field. Columns show counts and sums of a chosen number or currency field.
- **Calendar**: placed by a date or datetime field, with month, week and agenda views. Dragging to
  another day updates the date.
- **Gallery**: cards showing chosen fields and an image or initials.
- **Dashboard**: see below.

### Dashboards (ADR 0027)
- A **dashboard spec** has a title, layout grid, filters (date range, owner, pipeline, or any field)
  and widgets.
- **Widget types:** KPI (with comparison to the previous period), bar/column, line/area, donut/pie,
  funnel, table (top N), leaderboard (by owner), and markdown text.
- **Data:** each data widget has read-only SQL over `crm_*` views, validated by the `query.sql` guards
  (ADR 0020). Dashboard filters bind as named params. A chart mapping says which columns are x, y,
  series and value.
- **Ownership:** personal dashboards are private. Shared org dashboards are viewable by members and
  editable by admins and their owner. Any dashboard can be set as a user's **Home**, and the default
  Home is Sales overview.
- **Behaviour:**
  - **Click-through:** a chart segment, KPI or table row opens the matching records as a filtered
    list. Widgets declare a click-through filter template.
  - Results are cached for 60 s per query and params, with manual refresh.
  - Each widget shows its SQL to admins, plus a copy-ready "Ask Claude to change this" prompt.
  - Widget data can be exported to CSV.
- **Charts** use shadcn chart components (Recharts) and are correct in light and dark mode.
- **Operations:** `dashboard.create/update/delete/list/get/setHome` and `widget.preview` (run a widget
  spec without saving). All of them are MCP tools.
- **"Describe a widget"**: an in-app box. A prompt plus the schema goes to the **`build` model role**,
  which returns SQL and a chart spec. The result is validated, previewed, and then saved or edited.
  If the full model registry (stage 7) doesn't exist yet, implement the minimal role → provider
  mapping from ADR 0009 (Anthropic via AI Gateway, key as a Worker secret). It must fail gracefully
  when no key is configured.
- A **manual widget editor** lets you pick a type, edit the SQL (with a schema sidebar), map columns
  and preview.

## Out of scope
- multi-currency and FX
- calendar sync (stage 6)
- automations on stage change (stage 5)
- the full in-app assistant (stage 7)
- sandboxed HTML widgets

## Acceptance criteria
1. The Deals extension passes the stage-3 contract and reconciler suite. It runs through the
   runtime as a shipped extension, and `extensions/example/` is removed.
2. Stage rules are enforced for UI, MCP and Code Mode. Moving to a lost stage without a lost reason
   is refused, with a structured error that names the field.
3. Stage history records entered and left times. Time-in-stage and velocity queries are correct on a
   seeded dataset.
4. Board, Calendar and Gallery views work for deals and for at least one other object (tasks by
   status, people as a gallery). Saved per user and shared.
5. Every shipped widget's SQL passes the guards. Params bind. Click-through filters return exactly the
   records the widget counted, tested per widget on seeded data.
6. Personal and shared dashboards respect permissions. Setting Home works.
7. The "Describe a widget" box produces valid, previewable widgets. It degrades gracefully without an
   AI key.
8. Playwright (desktop and phone):
   - create a deal, drag it across the board, and mark it lost (the dialog requires a lost reason)
   - see the timeline post on the deal and its organisation
   - Sales overview reflects the change after refresh
   - click a chart segment and land on the right filtered list
   - create a calendar view
9. **AI eval:** 10 "build me a chart of…" prompts in `evals/dashboards/`, run via MCP and via the
   in-app box. The SQL must run and the chart type must fit. A report is committed, with a target of
   at least 8/10.
10. `pnpm lint typecheck test` and e2e pass in CI. ADRs, `CONTEXT.md` (Pipeline, Stage, Stage history,
    Dashboard, Widget, Click-through), `docs/architecture.md` and the extension's README are
    updated.
