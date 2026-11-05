-- Migration 0205: the policy adjudicator (stage 7b, ADR 0011, ADR 0031, ADR 0204).
--
-- The adjudicator judges pending actions the gate routed to `review` against the org's written
-- policy, using the `review` model role. Its settings (mode off / shadow / active, confidence
-- threshold) are the core_settings key `adjudicator`; missing means off.

-- Why the gate routed a pending action to review, so the adjudicator knows what it may approve:
--   policy: the org's preset said review.
--   floor: the deploy-time floor (APPROVAL_FLOOR) pinned it to review. Never auto-approved.
--   always: the operation always waits for a person (extension installs). Never auto-approved.
--   dependency: the preset said auto, but it refers to a record still pending creation.
-- Null for actions queued before this migration and for outbound items: never auto-approved.
ALTER TABLE core_pending_action ADD COLUMN review_source TEXT
  CHECK (review_source IS NULL OR review_source IN ('policy', 'floor', 'always', 'dependency'));

-- The written policy: plain text only human admins can edit (adjudicator.setPolicy). Each edit
-- adds a version; the highest is in force, and every verdict names the version and hash it
-- judged against.
CREATE TABLE core_written_policy (
  version INTEGER PRIMARY KEY NOT NULL,
  text TEXT NOT NULL,
  -- SHA-256 of the text, hex.
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);

-- One verdict per pending action. Visible to human approvers only (never to the actor).
CREATE TABLE core_adjudication (
  id TEXT PRIMARY KEY NOT NULL,
  action_id TEXT NOT NULL,
  judged_at TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('shadow', 'active')),
  verdict TEXT NOT NULL CHECK (verdict IN ('approve', 'deny', 'escalate')),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  -- The reviewer's reason (or why there is no real verdict: an invalid reply, a model error).
  reason TEXT NOT NULL,
  -- recorded: shadow mode, nothing done. approved: applied as the original actor.
  -- apply_failed: approved, but applying failed (the action is marked failed).
  -- escalated: active mode, left for a person (note says why).
  outcome TEXT NOT NULL CHECK (outcome IN ('recorded', 'approved', 'apply_failed', 'escalated')),
  -- 1 when the adjudicator changed the action (approved or apply_failed).
  acted INTEGER NOT NULL DEFAULT 0 CHECK (acted IN (0, 1)),
  -- Why an active-mode verdict was not acted on: deny, escalate, low_confidence, floor, always,
  -- risk, dependency, unknown_source. Also invalid (no valid reply) and error (the model failed).
  note TEXT,
  provider TEXT,
  model TEXT,
  policy_version INTEGER,
  policy_hash TEXT,
  threshold REAL NOT NULL,
  -- JSON { code, message } when the model failed or replied invalidly.
  error TEXT CHECK (error IS NULL OR json_valid(error)),
  audit_id TEXT NOT NULL
);
-- One verdict per action (claims it, so the post-commit run and the cron sweep never both act).
CREATE UNIQUE INDEX core_adjudication_action_idx ON core_adjudication (action_id);
-- The agreement-rate view reads verdicts by period.
CREATE INDEX core_adjudication_judged_idx ON core_adjudication (judged_at);

UPDATE core_meta SET value = '205' WHERE key = 'schema_version';
