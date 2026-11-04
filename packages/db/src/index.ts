import { Kysely } from "kysely";
import { D1Dialect } from "./dialect.ts";
import type { CoreDatabase } from "./schema.ts";

export { D1Dialect } from "./dialect.ts";
export {
  applyMigrations,
  CORE_SCHEMA_VERSION,
  getMigrationLevel,
  MIGRATIONS_TABLE,
  type Migration,
  type MigrationLevel,
} from "./migrate.ts";
export type * from "./schema.ts";

/** Prefix every core table name carries. Extension tables use `x_<extension>_` instead. */
export const CORE_TABLE_PREFIX = "core_";

/** Typed Kysely access to the core tables of a deployment's D1 database. */
export function createDb(d1: D1Database): Kysely<CoreDatabase> {
  return new Kysely<CoreDatabase>({ dialect: new D1Dialect(d1) });
}
