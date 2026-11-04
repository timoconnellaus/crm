# @crm/db

Core D1 schema for a deployment.

- `migrations/`: numbered SQL migrations for `core_*` tables. Both Workers point their D1 binding's
  `migrations_dir` here, so `wrangler d1 migrations apply DB` applies them. Never touch `x_*`
  tables from a core migration.
- `applyMigrations(db, migrations)`: the same runner for tests and upgrade code. It shares the
  `core_migrations` bookkeeping table with wrangler.
- `getMigrationLevel(db)`: the applied level, reported by `/api/health`.
- `createDb(d1)`: typed [Kysely](https://kysely.dev) access to core tables (ADR 0014).

To add a migration: create `migrations/NNNN_name.sql`, end it by updating
`core_meta.schema_version`, bump `CORE_SCHEMA_VERSION`, and update `src/schema.ts`.
