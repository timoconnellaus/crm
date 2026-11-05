# @relationship-os/db

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
- `@relationship-os/db/seed` (`src/seed.ts`): deterministic demo data (default 10k records: 6k people with
  emails, phones and primary affiliations, 2k organisations with domains, 1k activities, 1k
  tasks, plus the fixed `SEED_FIXTURES` "Ada Lovelace" / "Analytical Engines").
  `seedDatabase(env.DB, options)` seeds a D1 binding (tests); `pnpm --filter @relationship-os/db seed`
  (`scripts/seed.ts`) seeds the local dev database (`-- --people 500 …` for smaller sets,
  `-- --remote` for a deployed one). Inserts are `INSERT OR IGNORE`, so re-running is harmless.

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
| `0020_extensions.sql` | Stage 3: `core_audit` rebuilt to accept actor `extension`; `core_user.kind` (extension principals); `core_base_*` views under the reconciler-owned `crm_people/organisations/activities/tasks`; `core_extensions`, `core_extension_versions`, `core_extension_runs`, `core_extension_kv`, `core_extension_objects`, `core_extension_fields` (ADR 0040) |
| `0080_views_dashboards.sql` | Stage 4a: `core_views.shared`, `core_dashboards`, `core_user_home` (Home), `core_extension_settings`, live `created_at` indexes on people and organisations for dashboard widgets (ADR 0056, ADR 0057) |

`test/schema.test.ts` covers the constraints and triggers (live-unique emails/domains, primary
flags, first admin, FTS sync, append-only audit and its redaction path, views).

To add a migration: create `migrations/NNNN_name.sql`, end it by updating
`core_meta.schema_version`, bump `CORE_SCHEMA_VERSION`, and update `src/schema.ts`. Numbers may skip
(parallel stages reserve ranges); `CORE_SCHEMA_VERSION` is the highest. Change the person,
organisation, activity and task read views through their `core_base_*` views, never the `crm_*`
views themselves (the schema reconciler owns those).

