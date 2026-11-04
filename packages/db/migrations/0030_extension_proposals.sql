-- Migration 0030: extension proposals (stage 3b, ADR 0041).
--
-- `extension.propose` commits an extension's working copy and queues one pending action
-- (operation `extension.apply`, risk `extension`) in the caller's change set. What a reviewer
-- needs to judge it lives here, keyed by that pending action: the per-file git diff from the
-- installed version, the host-computed impact (schema changes, permissions requested or
-- widened, host modules, triggers), the check result and the AI-written summary (model role
-- `build`). Core tables only; written by trusted host code.
CREATE TABLE core_extension_proposals (
  action_id TEXT PRIMARY KEY NOT NULL REFERENCES core_pending_action (id),
  extension_id TEXT NOT NULL,
  commit_oid TEXT NOT NULL,
  -- The installed commit the proposal was diffed against (null: not installed yet).
  base_commit TEXT,
  source TEXT NOT NULL CHECK (source IN ('shipped', 'runtime')),
  version TEXT NOT NULL,
  message TEXT NOT NULL,
  diff TEXT NOT NULL CHECK (json_valid(diff)),
  impact TEXT NOT NULL CHECK (json_valid(impact)),
  check_result TEXT NOT NULL CHECK (json_valid(check_result)),
  -- The `build` model role's plain-English summary, or null when no AI is configured.
  ai_summary TEXT,
  ai_model TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX core_extension_proposals_ext_idx ON core_extension_proposals (extension_id, created_at);

UPDATE core_meta SET value = '30' WHERE key = 'schema_version';
