-- Migration 0008: sanctioned redaction of personal data in the audit log (ADR 0019).
--
-- core_audit and core_audit_changes stay append-only: DELETE is always refused, and UPDATE is
-- refused unless it is exactly the canonical redaction of a row that has a marker in
-- core_audit_redactions. Markers are themselves append-only and say which erase removed what,
-- so a redaction can never be silent.
--
-- The only way to redact is to insert a marker; the AFTER INSERT triggers below perform the
-- canonical UPDATE. A direct UPDATE passes the guard only if it writes the same canonical values
-- to a marked row, so nothing but "[erased]" can ever be written over audit content.
--
-- Canonical redaction:
--   core_audit:          input -> "[erased]"; result -> "[erased]" (if not null);
--                        error -> {"code": <kept>, "message": "[erased]"} (if not null).
--                        Who, when, which operation, risk, actor, origin, gate decision and
--                        outcome are kept.
--   core_audit_changes:  diff keeps its field names; every before/after value becomes
--                        "[erased]". Record, action and time are kept.

CREATE TABLE core_audit_redactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Exactly one target: an audit row or a field-change row.
  audit_id TEXT REFERENCES core_audit (id),
  change_id INTEGER REFERENCES core_audit_changes (id),
  -- The erased record (ids carry no personal data).
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  -- The erase operation that caused it, and who ran it.
  operation TEXT NOT NULL,
  user_id TEXT,
  at TEXT NOT NULL,
  CHECK ((audit_id IS NULL) <> (change_id IS NULL))
);
CREATE UNIQUE INDEX core_audit_redactions_audit_uq ON core_audit_redactions (audit_id)
  WHERE audit_id IS NOT NULL;
CREATE UNIQUE INDEX core_audit_redactions_change_uq ON core_audit_redactions (change_id)
  WHERE change_id IS NOT NULL;
CREATE INDEX core_audit_redactions_record_idx ON core_audit_redactions (object_type, record_id);

CREATE TRIGGER core_audit_redactions_no_update BEFORE UPDATE ON core_audit_redactions
BEGIN
  SELECT RAISE(ABORT, 'core_audit_redactions is append-only');
END;

CREATE TRIGGER core_audit_redactions_no_delete BEFORE DELETE ON core_audit_redactions
BEGIN
  SELECT RAISE(ABORT, 'core_audit_redactions is append-only');
END;

-- Guards: replace the unconditional UPDATE refusals from migration 0005. DELETE refusals stay.

DROP TRIGGER core_audit_no_update;
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

DROP TRIGGER core_audit_changes_no_update;
CREATE TRIGGER core_audit_changes_no_update BEFORE UPDATE ON core_audit_changes
WHEN NOT (
  EXISTS (SELECT 1 FROM core_audit_redactions r WHERE r.change_id = OLD.id)
  AND NEW.id IS OLD.id
  AND NEW.audit_id IS OLD.audit_id
  AND NEW.object_type IS OLD.object_type
  AND NEW.record_id IS OLD.record_id
  AND NEW.action IS OLD.action
  AND NEW.at IS OLD.at
  AND NEW.diff IS (
    SELECT coalesce(json_group_object(j.key, json_object('before', '[erased]', 'after', '[erased]')), '{}')
    FROM json_each(OLD.diff) j
  )
)
BEGIN
  SELECT RAISE(ABORT, 'core_audit_changes is append-only');
END;

-- Inserting a marker applies the canonical redaction to its target.

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

CREATE TRIGGER core_audit_redactions_apply_change AFTER INSERT ON core_audit_redactions
WHEN NEW.change_id IS NOT NULL
BEGIN
  UPDATE core_audit_changes SET diff = (
    SELECT coalesce(json_group_object(j.key, json_object('before', '[erased]', 'after', '[erased]')), '{}')
    FROM json_each(core_audit_changes.diff) j
  )
  WHERE id = NEW.change_id;
END;

UPDATE core_meta SET value = '8' WHERE key = 'schema_version';
