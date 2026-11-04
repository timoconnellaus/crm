-- Migration 0020: extension runtime state, the `extension` actor, and base views for the schema
-- reconciler (stage 3, ADR 0023, ADR 0024, ADR 0025, ADR 0040).
--
-- This migration touches core tables only. The x_* tables and the crm_* views that join them are
-- owned by the reconciler (packages/core/src/extensions/reconciler.ts), never by migrations.

-- 1. The audit log accepts actor `extension` (calls made by extension code through
--    codemode:crm). SQLite cannot alter a CHECK constraint, so core_audit is rebuilt with the
--    same rows. Its children (core_audit_changes, core_audit_redactions) reference it by name;
--    foreign keys are deferred so the swap is checked once, at commit. The redaction trigger
--    that writes core_audit is dropped first and recreated after, so the rename sees a
--    consistent schema.
PRAGMA defer_foreign_keys = ON;

DROP TRIGGER core_audit_redactions_apply_audit;

CREATE TABLE core_audit_next (
  id TEXT PRIMARY KEY NOT NULL,
  at TEXT NOT NULL,
  operation TEXT NOT NULL,
  risk TEXT NOT NULL
    CHECK (risk IN ('read', 'write', 'bulk-write', 'destructive', 'schema', 'extension', 'outbound')),
  actor TEXT NOT NULL CHECK (actor IN ('human', 'assistant', 'mcp', 'automation', 'extension')),
  user_id TEXT,
  origin TEXT NOT NULL CHECK (json_valid(origin)),
  input TEXT NOT NULL CHECK (json_valid(input)),
  result TEXT CHECK (result IS NULL OR json_valid(result)),
  gate_decision TEXT NOT NULL CHECK (gate_decision IN ('auto', 'review', 'deny')),
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'forbidden', 'denied', 'review', 'error')),
  error TEXT CHECK (error IS NULL OR json_valid(error)),
  -- Migration 0010: the pending action an audit row queued or applied.
  pending_action_id TEXT
);

INSERT INTO core_audit_next
  (id, at, operation, risk, actor, user_id, origin, input, result, gate_decision, outcome, error,
   pending_action_id)
SELECT id, at, operation, risk, actor, user_id, origin, input, result, gate_decision, outcome, error,
  pending_action_id
FROM core_audit;

DROP TABLE core_audit;
ALTER TABLE core_audit_next RENAME TO core_audit;

CREATE INDEX core_audit_at_idx ON core_audit (at, id);
CREATE INDEX core_audit_user_idx ON core_audit (user_id, at);
CREATE INDEX core_audit_operation_idx ON core_audit (operation, at);
CREATE INDEX core_audit_actor_idx ON core_audit (actor, at);
CREATE INDEX core_audit_pending_action_idx ON core_audit (pending_action_id)
  WHERE pending_action_id IS NOT NULL;

-- The approval queue (migration 0010) accepts actor `extension` too: a gate `review` on an
-- extension's call queues a pending action like any other. Same rebuild, same deferred keys.
CREATE TABLE core_change_set_next (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT,
  session_id TEXT,
  client_id TEXT,
  client_name TEXT,
  user_id TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('human', 'assistant', 'mcp', 'automation', 'extension')),
  origin TEXT NOT NULL CHECK (json_valid(origin)),
  explicit INTEGER NOT NULL DEFAULT 0 CHECK (explicit IN (0, 1)),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'committed', 'closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  committed_at TEXT,
  closed_at TEXT
);
INSERT INTO core_change_set_next SELECT * FROM core_change_set;
DROP TABLE core_change_set;
ALTER TABLE core_change_set_next RENAME TO core_change_set;
CREATE INDEX core_change_set_session_idx ON core_change_set (session_id, state, created_at);
CREATE INDEX core_change_set_state_idx ON core_change_set (state, created_at);
CREATE INDEX core_change_set_user_idx ON core_change_set (user_id, created_at);

