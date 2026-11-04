-- Migration 0011: connected apps (ADR 0021, ADR 0032). One row per OAuth authorization a user
-- gave an MCP client. Tokens live in the OAuth provider's KV; this row is the authority on
-- whether the connection may still be used (revocation), what it may do (scopes) and when it was
-- last used. Its id is the MCP session id.

CREATE TABLE core_connected_app (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES core_user (id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  client_uri TEXT,
  redirect_host TEXT,
  -- JSON array of granted scopes: read, write, admin.
  scopes TEXT NOT NULL CHECK (json_valid(scopes)),
  -- The OAuth provider's grant id, bound when the authorization code is exchanged.
  grant_id TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  revoked_by TEXT,
  -- revoked (by a person) | replaced (the user authorized the same client again)
  revoke_reason TEXT
);
CREATE INDEX core_connected_app_user_idx ON core_connected_app (user_id, created_at);
CREATE INDEX core_connected_app_grant_idx ON core_connected_app (grant_id);

-- Fixed one-minute windows per key (`<connected app id>:requests` / `:writes`).
CREATE TABLE core_rate_limit (
  key TEXT NOT NULL,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);
CREATE INDEX core_rate_limit_window_idx ON core_rate_limit (window_start);

UPDATE core_meta SET value = '11' WHERE key = 'schema_version';
