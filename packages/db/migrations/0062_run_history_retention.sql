-- Migration 0062: run history retention (ADR 0090, cost audit F16). The daily cron deletes
-- successful extension and automation runs after 30 days and failed ones after 90. This index
-- lets each chunk find the oldest runs of an outcome without scanning the table.
CREATE INDEX core_extension_runs_outcome_idx ON core_extension_runs (outcome, started_at);

UPDATE core_meta SET value = '62' WHERE key = 'schema_version';
