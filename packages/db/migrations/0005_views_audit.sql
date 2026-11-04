-- Migration 0005: saved views and the audit log (ADR 0016, ADR 0017, ADR 0018).

-- Saved views: a user's stored list configuration. `spec` is a `table`-type view spec
-- `{ "type": "table", "object", "filter", "sort", "columns" }` that stage 4 extends.
CREATE TABLE core_views (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES core_user (id) ON DELETE CASCADE,
  object TEXT NOT NULL,
  name TEXT NOT NULL CHECK (name <> ''),
  spec TEXT NOT NULL CHECK (json_valid(spec)),
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX core_views_user_object_idx ON core_views (user_id, object, position);

-- Audit log: one row per operation invocation (successful writes, every denial, and reads by
-- non-human actors). Append-only: UPDATE and DELETE are refused by triggers.
CREATE TABLE core_audit (
  id TEXT PRIMARY KEY NOT NULL,
  at TEXT NOT NULL,
  operation TEXT NOT NULL,
  risk TEXT NOT NULL
    CHECK (risk IN ('read', 'write', 'bulk-write', 'destructive', 'schema', 'extension', 'outbound')),
  actor TEXT NOT NULL CHECK (actor IN ('human', 'assistant', 'mcp', 'automation')),
  user_id TEXT,
  -- JSON `{ surface: "ui" | "mcp" | "automation" | "system", clientId?, automationId? }`.
  origin TEXT NOT NULL CHECK (json_valid(origin)),
  -- Validated input with secrets redacted.
  input TEXT NOT NULL CHECK (json_valid(input)),
  -- A small summary of the output (ids, counts), not the full result.
  result TEXT CHECK (result IS NULL OR json_valid(result)),
  gate_decision TEXT NOT NULL CHECK (gate_decision IN ('auto', 'review', 'deny')),
  -- ok: applied. forbidden: refused by role or actor rules. denied: refused by the gate.
  -- review: routed to review (not yet supported in stage 1). error: failed and rolled back.
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'forbidden', 'denied', 'review', 'error')),
  error TEXT CHECK (error IS NULL OR json_valid(error))
);
CREATE INDEX core_audit_at_idx ON core_audit (at, id);
CREATE INDEX core_audit_user_idx ON core_audit (user_id, at);
CREATE INDEX core_audit_operation_idx ON core_audit (operation, at);
CREATE INDEX core_audit_actor_idx ON core_audit (actor, at);

-- Field-level changes, one row per record an audited operation touched. The record History tab
-- reads these by (object_type, record_id).
CREATE TABLE core_audit_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_id TEXT NOT NULL REFERENCES core_audit (id),
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'restore', 'erase', 'merge')),
  -- JSON `{ "<field>": { "before": ..., "after": ... } }` for changed fields only.
  diff TEXT NOT NULL CHECK (json_valid(diff)),
  at TEXT NOT NULL
);
CREATE INDEX core_audit_changes_record_idx ON core_audit_changes (object_type, record_id, id);
CREATE INDEX core_audit_changes_audit_idx ON core_audit_changes (audit_id);

CREATE TRIGGER core_audit_no_update BEFORE UPDATE ON core_audit
BEGIN
  SELECT RAISE(ABORT, 'core_audit is append-only');
END;

CREATE TRIGGER core_audit_no_delete BEFORE DELETE ON core_audit
BEGIN
  SELECT RAISE(ABORT, 'core_audit is append-only');
END;

CREATE TRIGGER core_audit_changes_no_update BEFORE UPDATE ON core_audit_changes
BEGIN
  SELECT RAISE(ABORT, 'core_audit_changes is append-only');
END;

CREATE TRIGGER core_audit_changes_no_delete BEFORE DELETE ON core_audit_changes
BEGIN
  SELECT RAISE(ABORT, 'core_audit_changes is append-only');
END;

UPDATE core_meta SET value = '5' WHERE key = 'schema_version';
