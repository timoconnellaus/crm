-- Migration 0100: stage history and the base currency (stage 4b, ADR 0100, ADR 0101).
--
-- Stage history is one row per stage a record has been in: entered and left times. The host
-- writes it in the same batch as the record change whenever an object with a stage behaviour
-- (an extension's `stages`, e.g. Deals) enters a stage. It powers time-in-stage and velocity.
-- `left_at` is NULL for the stage a record is in now; at most one such row per record.
CREATE TABLE core_stage_history (
  id TEXT PRIMARY KEY NOT NULL,
  -- Registry name of the object: `deals.deal`.
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  -- The stage's group (pipeline) when the record entered it, if the behaviour has groups.
  group_id TEXT,
  -- The stage type when the record entered it: open, won or lost.
  stage_type TEXT NOT NULL CHECK (stage_type IN ('open', 'won', 'lost')),
  entered_at TEXT NOT NULL,
  left_at TEXT,
  entered_by TEXT
);

-- A record's history in order, and its current stage (the left_at IS NULL row).
CREATE INDEX core_stage_history_record_idx
  ON core_stage_history (object_type, record_id, entered_at);
CREATE UNIQUE INDEX core_stage_history_current_idx
  ON core_stage_history (object_type, record_id) WHERE left_at IS NULL;
-- Time in stage and conversion per stage over a period.
CREATE INDEX core_stage_history_stage_idx ON core_stage_history (stage_id, entered_at);

-- Read view for query.sql and dashboards. `days_in_stage` runs to now for the current stage.
CREATE VIEW crm_stage_history AS
SELECT
  id,
  object_type,
  record_id,
  stage_id,
  group_id,
  stage_type,
  entered_at,
  left_at,
  left_at IS NULL AS is_current,
  round(
    julianday(coalesce(left_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))) - julianday(entered_at),
    4
  ) AS days_in_stage,
  entered_by
FROM core_stage_history;

-- The deployment's one base currency (ADR 0026). Currency fields without their own currency
-- display in it. Changed with settings.update (admins).
INSERT OR IGNORE INTO core_settings (key, value, updated_at)
VALUES ('base_currency', '"USD"', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

UPDATE core_meta SET value = '100' WHERE key = 'schema_version';
