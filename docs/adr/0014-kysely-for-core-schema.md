# ADR 0014: Kysely for typed D1 access

Status: accepted, 2026-11-04 (stage 0 build).

## Context
Stage 0 needs typed access to core tables in D1 and a migration story that works with
`wrangler d1 migrations apply`, in tests, and on upgrade (ADR 0002, 0012). The candidates were
Drizzle and Kysely.

## Decision
- Use **Kysely** (`packages/db`, `createDb(d1)`) with a small in-repo D1 dialect.
- Migrations are **plain SQL files** in `packages/db/migrations`, applied by
  `wrangler d1 migrations apply` and by `applyMigrations()` (tests, upgrades), sharing the
  `core_migrations` bookkeeping table. Table types live in `packages/db/src/schema.ts` and are
  updated in the same commit as each migration.

## Why
- **SQL stays the source of truth.** Core migrations are reviewed SQL, which is also how release
  bundles will ship them. Drizzle wants its TypeScript schema to be the source and generates SQL
  from it, which is a second definition to keep in step.
- **Runtime-shaped schemas.** Extension tables (`x_*`) are declared in extension code and
  reconciled at runtime (ADR 0005), and dashboards run allowlisted SQL over `crm.*` views
  (ADR 0010). Kysely is a query builder with no static schema registry, so querying tables only
  known at runtime is ordinary use rather than a workaround.
- **Better Auth uses Kysely internally** and accepts a D1 binding directly, so identity adds no
  second ORM.
- Small: no codegen step, no CLI in the deploy path.

## Consequences
- Table interfaces are hand-maintained next to the migrations. A test checks the migrations;
  nothing yet checks the interfaces against the live schema. Add a schema-introspection test if
  drift becomes a problem.
- D1 has no interactive transactions, so the dialect rejects `db.transaction()`. Atomic writes use
  `D1Database.batch()` (as the migration runner does).
