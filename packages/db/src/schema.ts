// Typed access to core tables. Keep in step with ../migrations: a migration that changes a core
// table updates the matching interface here in the same commit.
import type { ColumnType, Generated } from "kysely";

/** SQLite stores dates as ISO-8601 text; Better Auth writes them, we read them back as strings. */
type DateColumn = ColumnType<string, string | Date, string | Date>;
/** SQLite has no boolean type: 0 or 1. */
type BoolColumn = ColumnType<number, number | boolean, number | boolean>;

export interface CoreMetaTable {
  key: string;
  value: string;
}

export interface CoreMigrationsTable {
  id: Generated<number>;
  name: string;
  applied_at: Generated<string>;
}

export interface CoreUserTable {
  id: string;
  name: string;
  email: string;
  email_verified: BoolColumn;
  image: string | null;
  created_at: DateColumn;
  updated_at: DateColumn;
}

export interface CoreSessionTable {
  id: string;
  user_id: string;
  token: string;
  expires_at: DateColumn;
  ip_address: string | null;
  user_agent: string | null;
  created_at: DateColumn;
  updated_at: DateColumn;
}

export interface CoreAccountTable {
  id: string;
  user_id: string;
  account_id: string;
  provider_id: string;
  access_token: string | null;
  refresh_token: string | null;
  id_token: string | null;
  access_token_expires_at: DateColumn | null;
  refresh_token_expires_at: DateColumn | null;
  scope: string | null;
  password: string | null;
  created_at: DateColumn;
  updated_at: DateColumn;
}

export interface CoreVerificationTable {
  id: string;
  identifier: string;
  value: string;
  expires_at: DateColumn;
  created_at: DateColumn;
  updated_at: DateColumn;
}

/** Every core table, keyed by table name. Extension (`x_*`) tables are never listed here. */
export interface CoreDatabase {
  core_meta: CoreMetaTable;
  core_migrations: CoreMigrationsTable;
  core_user: CoreUserTable;
  core_session: CoreSessionTable;
  core_account: CoreAccountTable;
  core_verification: CoreVerificationTable;
}
