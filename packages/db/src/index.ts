import { Kysely } from "kysely";
import { D1Dialect } from "./dialect.ts";
import type { CoreDatabase } from "./schema.ts";

export { D1Dialect } from "./dialect.ts";
export { type CrmDb, createCrmDb } from "./handle.ts";
export {
  applyMigrations,
  CORE_SCHEMA_VERSION,
  getMigrationLevel,
  highestMigration,
  MIGRATIONS_TABLE,
  type Migration,
  type MigrationLevel,
  migrationNumber,
} from "./migrate.ts";
export type * from "./schema.ts";

/** Prefix every core table name carries. Extension tables use `x_<extension>_` instead. */
export const CORE_TABLE_PREFIX = "core_";

/**
 * Prefix of the read views (`crm_people`, ...). They stand in for the `crm.*` schema of ADR 0010:
 * D1/SQLite has no schemas (see the ADR 0015 amendment).
 */
export const CRM_VIEW_PREFIX = "crm_";

/** Typed Kysely access to the core tables of a deployment's D1 database. */
export function createDb(d1: D1Database): Kysely<CoreDatabase> {
  return new Kysely<CoreDatabase>({ dialect: new D1Dialect(d1) });
}
