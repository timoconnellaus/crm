# ADR 0056: The view spec union, shared views and view types

Status: accepted, 2026-11-05 (stage 4a build). Refines ADR 0016 and ADR 0027.

## Decision
- **One discriminated union** in `packages/core/src/views/spec.ts`, exported from `@crm/core`
  and `@crm/core/client`:
  - `table { object, filter, sort, columns }` (stage 1, unchanged)
  - `board { object, filter, sort, groupBy, columnOrder?, hiddenColumns?, sumField?, cardFields }`
  - `calendar { object, filter, dateField, mode: month | week | agenda, cardFields }`
  - `gallery { object, filter, sort, imageField?, cardFields }`
  - `dashboard { title?, filters, widgets }` (the dashboard spec, ADR 0057)

  `objectViewSpecSchema` (the first four) is what saved views and record tabs store;
  `viewSpecSchema` includes dashboards. `validateViewSpec` checks every field against the field
  registry: `groupBy` must be a single-select (enum) field, `sumField` a number field (number,
  currency, percent), `dateField` a date or datetime field, `imageField` a text/URL field.
- **Stored views stay valid.** Stage-1 rows are already `type: "table"`; `parseStoredViewSpec`
  also reads a spec without `type` as a table, and falls back to a table of its columns rather
  than failing a list. No data migration.
- **Shared views:** `core_views.shared` (migration 0080). Everyone with `records:read` sees
  shared views; the owner and admins change or delete them; only the owner makes one personal
  again. `view.list` reads own and shared views with two indexed queries. `view.get` added.
- **Board moves go through the object's own update operation** (`task.complete`/`task.reopen`
  for task status, `<object>.update` for other core fields, `record.update` for extension
  fields), so validation and stage rules apply to UI, MCP and Code Mode alike. A refusal whose
  `details.field` names a writable field opens a dialog for it and retries the move.
- **Column totals** come from `record.groups { object, groupBy, sumField?, filter? }`: counts and
  sums per choice, reading at most 10,000 matching rows (`capped`), like `record.count`.
- **`record.list` returns core fields named in `fields`** (as their view columns' values), so the
  board, calendar and gallery read any object, core or extension, through one operation.
- **UI:** the list pages (people, organisations, tasks' All tab, extension objects) take
  `vt=board|calendar|gallery` and `layout=<JSON>` search params beside the table's filter, sort
  and columns; saved views store the whole spec. Board columns are virtualised and page in;
  calendar and board offer menu alternatives to dragging for keyboards and touch.

## Why
A union keeps one `view.*` API, one validator and one saved-view store for every way of looking at
records, and lets record tabs and dashboards embed the same specs. Routing moves through the
existing operations means the board never needs its own write path or permission rules.

## Consequences
- Stage 4b's Deals board groups deals by a select today; grouping by a stage-like **relation**
  needs `isGroupable` widened and column values loaded from the related object.
- `columnOrder` exists in the spec; dragging columns to reorder them is not built yet.
