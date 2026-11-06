-- Migration 0350: one assistant thread per user (stage 17 W1, ADR 0340).
--
-- Each person's thread (messages, turns, search index, unread state) lives in their own
-- AssistantAgent Durable Object (`user:<userId>`). D1 keeps one small row per user, written when
-- the thread is first used and once per finished turn (never per token or tool call), and the
-- records each thread referenced, so an erase can find the threads to scrub (ADR 0019, ADR 0320).
-- The id (ath_…) is also the assistant's MCP session: its pending actions group by it.
CREATE TABLE core_assistant_thread (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL UNIQUE,
  turns INTEGER NOT NULL DEFAULT 0,
  -- Replies and deliveries the person has not seen (the badge on the sidebar toggle and nav).
  unread INTEGER NOT NULL DEFAULT 0,
  -- The last reply's first line.
  preview TEXT,
  -- The compaction state (ADR 0341): JSON, written by the thread when it compacts.
  compaction TEXT CHECK (compaction IS NULL OR json_valid(compaction)),
  last_activity_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Which people and organisations (`per_…`, `org_…`) and email addresses (`email:<sha256>`) a
-- thread referenced. The thread sends a turn's refs with its once-per-turn `thread.finishTurn`.
CREATE TABLE core_assistant_thread_refs (
  thread_id TEXT NOT NULL REFERENCES core_assistant_thread (id),
  ref TEXT NOT NULL,
  PRIMARY KEY (thread_id, ref)
) WITHOUT ROWID;
CREATE INDEX core_assistant_thread_refs_ref_idx ON core_assistant_thread_refs (ref);

-- Conversations are gone (ADR 0340): there are no real users yet, so their history is dropped.
-- Their objects are deleted with the AssistantConversation class (wrangler.jsonc). The two tables
-- stay, empty, until a later cleanup migration drops them.
DELETE FROM core_assistant_conversation_refs;
DELETE FROM core_assistant_conversation;

UPDATE core_meta SET value = '350' WHERE key = 'schema_version';