CREATE TABLE core_pending_action_next (
  id TEXT PRIMARY KEY NOT NULL,
  change_set_id TEXT NOT NULL REFERENCES core_change_set (id),
  operation TEXT NOT NULL,
  risk TEXT NOT NULL
    CHECK (risk IN ('read', 'write', 'bulk-write', 'destructive', 'schema', 'extension', 'outbound')),
  input TEXT NOT NULL CHECK (json_valid(input)),
  reason TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('human', 'assistant', 'mcp', 'automation', 'extension')),
  user_id TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (json_valid(origin)),
  granted_permissions TEXT CHECK (granted_permissions IS NULL OR json_valid(granted_permissions)),
  bulk_size INTEGER NOT NULL DEFAULT 1,
  preview TEXT NOT NULL CHECK (json_valid(preview)),
  simulated TEXT NOT NULL CHECK (json_valid(simulated)),
  provisional TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(provisional)),
  depends_on TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(depends_on)),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'applied', 'failed', 'skipped', 'rejected', 'expired')),
  status_reason TEXT,
  error TEXT CHECK (error IS NULL OR json_valid(error)),
  bindings TEXT CHECK (bindings IS NULL OR json_valid(bindings)),
  result TEXT CHECK (result IS NULL OR json_valid(result)),
  request_audit_id TEXT,
  applied_audit_id TEXT,
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
INSERT INTO core_pending_action_next SELECT * FROM core_pending_action;
DROP TABLE core_pending_action;
ALTER TABLE core_pending_action_next RENAME TO core_pending_action;
CREATE INDEX core_pending_action_set_idx ON core_pending_action (change_set_id, id);
CREATE INDEX core_pending_action_status_idx ON core_pending_action (status, expires_at);

CREATE TRIGGER core_audit_no_update BEFORE UPDATE ON core_audit
WHEN NOT (
  EXISTS (SELECT 1 FROM core_audit_redactions r WHERE r.audit_id = OLD.id)
  AND NEW.id IS OLD.id
  AND NEW.at IS OLD.at
  AND NEW.operation IS OLD.operation
  AND NEW.risk IS OLD.risk
  AND NEW.actor IS OLD.actor
  AND NEW.user_id IS OLD.user_id
  AND NEW.origin IS OLD.origin
  AND NEW.gate_decision IS OLD.gate_decision
  AND NEW.outcome IS OLD.outcome
  AND NEW.input IS '"[erased]"'
  AND NEW.result IS (CASE WHEN OLD.result IS NULL THEN NULL ELSE '"[erased]"' END)
  AND NEW.error IS (CASE WHEN OLD.error IS NULL THEN NULL
    ELSE json_object('code', json_extract(OLD.error, '$.code'), 'message', '[erased]') END)
)
BEGIN
  SELECT RAISE(ABORT, 'core_audit is append-only');
END;

CREATE TRIGGER core_audit_no_delete BEFORE DELETE ON core_audit
BEGIN
  SELECT RAISE(ABORT, 'core_audit is append-only');
END;

CREATE TRIGGER core_audit_redactions_apply_audit AFTER INSERT ON core_audit_redactions
WHEN NEW.audit_id IS NOT NULL
BEGIN
  UPDATE core_audit SET
    input = '"[erased]"',
    result = CASE WHEN result IS NULL THEN NULL ELSE '"[erased]"' END,
    error = CASE WHEN error IS NULL THEN NULL
      ELSE json_object('code', json_extract(error, '$.code'), 'message', '[erased]') END
  WHERE id = NEW.audit_id;
END;

-- 2. Extension principals. Each installed extension acts as a core_user row of kind
--    `extension` (id `extension:<id>`), so created_by/owner columns and the audit log can name
--    it. They cannot sign in (no account), are never the first admin, and are not listed.
ALTER TABLE core_user ADD COLUMN kind TEXT NOT NULL DEFAULT 'human'
  CHECK (kind IN ('human', 'extension'));

DROP TRIGGER core_user_first_admin;
CREATE TRIGGER core_user_first_admin
AFTER INSERT ON core_user
WHEN NEW.kind = 'human' AND (SELECT COUNT(*) FROM core_user WHERE kind = 'human') = 1
BEGIN
  UPDATE core_user SET role = 'admin' WHERE id = NEW.id;
END;

DROP VIEW crm_users;
CREATE VIEW crm_users AS
SELECT u.id, u.name, u.email, u.role, u.image, u.created_at
FROM core_user u
WHERE u.kind = 'human';

