# @crm/db

Core D1 schema for a deployment.

- `migrations/`: numbered SQL migrations for `core_*` tables. Both Workers point their D1 binding's
  `migrations_dir` here, so `wrangler d1 migrations apply DB` applies them. Never touch `x_*`
  tables from a core migration.
- `applyMigrations(db, migrations)`: the same runner for tests and upgrade code. It shares the
  `core_migrations` bookkeeping table with wrangler.
- `getMigrationLevel(db)`: the applied level, reported by `/api/health`.
- `createDb(d1)`: typed [Kysely](https://kysely.dev) access to core tables (ADR 0014).
- `createCrmDb(d1)`: the handle operations use: `{ query: Kysely, batch(statements) }`, where
  `batch` runs compiled statements as one D1 transaction.

Migrations:

| File | Contents |
| --- | --- |
| `0001_init.sql` | Better Auth identity tables, `core_meta` |
| `0002_users_settings.sql` | `core_user.role` (+ first-user-is-admin trigger), `core_settings` (approval policy) |
| `0003_people_organisations.sql` | person (+ emails, phones), organisation (+ domains, addresses), affiliation, tags |
| `0004_activities_tasks.sql` | activity + `core_activity_links`, task + `core_task_links` |
| `0005_views_audit.sql` | `core_views` (saved views), `core_audit` + `core_audit_changes` (append-only) |
| `0006_search.sql` | `core_search_docs` + FTS5 `core_search`, sync triggers |
| `0007_crm_views.sql` | `crm_*` read views (`crm.*` in the docs; D1 has no schemas) |
| `0008_audit_redaction.sql` | `core_audit_redactions` + guarded audit triggers: the sanctioned "[erased]" redaction path (ADR 0019) |

`test/schema.test.ts` covers the constraints and triggers (live-unique emails/domains, primary
flags, first admin, FTS sync, append-only audit and its redaction path, views).

To add a migration: create `migrations/NNNN_name.sql`, end it by updating
`core_meta.schema_version`, bump `CORE_SCHEMA_VERSION`, and update `src/schema.ts`.
