-- Migration 0320: duplicates (stage 16, ADR 0247).
--
-- name_key: the normalised name (packages/core/src/duplicates/normalise.ts), written by code on
-- every write that sets a name. Normalisation (legal forms, diacritics, name order) cannot be done
-- in SQL, so existing rows are filled by a one-off chunked backfill in ros-runner, tracked in
-- core_settings ('duplicate_scan'); the scan waits for it.
ALTER TABLE core_person ADD COLUMN name_key TEXT;
ALTER TABLE core_organisation ADD COLUMN name_key TEXT;
CREATE INDEX core_person_name_key_idx ON core_person (name_key, id) WHERE deleted_at IS NULL;
CREATE INDEX core_organisation_name_key_idx ON core_organisation (name_key, id)
  WHERE deleted_at IS NULL;

-- The incremental scan reads records changed since its cursor, so its reads follow the number of
-- changed records, not the table size. The backfill walks rows without a key by id.
CREATE INDEX core_person_updated_idx ON core_person (updated_at, id);
CREATE INDEX core_organisation_updated_idx ON core_organisation (updated_at, id);
CREATE INDEX core_person_no_name_key_idx ON core_person (id) WHERE name_key IS NULL;
CREATE INDEX core_organisation_no_name_key_idx ON core_organisation (id) WHERE name_key IS NULL;

-- Likely duplicates found by the scan, one row per pair (a_id < b_id). rules is a JSON array of
-- rule ids; details holds what each rule matched (the organisation, the domain, the number), so
-- the reason sentence can be shown without reading again. A dismissed pair is never suggested
-- again; a merged one is closed by the merge.
CREATE TABLE core_duplicate_pair (
  object TEXT NOT NULL CHECK (object IN ('person', 'organisation')),
  a_id TEXT NOT NULL,
  b_id TEXT NOT NULL,
  rules TEXT NOT NULL CHECK (json_valid(rules)),
  details TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details)),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'merged')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  PRIMARY KEY (object, a_id, b_id),
  CHECK (a_id < b_id)
) WITHOUT ROWID;
CREATE INDEX core_duplicate_pair_status_idx ON core_duplicate_pair (object, status, a_id, b_id);
CREATE INDEX core_duplicate_pair_b_idx ON core_duplicate_pair (object, b_id);

UPDATE core_meta SET value = '320' WHERE key = 'schema_version';
