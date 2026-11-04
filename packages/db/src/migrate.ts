// The core migration runner. It reads and writes the same bookkeeping table as
// `wrangler d1 migrations apply` (configured as `migrations_table: "core_migrations"` in each
// Worker's wrangler.jsonc), so migrations applied by either are seen by both.

/** One migration file: its file name and its SQL split into statements. */
export interface Migration {
  name: string;
  queries: string[];
}

export const MIGRATIONS_TABLE = "core_migrations";

/**
 * The core schema version this code expects. Each migration ends by writing its number to
 * `core_meta.schema_version`; bump this constant with every new migration.
 */
export const CORE_SCHEMA_VERSION = 131;

const CREATE_MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;

/** Applies every migration not yet recorded, in order. Returns the names it applied. */
export async function applyMigrations(db: D1Database, migrations: Migration[]): Promise<string[]> {
  await db.prepare(CREATE_MIGRATIONS_TABLE).run();
  const { results } = await db.prepare(`SELECT name FROM ${MIGRATIONS_TABLE}`).all<{
    name: string;
  }>();
  const applied = new Set(results.map((row) => row.name));
  const pending = [...migrations]
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((migration) => !applied.has(migration.name));

  for (const migration of pending) {
    // One batch per migration: D1 runs a batch as a single transaction, so a failing statement
    // leaves neither the migration's changes nor its bookkeeping row behind.
    await db.batch([
      ...migration.queries.map((query) => db.prepare(query)),
      db.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (name) VALUES (?)`).bind(migration.name),
    ]);
  }
  return pending.map((migration) => migration.name);
}

export interface MigrationLevel {
  /** File name of the last applied migration, or null on an empty database. */
  latest: string | null;
  /** How many migrations have been applied. */
  applied: number;
  /** `core_meta.schema_version`, or null if the meta table does not exist yet. */
  schemaVersion: number | null;
  /** The version this code expects (`CORE_SCHEMA_VERSION`). */
  expectedSchemaVersion: number;
  /** True when the database is at exactly the version this code expects. */
  upToDate: boolean;
}

/** Reports which core migrations a database has, for `/api/health` and upgrade checks. */
export async function getMigrationLevel(db: D1Database): Promise<MigrationLevel> {
  const tables = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, 'core_meta')")
    .bind(MIGRATIONS_TABLE)
    .all<{ name: string }>();
  const names = new Set(tables.results.map((row) => row.name));

  let latest: string | null = null;
  let applied = 0;
  if (names.has(MIGRATIONS_TABLE)) {
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS applied, (SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY id DESC LIMIT 1) AS latest FROM ${MIGRATIONS_TABLE}`,
      )
      .first<{ applied: number; latest: string | null }>();
    applied = row?.applied ?? 0;
    latest = row?.latest ?? null;
  }

  let schemaVersion: number | null = null;
  if (names.has("core_meta")) {
    const row = await db
      .prepare("SELECT value FROM core_meta WHERE key = 'schema_version'")
      .first<{ value: string }>();
    schemaVersion = row ? Number(row.value) : null;
  }

  return {
    latest,
    applied,
    schemaVersion,
    expectedSchemaVersion: CORE_SCHEMA_VERSION,
    upToDate: schemaVersion === CORE_SCHEMA_VERSION,
  };
}
