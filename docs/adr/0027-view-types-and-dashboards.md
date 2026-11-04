# ADR 0027: View types and dashboards

Status: accepted, 2026-11-04 (stage 4 interview).

## Decision
- The view spec is a discriminated union: `table | board | calendar | gallery | dashboard`, for any object, saved personally or shared.
- **Board** groups by a select field and moves cards through the update operation, so stage rules apply. **Calendar** uses a date field. **Gallery** shows cards.
- **Dashboards:**
  - Ownership: personal or shared (members view; admins and the owner edit), and any dashboard can be set as Home.
  - Filters bind to SQL params.
  - Widgets: KPI, bar, line, donut/pie, funnel, table, leaderboard, markdown.
  - Data widgets use read-only SQL over `crm_*` views with the ADR 0020 guards.
  - Click-through filter templates, a 60 s result cache, the SQL visible to admins, CSV export.
  - Charts use shadcn/Recharts.
- **AI authoring:** dashboard and widget operations are exposed to MCP. An in-app "Describe a widget" box uses the `build` model role, with a minimal role → provider mapping if the stage-7 registry isn't built yet.
