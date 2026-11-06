-- Migration 0358: cache observations for review (stage 17 W2, ADR 0341, spec "Review data").
--
-- One row per model response of the assistant's thread (and its compaction calls): the gap since
-- the previous request on the same thread, whether the cached prefix (system and tools) was
-- unchanged, and how many prompt tokens the provider reported cached. The cache-lifetime learner
-- counts them as they arrive; this table keeps them so the maths can be checked and retuned later
-- (`ai.cacheReport`, `pnpm ai:replay-cache`). Never a prompt, a reply or anyone's words. Kept 180
-- days (the daily cron purges older rows).
CREATE TABLE core_ai_cache_observation (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  role TEXT NOT NULL,
  gap_seconds REAL NOT NULL,
  prefix_unchanged INTEGER NOT NULL,
  cached_tokens INTEGER NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  -- The previous request's prompt tokens: the part this request could find cached.
  prefix_tokens INTEGER
);
CREATE INDEX core_ai_cache_observation_at_idx ON core_ai_cache_observation (at);

UPDATE core_meta SET value = '358' WHERE key = 'schema_version';
