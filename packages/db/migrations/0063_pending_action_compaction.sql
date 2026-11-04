-- Migration 0063: compacting decided pending actions (ADR 0055, cost audit F17).
--
-- 30 days after a pending action was decided (applied, failed, skipped, rejected) or expired,
-- the daily cron replaces its input, preview and simulated records with empty values and keeps
-- a summary, `summary` = {"records": n, "actions": {"update": n, ...}, "inputBytes": n, ...},
-- next to the columns that already say what, who and when (operation, risk, actor, user_id,
-- status, decided_by, decided_at, result, error). `compacted_at` says when that happened.
ALTER TABLE core_pending_action ADD COLUMN compacted_at TEXT;
ALTER TABLE core_pending_action ADD COLUMN summary TEXT
  CHECK (summary IS NULL OR json_valid(summary));

-- Compaction candidates, oldest first: decided or expired, not yet compacted. Expired actions
-- have no decided_at, so the key is the decision time, else the expiry.
CREATE INDEX core_pending_action_compact_idx
  ON core_pending_action (coalesce(decided_at, expires_at))
  WHERE compacted_at IS NULL AND status <> 'pending';

UPDATE core_meta SET value = '63' WHERE key = 'schema_version';
