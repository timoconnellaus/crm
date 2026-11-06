-- Migration 0359: compaction planner decisions for review (stage 17 W2, ADR 0341).
--
-- One row per planner run (at the end of a turn, and when the idle alarm fires): the planner's
-- input verbatim (sizes, prices, the lifetime estimate and its confidence, the person's usage
-- profile, the rails), its result (both expected costs, the decision and the rule that made it),
-- and later the actual cost of the turns that followed, so predicted and real cost can be
-- compared. Sizes, prices and times only; never message content. Kept 180 days.
CREATE TABLE core_ai_compaction_decision (
  id TEXT PRIMARY KEY NOT NULL,
  at TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  role TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('compact', 'continue')),
  rule TEXT NOT NULL,
  input TEXT NOT NULL CHECK (json_valid(input)),
  result TEXT NOT NULL CHECK (json_valid(result)),
  -- Filled in once the horizon's turns have run.
  actual_turns INTEGER,
  actual_cost REAL,
  actual_at TEXT
);
CREATE INDEX core_ai_compaction_decision_at_idx ON core_ai_compaction_decision (at);

UPDATE core_meta SET value = '359' WHERE key = 'schema_version';
