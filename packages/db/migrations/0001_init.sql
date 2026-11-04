-- Migration 0001: identity tables for the Better Auth adapter, plus core_meta.
-- Core tables are prefixed core_ (enforced by packages/db/test/core-prefix.test.ts).
-- Column names are snake_case; packages/auth maps Better Auth's camelCase fields onto them.

CREATE TABLE core_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE core_user (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  created_at DATE NOT NULL,
  updated_at DATE NOT NULL
);

CREATE TABLE core_session (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES core_user (id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at DATE NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  created_at DATE NOT NULL,
  updated_at DATE NOT NULL
);
CREATE INDEX core_session_user_id_idx ON core_session (user_id);

CREATE TABLE core_account (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES core_user (id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at DATE,
  refresh_token_expires_at DATE,
  scope TEXT,
  password TEXT,
  created_at DATE NOT NULL,
  updated_at DATE NOT NULL
);
CREATE INDEX core_account_user_id_idx ON core_account (user_id);

CREATE TABLE core_verification (
  id TEXT PRIMARY KEY NOT NULL,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at DATE NOT NULL,
  created_at DATE NOT NULL,
  updated_at DATE NOT NULL
);
CREATE INDEX core_verification_identifier_idx ON core_verification (identifier);

INSERT INTO core_meta (key, value) VALUES ('schema_version', '1');