-- 3. Base read views for core objects. crm_people, crm_organisations, crm_activities and
--    crm_tasks become `SELECT b.* FROM core_base_<x> b` plus LEFT JOINs to extension side
--    tables, regenerated by the reconciler. Core migrations change core_base_* (never the crm_*
--    views of these four objects); SQLite expands `b.*` when the view is used, so new core
--    columns appear in crm_* without a reconcile. query.sql cannot name core_base_* (core_
--    prefix), only the crm_* views over them.
-- The bodies are the 0007 definitions.
CREATE VIEW core_base_people AS
SELECT
  person.id,
  person.display_name,
  person.given_name,
  person.family_name,
  (SELECT e.email FROM core_person_emails e
    WHERE e.person_id = person.id AND e.is_primary = 1) AS primary_email,
  (SELECT json_group_array(e.email) FROM
    (SELECT email FROM core_person_emails WHERE person_id = person.id ORDER BY position) e) AS emails,
  (SELECT ph.number FROM core_person_phones ph
    WHERE ph.person_id = person.id AND ph.is_primary = 1) AS primary_phone,
  aff.id AS primary_affiliation_id,
  aff.title AS job_title,
  aff.organisation_id AS organisation_id,
  org.name AS organisation_name,
  person.location,
  person.timezone,
  person.owner_id,
  person.avatar_key,
  (SELECT json_group_array(t.name) FROM
    (SELECT tg.name FROM core_record_tags rt JOIN core_tags tg ON tg.id = rt.tag_id
      WHERE rt.object_type = 'person' AND rt.record_id = person.id ORDER BY tg.name) t) AS tags,
  person.created_at,
  person.updated_at
FROM core_person person
LEFT JOIN core_affiliation aff
  ON aff.person_id = person.id AND aff.is_primary = 1 AND aff.deleted_at IS NULL
LEFT JOIN core_organisation org
  ON org.id = aff.organisation_id AND org.deleted_at IS NULL
WHERE person.deleted_at IS NULL;

CREATE VIEW core_base_organisations AS
SELECT
  organisation.id,
  organisation.name,
  (SELECT d.domain FROM core_organisation_domains d
    WHERE d.organisation_id = organisation.id AND d.is_primary = 1) AS primary_domain,
  (SELECT json_group_array(d.domain) FROM
    (SELECT domain FROM core_organisation_domains WHERE organisation_id = organisation.id
      ORDER BY position) d) AS domains,
  organisation.website,
  organisation.industry,
  organisation.parent_id,
  parent.name AS parent_name,
  organisation.owner_id,
  organisation.avatar_key,
  (SELECT COUNT(*) FROM core_affiliation a JOIN core_person p ON p.id = a.person_id
    WHERE a.organisation_id = organisation.id AND a.is_current = 1
      AND a.deleted_at IS NULL AND p.deleted_at IS NULL) AS current_people_count,
  (SELECT json_group_array(t.name) FROM
    (SELECT tg.name FROM core_record_tags rt JOIN core_tags tg ON tg.id = rt.tag_id
      WHERE rt.object_type = 'organisation' AND rt.record_id = organisation.id
      ORDER BY tg.name) t) AS tags,
  organisation.created_at,
  organisation.updated_at
FROM core_organisation organisation
LEFT JOIN core_organisation parent
  ON parent.id = organisation.parent_id AND parent.deleted_at IS NULL
WHERE organisation.deleted_at IS NULL;

CREATE VIEW core_base_activities AS
SELECT
  activity.id,
  activity.type,
  activity.subject,
  activity.body,
  activity.payload,
  activity.occurred_at,
  activity.author_user_id,
  activity.author_actor,
  activity.created_at,
  activity.updated_at
FROM core_activity activity
WHERE activity.deleted_at IS NULL;

CREATE VIEW core_base_tasks AS
SELECT
  task.id,
  task.title,
  task.notes,
  task.due_at,
  task.status,
  task.completed_at,
  task.assignee_id,
  task.created_by,
  task.created_at,
  task.updated_at
FROM core_task task
WHERE task.deleted_at IS NULL;

