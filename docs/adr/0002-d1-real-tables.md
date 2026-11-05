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

> Amended 2026-11-05 (stage 7b merged with stage 10): **parallel stages use migration number
> ranges, and the schema version is the maximum.** Builds that run in parallel take disjoint
> ranges (7b used 0200–0219, stage 10 0220–0239), so a database can get 0221 before 0205. Each
> migration still ends by writing its own number to `core_meta.schema_version`, which on its own
> would leave the last one applied there (210 after 0221). So the schema version is the **highest
> migration number recorded in `core_migrations`**: `applyMigrations` sets
> `core_meta.schema_version` to it after applying, and `getMigrationLevel` (`/api/health`, Status)
> reads it the same way, which also covers databases migrated by `wrangler d1 migrations apply`.
> `CORE_SCHEMA_VERSION` is the highest migration number. Applied migration files are never
> edited. Tested in `packages/db/test/migrate-order.test.ts`.
