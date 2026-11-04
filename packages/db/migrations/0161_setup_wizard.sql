-- Stage 8: the first-run setup wizard (ADR 0167).
--
-- core_setup: one row. A fresh install (no human users yet when migrations run) starts
-- 'pending', so the first admin is taken to /setup; a deployment upgraded into stage 8 already
-- has users and starts 'skipped' (Settings → General can still open the wizard). `step` and
-- `data` make it resumable.
CREATE TABLE core_setup (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed', 'skipped')),
  step TEXT NOT NULL DEFAULT 'admin',
  data TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data)),
  updated_at TEXT NOT NULL,
  updated_by TEXT REFERENCES core_user (id) ON DELETE SET NULL,
  completed_at TEXT
);
INSERT INTO core_setup (id, status, step, updated_at)
SELECT 1,
  CASE WHEN EXISTS (SELECT 1 FROM core_user WHERE kind = 'human') THEN 'skipped' ELSE 'pending' END,
  'admin',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

-- Records created by "Install sample data", so "Remove sample data" deletes exactly those.
CREATE TABLE core_sample_records (
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (object_type, record_id)
);

UPDATE core_meta SET value = '161' WHERE key = 'schema_version';