DROP VIEW crm_people;
CREATE VIEW crm_people AS SELECT b.* FROM core_base_people b;
DROP VIEW crm_organisations;
CREATE VIEW crm_organisations AS SELECT b.* FROM core_base_organisations b;
DROP VIEW crm_activities;
CREATE VIEW crm_activities AS SELECT b.* FROM core_base_activities b;
DROP VIEW crm_tasks;
CREATE VIEW crm_tasks AS SELECT b.* FROM core_base_tasks b;

-- 4. Extension state (ADR 0025). One row per installed extension; its manifest is the JSON the
--    sandbox produced from its source at `commit_oid` in the extension workspace.
CREATE TABLE core_extensions (
  id TEXT PRIMARY KEY NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('shipped', 'runtime')),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'quarantined')),
  status_reason TEXT,
  version TEXT NOT NULL,
  commit_oid TEXT NOT NULL,
  -- The last version that ran without failing, offered for rollback on quarantine.
  last_good_commit TEXT,
  manifest TEXT NOT NULL CHECK (json_valid(manifest)),
  -- Consecutive failed runs; 3 quarantines the extension.
  failure_count INTEGER NOT NULL DEFAULT 0,
  -- The extension principal (core_user kind 'extension').
  user_id TEXT NOT NULL REFERENCES core_user (id),
  installed_at TEXT NOT NULL,
  installed_by TEXT REFERENCES core_user (id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
);

-- Every version ever installed (a commit in the workspace), for history and rollback.
CREATE TABLE core_extension_versions (
  extension_id TEXT NOT NULL REFERENCES core_extensions (id) ON DELETE CASCADE,
  commit_oid TEXT NOT NULL,
  version TEXT NOT NULL,
  manifest TEXT NOT NULL CHECK (json_valid(manifest)),
  installed_at TEXT NOT NULL,
  installed_by TEXT REFERENCES core_user (id) ON DELETE SET NULL,
  PRIMARY KEY (extension_id, commit_oid)
);

-- Run history: one row per execution of extension code (tool calls, manifest evaluation).
CREATE TABLE core_extension_runs (
  id TEXT PRIMARY KEY NOT NULL,
  extension_id TEXT NOT NULL,
  commit_oid TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('tool', 'manifest', 'automation')),
  name TEXT,
  actor TEXT,
  user_id TEXT,
  started_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'error', 'timeout')),
  error TEXT CHECK (error IS NULL OR json_valid(error)),
  logs TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(logs)),
  operations TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(operations))
);
CREATE INDEX core_extension_runs_ext_idx ON core_extension_runs (extension_id, started_at);

-- codemode:storage: per-extension key-value storage.
CREATE TABLE core_extension_kv (
  extension_id TEXT NOT NULL,
  key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 512),
  value TEXT NOT NULL CHECK (json_valid(value)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (extension_id, key)
);

-- Reconciler state (ADR 0024): the physical x_* tables and columns behind declared objects and
-- fields. Removed objects and fields are `hidden` (data kept) until dropped explicitly.
CREATE TABLE core_extension_objects (
  name TEXT PRIMARY KEY NOT NULL,
  extension_id TEXT NOT NULL,
  local_name TEXT NOT NULL,
  table_name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'hidden')),
  hidden_at TEXT,
  definition TEXT NOT NULL CHECK (json_valid(definition)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE core_extension_fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  extension_id TEXT NOT NULL,
  -- Registry name of the object the field belongs to: `organisation`, `example.project`.
  object TEXT NOT NULL,
  -- Name as declared in the extension.
  local_name TEXT NOT NULL,
  -- Registry field name: the local name on the extension's own objects, `<ext>.<name>` elsewhere.
  name TEXT NOT NULL,
  table_name TEXT NOT NULL,
  -- NULL for formula fields (computed in the crm_* view).
  column_name TEXT,
  type TEXT NOT NULL,
  definition TEXT NOT NULL CHECK (json_valid(definition)),
  status TEXT NOT NULL CHECK (status IN ('active', 'hidden')),
  hidden_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX core_extension_fields_name_uq ON core_extension_fields (object, name);
CREATE UNIQUE INDEX core_extension_fields_column_uq ON core_extension_fields (table_name, column_name)
  WHERE column_name IS NOT NULL;

UPDATE core_meta SET value = '20' WHERE key = 'schema_version';
