-- Migration 0352: assistant memory (stage 17 W3, ADR 0342).
--
-- What each person's assistant remembers, and what the team's assistants share. Lines are saved
-- inline from the chat (`memory.propose`, checked by the judge's `memory.write` placement), shown
-- and edited on "What your assistant remembers", and read by the person's thread and by the agents
-- it starts. Customer facts never go here: they go on the record as a note.
--
-- kind:
--   personal     a preference or fact about the person ("I prefer calls before 10")
--   shortcut     what the person means by a phrase ("the pipeline" = my open deals over $5k)
--   style        a line of the writing-style section ("No exclamation marks in emails")
--   conditional  a line that holds only on records matching `condition` ({ object, filter }, the
--                filter shape views use), included only when the record in context matches
--   team         a line every assistant in the workspace reads (user_id is null)
--
-- status:
--   active       read by the assistant
--   proposed     waiting: for the person to confirm a read-back (a conditional line, or any line
--                while the judge is off), or for a permitted person to approve a team line
--   paused       kept, but not read
--
-- `active_since` is when the line last became what the assistant reads (saved, confirmed,
-- approved, resumed or edited). The thread compares it with its last fold: lines active since then
-- ride in the context's tail as pending lines until compaction folds them into the memory block,
-- so the cached prefix stays byte-stable (ADR 0341, ADR 0342).
CREATE TABLE core_memory (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT REFERENCES core_user (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('personal', 'shortcut', 'style', 'conditional', 'team')),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 1000),
  condition TEXT CHECK (condition IS NULL OR json_valid(condition)),
  -- The condition in words, composed by code from the field registry ("Organisation: Employees
  -- is more than 500"), for the read-back and the memory page.
  condition_label TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'proposed', 'paused')),
  -- The person's message the line came from: deleting that message deletes the line.
  source_thread_id TEXT,
  source_message_seq INTEGER,
  -- What checked it before it was saved (JSON: the judge's labels and probabilities, or the
  -- deterministic checks when the judge was off). Never shown as the judge's own words.
  checked TEXT CHECK (checked IS NULL OR json_valid(checked)),
  author_id TEXT REFERENCES core_user (id) ON DELETE SET NULL,
  -- Team lines: every change, oldest first ([{ at, by, action, text }]).
  history TEXT CHECK (history IS NULL OR json_valid(history)),
  active_since TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((kind = 'team') = (user_id IS NULL)),
  CHECK ((kind = 'conditional') = (condition IS NOT NULL))
);
CREATE INDEX core_memory_user_idx ON core_memory (user_id, kind);
CREATE INDEX core_memory_team_idx ON core_memory (kind, status) WHERE kind = 'team';
CREATE INDEX core_memory_source_idx ON core_memory (source_thread_id, source_message_seq)
  WHERE source_thread_id IS NOT NULL;

-- Which people and organisations (`per_…`, `org_…`) and email addresses (`email:<sha256>`) a
-- line names, so an erase finds the lines to remove (ADR 0320, ADR 0342).
CREATE TABLE core_memory_refs (
  memory_id TEXT NOT NULL REFERENCES core_memory (id) ON DELETE CASCADE,
  ref TEXT NOT NULL,
  PRIMARY KEY (memory_id, ref)
) WITHOUT ROWID;
CREATE INDEX core_memory_refs_ref_idx ON core_memory_refs (ref);

-- Per person: memory on or paused (on by default: no row).
CREATE TABLE core_memory_settings (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES core_user (id) ON DELETE CASCADE,
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  updated_at TEXT NOT NULL
);

UPDATE core_meta SET value = '352' WHERE key = 'schema_version';
