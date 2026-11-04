-- Migration 0150: in-app AI, first half (stage 7a; ADRs 0150-0155).
--
-- core_ai_summary: cached `summarise` output (record summaries, meeting prep, activity
--   one-liners, change-set summaries). One row per (kind, subject). `input_hash` is a SHA-256 of
--   the exact input the model saw plus the model id, so any change to the inputs (a new note, an
--   edited field, a different model) makes the row stale; nothing has to invalidate it. `sources`
--   lists the record ids the input was built from, so an erase (ADR 0019) can delete every
--   summary that mentioned the subject.
-- core_embedding: one row per embedded record: the hash of the text that was embedded and the
--   model. A record is re-embedded only when that hash changes (cost audit U9). Ids and hashes
--   only; the vectors live in Vectorize.
-- core_embedding_queue: records whose text may have changed, written in the same batch as the
--   change by the pipeline (and by erase). Drained in batches after the commit and by the cron
--   (ADR 0154). Stage 5's event queue can replace the producer side without touching the drain.

CREATE TABLE core_ai_summary (
  kind TEXT NOT NULL CHECK (kind IN ('record', 'meeting', 'activity', 'changeset')),
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  text TEXT NOT NULL,
  model TEXT NOT NULL,
  sources TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sources)),
  created_at TEXT NOT NULL,
  created_by TEXT,
  PRIMARY KEY (kind, subject_type, subject_id)
) WITHOUT ROWID;

CREATE TABLE core_embedding (
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  vector_id TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  embedded_at TEXT NOT NULL,
  PRIMARY KEY (object_type, record_id)
) WITHOUT ROWID;

CREATE TABLE core_embedding_queue (
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  queued_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (object_type, record_id)
) WITHOUT ROWID;
CREATE INDEX core_embedding_queue_at_idx ON core_embedding_queue (attempts, queued_at);

UPDATE core_meta SET value = '150' WHERE key = 'schema_version';
