-- Stage 8: release state and update history (ADR 0160, ADR 0164).
--
-- core_install: what the installer chose (hostname, identity adapter, installed gatekeepers,
-- resource ids, var overrides), as JSON under key 'deployment', written by `create-crm` and
-- read by `crm upgrade` and the self-updater so every deploy of this deployment is the same.
-- It holds no secrets.
CREATE TABLE core_install (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL CHECK (json_valid(value)),
  updated_at TEXT NOT NULL
);

-- Every update and rollback, from Settings → Updates (surface 'ui') or the CLI ('cli'), with the
-- D1 Time Travel bookmark taken before it changed anything. Rollback restores that bookmark.
CREATE TABLE core_update_runs (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('update', 'rollback')),
  from_version TEXT,
  to_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'rolled_back', 'failed')),
  step TEXT,
  bookmark TEXT,
  bundle_digest TEXT,
  preflight TEXT CHECK (preflight IS NULL OR json_valid(preflight)),
  error TEXT,
  started_by TEXT REFERENCES core_user (id) ON DELETE SET NULL,
  surface TEXT NOT NULL CHECK (surface IN ('ui', 'cli')),
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX core_update_runs_started_idx ON core_update_runs (started_at);

-- Public GitHub Releases, cached per channel so Settings → Updates stays inside GitHub's
-- anonymous rate limit (ADR 0166).
CREATE TABLE core_release_cache (
  channel TEXT PRIMARY KEY NOT NULL CHECK (channel IN ('stable', 'beta')),
  releases TEXT NOT NULL CHECK (json_valid(releases)),
  fetched_at TEXT NOT NULL
);

UPDATE core_meta SET value = '160' WHERE key = 'schema_version';
