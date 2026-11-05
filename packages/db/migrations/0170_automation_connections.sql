-- Migration 0170: automation run-as (stage 6b, ADR 0051, ADR 0170).
--
-- An automation declares the connections it needs (`connections: [{ id, gatekeeper, purpose }]`).
-- A person binds each declared slot to a connection they own or to an org connection; that row
-- is their consent, kept after it is revoked (revoked_at) so the automation page and the audit
-- log can show who allowed what and when. Steps reach the bound connection as its owner.

CREATE TABLE core_automation_binding (
  automation_id TEXT NOT NULL,
  -- The declared connection id (`connections[].id`).
  slot TEXT NOT NULL,
  gatekeeper TEXT NOT NULL,
  purpose TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  -- Who consented, and when.
  bound_by TEXT NOT NULL,
  bound_at TEXT NOT NULL,
  -- Set when the consent was withdrawn, the connection was disconnected or expired, or its owner
  -- was deactivated. A revoked binding no longer lets steps reach the connection.
  revoked_at TEXT,
  revoked_by TEXT,
  revoke_reason TEXT,
  PRIMARY KEY (automation_id, slot)
) WITHOUT ROWID;
-- Revocation: which live bindings use a connection.
CREATE INDEX core_automation_binding_connection_idx
  ON core_automation_binding (connection_id) WHERE revoked_at IS NULL;

-- Deactivated people cannot sign in or act; automations bound to their connections pause.
ALTER TABLE core_user ADD COLUMN deactivated_at TEXT;

UPDATE core_meta SET value = '170' WHERE key = 'schema_version';
