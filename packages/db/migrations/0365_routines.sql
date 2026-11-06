-- Migration 0365: personal routines (stage 17 W4, ADR 0343).
--
-- A routine is a personal automation on the existing engine: a core_automations row with
-- `scope = 'personal'` and `owner_user_id` set, matched and started by the same dispatcher, under
-- the same kill switch and rails. Its extension_id is the reserved `routine` (there is no
-- extension: the Workflow runs its checks and delivery itself). Run history stays in
-- core_automation_runs. automation.* operations show only `scope = 'org'` rows: a routine belongs
-- to its owner.
ALTER TABLE core_automations ADD COLUMN owner_user_id TEXT;
ALTER TABLE core_automations ADD COLUMN scope TEXT NOT NULL DEFAULT 'org'
  CHECK (scope IN ('org', 'personal'));
CREATE INDEX core_automations_owner_idx ON core_automations (owner_user_id)
  WHERE owner_user_id IS NOT NULL;

-- What only a routine has: the person's words, what it sends and its delivery state. One row per
-- routine; `definition` is the RoutineDefinition JSON the automation's spec was built from.
CREATE TABLE core_routine (
  id TEXT PRIMARY KEY NOT NULL CHECK (id GLOB 'rtn_*'),
  automation_id TEXT NOT NULL UNIQUE,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  -- Finishes "I'll …": "send you your open deals with no activity for 14 days".
  what TEXT NOT NULL,
  -- What the person said when they asked for it, and when (the why panel). Null for an offer.
  asked TEXT,
  asked_at TEXT,
  definition TEXT NOT NULL CHECK (json_valid(definition)),
  -- The read-back it came from: pressing Turn on twice makes one routine.
  draft_id TEXT UNIQUE,
  -- Snoozed: runs before this are stopped at their checks.
  paused_until TEXT,
  last_delivered_at TEXT,
  -- The last delivery that failed (the app could not make the message). Cleared by the next one.
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX core_routine_owner_idx ON core_routine (owner_user_id, created_at);
