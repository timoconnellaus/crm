-- Migration 0010: the approval queue (ADR 0022). A gate `review` outcome records a pending action
-- instead of failing. Pending actions group into change sets: one open set per MCP session by
-- default, or an explicit one (changeset.begin / changeset.commit). They expire after a
-- configurable period (default 7 days). Approval re-runs each action through the pipeline.
-- (0009 is intentionally unused: migration numbers were reserved per parallel stage.)

CREATE TABLE core_change_set (
  id TEXT PRIMARY KEY NOT NULL,
  -- Given by changeset.begin; default (per-session) sets have none.
  title TEXT,
  -- The MCP session (connected app id, cap_…) that queued it, or null for other surfaces.
  session_id TEXT,
  client_id TEXT,
  client_name TEXT,
  user_id TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('human', 'assistant', 'mcp', 'automation')),
  origin TEXT NOT NULL CHECK (json_valid(origin)),
  -- 1 when opened with changeset.begin.
  explicit INTEGER NOT NULL DEFAULT 0 CHECK (explicit IN (0, 1)),
  -- open: accepting new actions. committed: closed by changeset.commit, waiting for review.
  -- closed: a human decided on it; new actions go to a fresh set.
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'committed', 'closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  committed_at TEXT,
  closed_at TEXT
);
CREATE INDEX core_change_set_session_idx ON core_change_set (session_id, state, created_at);
CREATE INDEX core_change_set_state_idx ON core_change_set (state, created_at);
CREATE INDEX core_change_set_user_idx ON core_change_set (user_id, created_at);

-- One queued operation call. `input` is the caller's input as given (re-validated on apply).
-- ids are ULIDs, so `ORDER BY id` is queue order.
CREATE TABLE core_pending_action (
  id TEXT PRIMARY KEY NOT NULL,
  change_set_id TEXT NOT NULL REFERENCES core_change_set (id),
  operation TEXT NOT NULL,
  risk TEXT NOT NULL
    CHECK (risk IN ('read', 'write', 'bulk-write', 'destructive', 'schema', 'extension', 'outbound')),
  input TEXT NOT NULL CHECK (json_valid(input)),
  reason TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('human', 'assistant', 'mcp', 'automation')),
  user_id TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (json_valid(origin)),
  -- The permissions the caller's token allowed (role ∩ scopes), or null for no restriction.
  granted_permissions TEXT CHECK (granted_permissions IS NULL OR json_valid(granted_permissions)),
  bulk_size INTEGER NOT NULL DEFAULT 1,
  -- JSON `[{ object, id, action, diff }]`: the computed diff preview.
  preview TEXT NOT NULL CHECK (json_valid(preview)),
  -- JSON `{ output, records: [{ object, id, state, record }] }`: what the session's reads see.
  simulated TEXT NOT NULL CHECK (json_valid(simulated)),
  -- JSON `[{ object, id }]`: provisional ids (…_pending_…) this action creates, in order.
  provisional TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(provisional)),
  -- JSON `[actionId]`: earlier pending actions this one needs applied first.
  depends_on TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(depends_on)),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'applied', 'failed', 'skipped', 'rejected', 'expired')),
  status_reason TEXT,
  error TEXT CHECK (error IS NULL OR json_valid(error)),
  -- JSON `{ "<provisional id>": "<real id>" }`, set when applied.
  bindings TEXT CHECK (bindings IS NULL OR json_valid(bindings)),
  result TEXT CHECK (result IS NULL OR json_valid(result)),
  request_audit_id TEXT,
  applied_audit_id TEXT,
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX core_pending_action_set_idx ON core_pending_action (change_set_id, id);
CREATE INDEX core_pending_action_status_idx ON core_pending_action (status, expires_at);

-- Records a pending action touches (real or provisional ids): dependencies and record badges.
CREATE TABLE core_pending_action_records (
  action_id TEXT NOT NULL REFERENCES core_pending_action (id),
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  -- create | update | delete | restore | erase | merge | reference
  action TEXT NOT NULL,
  PRIMARY KEY (action_id, object_type, record_id)
);
CREATE INDEX core_pending_action_records_record_idx
  ON core_pending_action_records (object_type, record_id);

-- Links audit rows to the pending action they queued (outcome review) or applied (outcome ok).
ALTER TABLE core_audit ADD COLUMN pending_action_id TEXT;
CREATE INDEX core_audit_pending_action_idx ON core_audit (pending_action_id)
  WHERE pending_action_id IS NOT NULL;

UPDATE core_meta SET value = '10' WHERE key = 'schema_version';
