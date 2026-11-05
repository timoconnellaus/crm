-- Migration 0200: the in-app assistant's conversation index (stage 7b, ADR 0030, ADR 0200).
--
-- Each conversation's history, streaming state and turn bookkeeping live in its own Durable
-- Object (AssistantConversation, one per conversation, SQLite storage). D1 keeps only the list a
-- person sees on /assistant: one small row per conversation, written when the conversation starts
-- and once per finished turn (never per token or per tool call). The id (asc_…) is also the
-- assistant's MCP session: its pending actions group by it and only it sees them simulated.
CREATE TABLE core_assistant_conversation (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  -- Where it was started: JSON { path, record?, selection? } of the first turn, for the list.
  context TEXT CHECK (context IS NULL OR json_valid(context)),
  turns INTEGER NOT NULL DEFAULT 0,
  -- The last reply's first line, for the list.
  preview TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
-- /assistant lists a person's conversations, newest first.
CREATE INDEX core_assistant_conversation_user_idx
  ON core_assistant_conversation (user_id, updated_at DESC) WHERE deleted_at IS NULL;

UPDATE core_meta SET value = '200' WHERE key = 'schema_version';
