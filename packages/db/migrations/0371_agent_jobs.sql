-- Migration 0371: agents (stage 17 W5, ADR 0344).
--
-- One row per agent the assistant, a routine or a plugin started. In code they are jobs; the
-- person sees "Agents". The AgentJob Durable Object (`job:<id>`) runs the work and deletes its
-- storage when it is done; this row is what stays: the card, the limits, the results.
--
-- state:
--   awaiting_confirm  the grant is shown to the person first (the judge is off or could not answer)
--   refused           the grant was judged wider than the brief needs
--   queued            waiting for a slot (the per-user and per-workspace limits)
--   running           the object is working
--   paused            stopped at its spend limit, waiting for "Allow $X more"
--   done, stopped, failed, cancelled   finished
--
-- `access` is the grant (operations, target, caps, expiry) and `budget` the step, time and spend
-- limits, both JSON. `spent_microusd` is charged to the starter (`starter_kind`, `starter_id`).
-- `progress` is what the card shows ({ done, total, now }). `result` is the agent's final words.
CREATE TABLE core_agent_job (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES core_user (id) ON DELETE CASCADE,
  starter_kind TEXT NOT NULL CHECK (starter_kind IN ('user', 'routine', 'plugin')),
  starter_id TEXT NOT NULL,
  profile TEXT,
  role TEXT NOT NULL,
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  records TEXT NOT NULL CHECK (json_valid(records)),
  access TEXT NOT NULL CHECK (json_valid(access)),
  budget TEXT NOT NULL CHECK (json_valid(budget)),
  mode TEXT NOT NULL CHECK (mode IN ('awaited', 'background')),
  review_everything INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN (
    'awaiting_confirm', 'refused', 'queued', 'running', 'paused',
    'done', 'stopped', 'failed', 'cancelled'
  )),
  -- What the judge said about the grant (labels and probabilities), or why it could not.
  judged TEXT CHECK (judged IS NULL OR json_valid(judged)),
  justification TEXT,
  progress TEXT CHECK (progress IS NULL OR json_valid(progress)),
  steps INTEGER NOT NULL DEFAULT 0,
  spent_microusd INTEGER NOT NULL DEFAULT 0,
  fields_filled INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  error TEXT,
  -- The object has been told to start (its alarm owns the work from then on).
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX core_agent_job_user_idx ON core_agent_job (user_id, state, created_at);
CREATE INDEX core_agent_job_state_idx ON core_agent_job (state, created_at);

-- Which people, organisations (`per_…`, `org_…`) and email addresses (`email:<sha256>`) a job's
-- brief, records, progress and results name, so an erase finds the rows to redact (ADR 0320).
CREATE TABLE core_agent_job_refs (
  job_id TEXT NOT NULL REFERENCES core_agent_job (id) ON DELETE CASCADE,
  ref TEXT NOT NULL,
  PRIMARY KEY (job_id, ref)
) WITHOUT ROWID;
CREATE INDEX core_agent_job_refs_ref_idx ON core_agent_job_refs (ref);

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '371'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 371;
