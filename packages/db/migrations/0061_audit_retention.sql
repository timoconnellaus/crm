-- Migration 0061: audit retention, a sanctioned purge path through the append-only triggers
-- (ADR 0055; amends ADR 0017, in the spirit of ADR 0019's redaction markers).
--
-- Retention is an org setting, `audit_retention` = {"years": null | 1 | 2 | 7}. null (the
-- default, and the meaning of a missing row) keeps the audit log forever. Only a human admin can
-- change it (`audit.setRetention`, risk destructive).
--
-- DELETE on core_audit, core_audit_changes and core_audit_redactions stays refused unless
-- retention is not "forever" AND the row is older than the cutoff of a purge marker in
-- core_audit_purges. A marker can only be inserted with the current setting and a cutoff at least
-- that many years before the database clock, and markers are append-only. So:
--   - an ordinary DELETE of audit rows inside the retention window still fails "append-only";
--   - nothing can purge what the admin's setting keeps, whatever code inserts the marker;
--   - every purge leaves a permanent marker, and its own audit row (`audit.purge`).
CREATE TABLE core_audit_purges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Audit rows with `at` before this may be deleted, with their change rows and markers.
  cutoff TEXT NOT NULL,
  -- The retention setting in force when the marker was written.
  retention_years INTEGER NOT NULL CHECK (retention_years IN (1, 2, 7)),
  -- The audit.purge invocation's own audit row, written in the same batch.
  audit_id TEXT,
  user_id TEXT,
  at TEXT NOT NULL
);
CREATE INDEX core_audit_purges_cutoff_idx ON core_audit_purges (cutoff);

CREATE TRIGGER core_audit_purges_no_update BEFORE UPDATE ON core_audit_purges
BEGIN
  SELECT RAISE(ABORT, 'core_audit_purges is append-only');
END;

CREATE TRIGGER core_audit_purges_no_delete BEFORE DELETE ON core_audit_purges
BEGIN
  SELECT RAISE(ABORT, 'core_audit_purges is append-only');
END;

-- A marker must match the current setting and lie at least that many years in the past.
CREATE TRIGGER core_audit_purges_check BEFORE INSERT ON core_audit_purges
WHEN NOT (
  NEW.retention_years IS (
    SELECT json_extract(value, '$.years') FROM core_settings WHERE key = 'audit_retention'
  )
  AND NEW.cutoff <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || NEW.retention_years || ' years')
)
BEGIN
  SELECT RAISE(ABORT, 'audit purge cutoff is inside the retention window');
END;

-- Guards: replace the unconditional DELETE refusals (migrations 0005, 0008, 0020).

DROP TRIGGER core_audit_no_delete;
CREATE TRIGGER core_audit_no_delete BEFORE DELETE ON core_audit
WHEN NOT (
  (SELECT json_extract(value, '$.years') FROM core_settings WHERE key = 'audit_retention')
    IS NOT NULL
  AND OLD.at < coalesce((SELECT max(cutoff) FROM core_audit_purges), '')
)
BEGIN
  SELECT RAISE(ABORT, 'core_audit is append-only');
END;

DROP TRIGGER core_audit_changes_no_delete;
CREATE TRIGGER core_audit_changes_no_delete BEFORE DELETE ON core_audit_changes
WHEN NOT (
  (SELECT json_extract(value, '$.years') FROM core_settings WHERE key = 'audit_retention')
    IS NOT NULL
  AND OLD.at < coalesce((SELECT max(cutoff) FROM core_audit_purges), '')
)
BEGIN
  SELECT RAISE(ABORT, 'core_audit_changes is append-only');
END;

-- A redaction marker goes with the audit or change row it redacted (its foreign key would
-- otherwise keep that row forever). The erase's own audit row is newer and stays.
DROP TRIGGER core_audit_redactions_no_delete;
CREATE TRIGGER core_audit_redactions_no_delete BEFORE DELETE ON core_audit_redactions
WHEN NOT (
  (SELECT json_extract(value, '$.years') FROM core_settings WHERE key = 'audit_retention')
    IS NOT NULL
  AND coalesce(
    (SELECT a.at FROM core_audit a WHERE a.id = OLD.audit_id),
    (SELECT c.at FROM core_audit_changes c WHERE c.id = OLD.change_id)
  ) < coalesce((SELECT max(cutoff) FROM core_audit_purges), '')
)
BEGIN
  SELECT RAISE(ABORT, 'core_audit_redactions is append-only');
END;

-- The default: keep forever.
INSERT INTO core_settings (key, value, updated_at)
VALUES ('audit_retention', '{"years":null}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT (key) DO NOTHING;

UPDATE core_meta SET value = '61' WHERE key = 'schema_version';
