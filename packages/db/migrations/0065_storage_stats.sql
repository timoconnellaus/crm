-- Migration 0065: the storage gauge's cache (ADR 0090). The daily cron, or an admin's refresh,
-- records the database size and the row counts of the big tables here, so Settings → Storage
-- reads one row instead of counting millions on every page view.
CREATE TABLE core_storage_stats (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- D1's meta.size_after in bytes, or null where the runtime does not report it.
  size_bytes INTEGER,
  -- JSON {"core_audit": n, ...}.
  tables TEXT NOT NULL CHECK (json_valid(tables)),
  measured_at TEXT NOT NULL
);

UPDATE core_meta SET value = '65' WHERE key = 'schema_version';
