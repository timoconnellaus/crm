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
 * The core schema version this code expects: the highest core migration number. Bump it with every
 * new migration.
 *
 * Parallel stages take disjoint number ranges, so migrations can be applied out of numeric order
 * (a database that has 0221 later gets 0205). Each migration still writes its own number to
 * `core_meta.schema_version`, which would leave the last one applied there. So the schema version
 * is defined as the **highest migration number recorded** in the migrations table:
 * applyMigrations writes that to core_meta after applying, and getMigrationLevel reads it the same
 * way, which also covers `wrangler d1 migrations apply` (it runs only the files).
 */
export const CORE_SCHEMA_VERSION = 362;

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
  await syncSchemaVersion(db, [...applied, ...pending.map((m) => m.name)]);
  return pending.map((migration) => migration.name);
}

/** The number a core migration file starts with (`0221_support.sql` → 221), or null. */
export function migrationNumber(name: string): number | null {
  const match = /^(\d+)_/.exec(name);
  return match ? Number.parseInt(match[1] as string, 10) : null;
}

/** The highest migration number among `names`, or null when none is numbered. */
export function highestMigration(names: Iterable<string>): number | null {
  let highest: number | null = null;
  for (const name of names) {
    const n = migrationNumber(name);
    if (n !== null && (highest === null || n > highest)) highest = n;
  }
  return highest;
}

/**
 * Sets `core_meta.schema_version` to the highest recorded migration number (see
 * CORE_SCHEMA_VERSION). Does nothing before core_meta exists, or when it is already right.
 */
async function syncSchemaVersion(db: D1Database, names: Iterable<string>): Promise<void> {
  const highest = highestMigration(names);
  if (highest === null) return;
  const meta = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'core_meta'")
    .first<{ name: string }>();
  if (!meta) return;
  await db
    .prepare("UPDATE core_meta SET value = ? WHERE key = 'schema_version' AND value != ?")
    .bind(String(highest), String(highest))
    .run();
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
  let highest: number | null = null;
  if (names.has(MIGRATIONS_TABLE)) {
    const { results } = await db
      .prepare(`SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY id`)
      .all<{ name: string }>();
    applied = results.length;
    latest = results[results.length - 1]?.name ?? null;
    highest = highestMigration(results.map((r) => r.name));
  }

  let schemaVersion: number | null = null;
  if (names.has("core_meta")) {
    const row = await db
      .prepare("SELECT value FROM core_meta WHERE key = 'schema_version'")
      .first<{ value: string }>();
    schemaVersion = row ? Number(row.value) : null;
    // The version is the highest migration recorded, whatever order they were applied in (a
    // lower-numbered migration applied last wrote its own, lower number to core_meta).
    if (schemaVersion !== null && highest !== null && highest > schemaVersion) {
      schemaVersion = highest;
    }
  }

  return {
    latest,
    applied,
    schemaVersion,
    expectedSchemaVersion: CORE_SCHEMA_VERSION,
    upToDate: schemaVersion === CORE_SCHEMA_VERSION,
  };
}
