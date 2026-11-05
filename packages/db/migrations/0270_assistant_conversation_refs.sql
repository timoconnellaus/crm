-- Migration 0270: which records each assistant conversation referenced (ADR 0019 and ADR 0200
-- amendments, 2026-11-05).
--
-- A conversation's history lives in its Durable Object, out of reach of a D1 query, so an erase
-- could not find the conversations that hold a person's details. This index says which ones do:
-- one row per conversation and referenced person or organisation id (`per_…`, `org_…`), or email
-- address as `email:<sha256 of the lower-cased address>`. The conversation object sends a turn's
-- refs with the once-per-turn `assistant.finishTurn` (no extra D1 request, never per token or tool
-- call). An erase scrubs the conversations listed for the subject and deletes those rows.
CREATE TABLE core_assistant_conversation_refs (
  conversation_id TEXT NOT NULL REFERENCES core_assistant_conversation (id),
  ref TEXT NOT NULL,
  PRIMARY KEY (conversation_id, ref)
) WITHOUT ROWID;
-- An erase looks conversations up by ref.
CREATE INDEX core_assistant_conversation_refs_ref_idx
  ON core_assistant_conversation_refs (ref);

-- Conversations started before this migration: index the record and selection their context
-- names now. Their messages are indexed by their next turn (the object sends its whole history's
-- refs once).
INSERT OR IGNORE INTO core_assistant_conversation_refs (conversation_id, ref)
SELECT c.id, t.value
FROM core_assistant_conversation c, json_tree(c.context) t
WHERE c.context IS NOT NULL
  AND t.type = 'text'
  AND (t.value GLOB 'per_*' OR t.value GLOB 'org_*');

UPDATE core_meta SET value = '270' WHERE key = 'schema_version';
