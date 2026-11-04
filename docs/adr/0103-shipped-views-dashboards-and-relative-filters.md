# ADR 0103: Shipped views and dashboards, relative filter values, boards by relation

Status: accepted, 2026-11-05 (stage 4b phase 2). Builds on ADRs 0056–0058 (stage 4a) and 0100.

## Context
Deals must ship saved views (My open deals, Closing this month, Won this quarter), a board by
stage, and two dashboards (Sales overview as the default Home, Pipeline health), all on the public
contract. Stage 4a left extension `views` as stored-but-unused table specs, dashboards as either
the Overview in code or rows people create, board grouping to single-selects, and filters to
literal values, so "my" and "this month" could not be saved.

## Decision
- **Shipped views.** An extension's `views` may be any object view type (`type: table | board |
  calendar | gallery`, with `groupBy`, `sumField`, `cardFields`, …). `view.list` returns active
  extensions' views after the caller's own and shared ones, as shared, read-only views with ids
  `vw_x_<ext>_<name>` (`view.get` reads them; update and delete are refused). A declaration that no
  longer validates against the registry is left out.
- **Relative filter values.** A filter condition's value may be `{ "$relative": token }`: `me`,
  `now`, `today`, `startOfMonth`, `startOfNextMonth`, `startOfQuarter`, `startOfNextQuarter`,
  `startOfLastQuarter`, `startOfYear`, `startOfNextYear` (dates in UTC). Stored specs keep the
  token; the pipeline resolves `input.filter` for every operation other than `view.*`,
  `dashboard.*`, `widget.*` and `extension.*` (`packages/core/src/relative.ts`), so lists, counts,
  board groups and exports run with the caller's id and today's dates. `validateViewSpec` checks
  a sample resolution.
- **Shipped dashboards.** An extension may declare `dashboards: { name: { title, description?,
  home?, filters, widgets } }`, validated against the dashboard spec at check time (the SQL runs
  through the query.sql guards when shown, since the views it reads may not exist before install).
  `dashboard.list/get/home` show active extensions' dashboards beside the Overview as built-in,
  read-only, copyable dashboards with ids `dsh_x_<ext>_<name>`. The default Home is the first
  active extension dashboard declaring `home: true` (Deals' Sales overview), else the Overview; a
  user's own choice (`dashboard.setHome`, including the Overview) wins, and `null` returns to the
  default. At most one `home` per extension.
- **Boards by relation.** `isGroupable` accepts a single relation to an extension object besides a
  single-select; `record.groups` and `validateViewSpec` follow. The board's columns are the related
  records; for an object's stage field they are its stages in stage order, limited to the group
  (pipeline) the board's filter names, else grouped by pipeline.
- **A default group.** `stages.defaultGroupSetting` names a text or select setting of the
  extension (ADR 0058) holding the group, by id or title, that a record created without a group or
  stage goes in. Deals' "Default pipeline" is "New business", so a deal no longer needs a
  pipeline.

## Consequences
- Every Deals widget's click-through is tested to list exactly the deals it counted, per row,
  with and without the owner filter (`packages/core/test/deals-dashboards.test.ts`).
- Stalled deals (no activity or stage move in 14 days) are a table with row click-through, not a
  KPI: a list filter cannot express "no activity since", so a count would have no exact list.
- Dashboard and view declarations are read from installed manifests on each `dashboard.*` /
  `view.list` call (one small indexed read of `core_extensions`).
