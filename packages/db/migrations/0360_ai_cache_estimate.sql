-- Migration 0360: learned cache lifetimes per provider and model, and their history (stage 17
-- W2, ADR 0341).
--
-- `state` is the learner's state (decayed hit and miss counts per gap bucket and the learned
-- bucket), updated by each finished turn's bookkeeping write. `version` guards the
-- read-modify-write: an update that lost a race is dropped, and the observations it carried are
-- still in core_ai_cache_observation for a replay. Settings → AI shows the estimate read-only.
-- A deployment is one workspace, so rows are keyed by provider and model only.
CREATE TABLE core_ai_cache_estimate (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  state TEXT NOT NULL CHECK (json_valid(state)),
  learned_seconds REAL,
  published_seconds REAL,
  confidence REAL,
  sample_size REAL NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, model)
) WITHOUT ROWID;

-- Every change of a learned estimate (rise or fall), appended.
CREATE TABLE core_ai_cache_estimate_history (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  at TEXT NOT NULL,
  from_seconds REAL,
  to_seconds REAL,
  reason TEXT NOT NULL CHECK (reason IN ('rise', 'fall')),
  sample_size REAL NOT NULL
);
CREATE INDEX core_ai_cache_estimate_history_at_idx ON core_ai_cache_estimate_history (at);

UPDATE core_meta SET value = '360' WHERE key = 'schema_version';
