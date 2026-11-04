# ADR 0057: Dashboards: named params, the 60 s cache, click-through and cost

Status: accepted, 2026-11-05 (stage 4a build). Refines ADR 0010, ADR 0020 and ADR 0027; answers
U4 in `docs/research/cloudflare-cost-audit.md`.

## Decision
- **Storage.** `core_dashboards` (owner, title, `shared`, JSON spec) and `core_user_home`
  (migration 0080). Personal dashboards are visible only to their owner (admins included);
  shared ones to everyone with `records:read`, editable by the owner and admins. The shipped
  **Overview** (`dsh_overview`, `packages/core/src/dashboards/overview.ts`) lives in code, is
  read-only (copy it with `dashboard.create { copyFrom }`) and is every user's Home until they
  `dashboard.setHome` another. A deleted Home falls back to the Overview.
- **Dashboard spec** (`packages/core/src/dashboards/spec.ts`):
  `{ filters: DashboardFilter[], widgets: WidgetSpec[] }`.
  - Filters: `dateRange` (binds `:<id>_from` and `:<id>_to`), `user` (`:<id>`; "me" binds the
    viewer), `select`, `field` (choices from a registry field) and `text` (each binds `:<id>`).
  - System params: `:now` (to the minute), `:today`, `:me`, `:record_id` (record tabs).
  - Widget: `{ id, type: kpi|bar|line|donut|funnel|table|leaderboard|markdown, title, sql,
    markdown, mapping: { x, y, series, label, value, columns }, options, clickThrough, layout:
    { w: 1–12, h: 1–8 } }`.
- **Named params.** Widget SQL uses `:name` parameters. `bindNamedParams` rewrites them to `?N`
  on query.sql's SQLite-faithful tokens (strings, comments and quoted identifiers untouched),
  refuses unknown names and positional `?`, then the SQL goes through `validateReadOnlySql` and
  `runReadOnlySql` (the ADR 0020 guards, now exported from `operations/query.ts`): one SELECT/WITH
  over `crm_*` views, row limits (2 for KPIs, `options.limit` (default 10) for tables and
  leaderboards, 500 for charts) and a 5 s deadline.
- **Dates bind concrete bounds**, never NULL: "all time" is `0000-…` to `9999-…`, so
  `created_at >= :date_from AND created_at < :date_to` is always an index range. KPIs compare with
  the previous period by re-running the same SQL with shifted date params (calendar presets step
  back one unit; rolling and custom ranges by their length).
- **The 60 s cache is the Workers Cache API** (`caches.default`), keyed by a SHA-256 of the bound
  SQL, its params, the row limit and the viewer's visibility scope (today the role; record-level
  permissions will make it per-user). `:now` is truncated to the minute so the key holds for the
  window. `refresh: true` skips the read and replaces the entry. No D1 or KV writes: the Cache
  API is free and needs no binding. It is a no-op on `*.workers.dev` (every view then runs its
  query) and per data centre. We did not use D1 read replicas: they reduce load on the primary
  but still bill every row; they remain an option for `query.sql` later.
- **Click-through.** A widget's `clickThrough { object, objectColumn?, filter }` is list filter
  JSON whose values may be `{ "$row": "<column>" }` or `{ "$param": "<name>" }`.
  `resolveClickThrough` (browser-safe) fills them from the clicked row and the bound params and
  drops conditions whose placeholder is null (an unset filter does not narrow the list). The UI
  opens the object's list with that filter. Tests check, per Overview widget and row, that the
  list returns exactly the records the widget counted.
- **Cost.** Every Overview query walks an index (people and organisations by new partial
  `created_at` indexes, activities by `(occurred_at, id)`, tasks by `(status, due_at)`);
  `dashboards-rows-read.test.ts` asserts no full scan in `EXPLAIN QUERY PLAN` and rows-read
  budgets proportional to the rows in range. Activity widgets say `type <> 'system'`, not
  `type IN (…)`, which the planner (no ANALYZE statistics on D1) would answer from the type
  index, reading every activity whatever the dates. Rendering a dashboard never writes.
- **Operations** (all MCP-exposed through `describe_operations` / `call_operation`):
  `dashboard.list/get/home/create/update/delete/setHome`, `widget.run` (a saved widget with
  filter values) and `widget.preview` (an unsaved widget spec, same guards and cache).

## Consequences
- Saving a widget validates its SQL but does not run `EXPLAIN QUERY PLAN`; a slow custom widget
  is bounded by the row limit and deadline, not refused. Worth adding when widgets multiply.
- The validator memoises `sqlite_master` names for 60 s per isolate to avoid a D1 query per
  widget; reserved prefixes (`core_`, `x_`, …) still refuse new internal tables at once.
