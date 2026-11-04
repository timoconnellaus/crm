# ADR 0010: Dashboards: view specs and read-only SQL

Status: accepted, 2026-11-04 (stage 0 architecture interview).

## Decision
- Dashboards and views are **view specs** rendered by our shadcn/chart components. Extensions never ship UI.
- Widgets query with **read-only SQL** over generated `crm.*` views. The host enforces:
  - a SQL parser allowlist: a single `SELECT` / `WITH`, with no PRAGMA, ATTACH or writes
  - bound params for filters
  - row and time limits
- On schema changes, saved queries are re-validated and broken widgets are flagged.
- Computed widgets are extension code returning data. A sandboxed HTML widget may come later.

## Consequences
- D1 has no read-only users, so the parser and the views are the boundary. They need thorough tests.
- `crm.*` views are also where record-level permission filters will go.
