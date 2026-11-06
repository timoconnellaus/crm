-- Migration 0370: approvals by tap, typing or voice (stage 17 W5, ADR 0345).
--
-- `execution_id` makes applying idempotent: an approval claims the actions it will apply, in one
-- statement, before it applies any. A tap and a spoken yes that arrive together both ask, one
-- claims, and each action applies once. `execution_at` is when it was claimed: a claim left by a
-- request that died can be taken over after a few minutes, which is safe because each action
-- applies and changes status in one batch.
--
-- `decided_via` is how the person gave the decision. The person's words stay in their thread; they
-- are not copied here, so an erase has no new place to reach.
ALTER TABLE core_pending_action ADD COLUMN execution_id TEXT;
ALTER TABLE core_pending_action ADD COLUMN execution_at TEXT;
ALTER TABLE core_pending_action ADD COLUMN decided_via TEXT
  CHECK (decided_via IS NULL OR decided_via IN ('tap', 'typed', 'spoken'));
CREATE INDEX core_pending_action_execution_idx ON core_pending_action (execution_id)
  WHERE execution_id IS NOT NULL;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '370'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 370;
