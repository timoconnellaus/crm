-- Migration 0080: view types and dashboards (stage 4a, ADR 0027, ADR 0056, ADR 0057).
--
-- 1. Saved views can be shared with the org. A view spec is now a discriminated union
--    (`table | board | calendar | gallery`); stored stage-1 table specs are already valid
--    (`{ "type": "table", ... }`), so no data changes.
ALTER TABLE core_views ADD COLUMN shared INTEGER NOT NULL DEFAULT 0 CHECK (shared IN (0, 1));
CREATE INDEX core_views_shared_object_idx ON core_views (object, position) WHERE shared = 1;

-- 2. Dashboards: a title, filters, a layout grid and widgets (`spec`, JSON), owned by a user and
--    private to them unless shared. The shipped Overview dashboard lives in code, not here.
CREATE TABLE core_dashboards (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES core_user (id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (title <> ''),
  description TEXT,
  shared INTEGER NOT NULL DEFAULT 0 CHECK (shared IN (0, 1)),
  spec TEXT NOT NULL CHECK (json_valid(spec)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX core_dashboards_owner_idx ON core_dashboards (owner_id, title);
CREATE INDEX core_dashboards_shared_idx ON core_dashboards (title) WHERE shared = 1;

-- 3. Each user's Home: the dashboard rendered at `/`. No row means the shipped Overview.
CREATE TABLE core_user_home (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES core_user (id) ON DELETE CASCADE,
  dashboard_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 4. Typed extension settings (ADR 0058): one JSON object per extension, validated against the
--    `settings` its manifest declares.
CREATE TABLE core_extension_settings (
  extension_id TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL CHECK (json_valid(value)),
  updated_at TEXT NOT NULL,
  updated_by TEXT REFERENCES core_user (id) ON DELETE SET NULL
);

-- 5. Indexes the Overview dashboard's widgets need (ADR 0057: every widget query walks an
--    index). Partial on live rows, so Trash reads never pick them (see migration 0050).
CREATE INDEX core_person_created_idx ON core_person (created_at) WHERE deleted_at IS NULL;
CREATE INDEX core_organisation_created_idx ON core_organisation (created_at)
  WHERE deleted_at IS NULL;

UPDATE core_meta SET value = '80' WHERE key = 'schema_version';
