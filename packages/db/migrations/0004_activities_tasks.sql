-- Migration 0004: Activities and Tasks, linked to records polymorphically (ADR 0015).
--
-- Links are (object_type, record_id) pairs, not foreign keys, so extension objects can be linked
-- later. object_type is the object's registry name: 'person', 'organisation', 'task', or an
-- extension object's name.

CREATE TABLE core_activity (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('note', 'email', 'call', 'meeting', 'system')),
  -- Short headline: an email subject, meeting title, or a system event summary.
  subject TEXT,
  -- Plain-text or Markdown body (notes, email text, call notes). Indexed for search.
  body TEXT,
  -- Typed per `type` (validated by the operation layer), e.g. email headers, call duration,
  -- or a system event's field changes.
  payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
  occurred_at TEXT NOT NULL,
  -- The user the activity is attributed to (null for automation or system events).
  author_user_id TEXT REFERENCES core_user (id) ON DELETE SET NULL,
  -- Who caused it: human | assistant | mcp | automation | system.
  author_actor TEXT NOT NULL DEFAULT 'human'
    CHECK (author_actor IN ('human', 'assistant', 'mcp', 'automation', 'system')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT REFERENCES core_user (id) ON DELETE SET NULL
);
CREATE INDEX core_activity_occurred_idx ON core_activity (occurred_at, id);
CREATE INDEX core_activity_type_idx ON core_activity (type);
CREATE INDEX core_activity_deleted_idx ON core_activity (deleted_at);

CREATE TABLE core_activity_links (
  activity_id TEXT NOT NULL REFERENCES core_activity (id) ON DELETE CASCADE,
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  PRIMARY KEY (activity_id, object_type, record_id)
);
CREATE INDEX core_activity_links_record_idx ON core_activity_links (object_type, record_id, activity_id);

CREATE TABLE core_task (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL CHECK (title <> ''),
  notes TEXT,
  -- A date (`YYYY-MM-DD`) or an ISO timestamp.
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  completed_at TEXT,
  completed_by TEXT REFERENCES core_user (id) ON DELETE SET NULL,
  assignee_id TEXT REFERENCES core_user (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  created_by TEXT REFERENCES core_user (id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT REFERENCES core_user (id) ON DELETE SET NULL
);
CREATE INDEX core_task_assignee_idx ON core_task (assignee_id, status, due_at);
CREATE INDEX core_task_due_idx ON core_task (status, due_at);
CREATE INDEX core_task_deleted_idx ON core_task (deleted_at);

CREATE TABLE core_task_links (
  task_id TEXT NOT NULL REFERENCES core_task (id) ON DELETE CASCADE,
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  PRIMARY KEY (task_id, object_type, record_id)
);
CREATE INDEX core_task_links_record_idx ON core_task_links (object_type, record_id, task_id);

-- Hard-deleting a record (purge or erase) removes links that point at it. The activities and
-- tasks themselves stay; the purge decides what to do with ones left unlinked.
CREATE TRIGGER core_person_purge_links AFTER DELETE ON core_person
BEGIN
  DELETE FROM core_activity_links WHERE object_type = 'person' AND record_id = OLD.id;
  DELETE FROM core_task_links WHERE object_type = 'person' AND record_id = OLD.id;
END;

CREATE TRIGGER core_organisation_purge_links AFTER DELETE ON core_organisation
BEGIN
  DELETE FROM core_activity_links WHERE object_type = 'organisation' AND record_id = OLD.id;
  DELETE FROM core_task_links WHERE object_type = 'organisation' AND record_id = OLD.id;
END;

CREATE TRIGGER core_task_purge_links AFTER DELETE ON core_task
BEGIN
  DELETE FROM core_activity_links WHERE object_type = 'task' AND record_id = OLD.id;
  DELETE FROM core_record_tags WHERE object_type = 'task' AND record_id = OLD.id;
END;

UPDATE core_meta SET value = '4' WHERE key = 'schema_version';
