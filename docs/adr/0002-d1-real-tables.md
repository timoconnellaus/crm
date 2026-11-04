# ADR 0002: One D1 database with real tables

Status: accepted, 2026-11-04 (stage 0 architecture interview).

## Context
AI creates new objects and fields at runtime. Options were a DO per workspace, D1 per deployment, or JSON/EAV columns.

## Decision
- One D1 database per deployment, with real tables and columns.
- **Core schema**: `core_*` tables, changed only by our versioned migrations, which run on deploy or upgrade.
- **Extension schema**: `x_<extension>_*` tables, declared in extension code and reconciled into D1 by the host. Changes are additive-first, and destructive changes go through the approval pipeline as `schema` risk.
- Generated `crm.*` views with friendly names are the read surface for dashboards and AI SQL.
- Attachments and imports go in R2.

## Consequences
- Real SQL means indexes, FTS5 search, and SQL the AI writes well. Time Travel gives point-in-time restore, and `wrangler d1` lets self-hosters inspect and export their data.
- 10 GB per database is ample for a CRM.
- The reconciler and its namespacing are a critical component (stage 3). Core migrations must never touch `x_` tables.
