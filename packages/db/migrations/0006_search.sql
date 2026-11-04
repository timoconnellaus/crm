-- Migration 0006: full-text search (FTS5) over people, organisations, activities and tasks.
--
-- Two layers:
--   * core_search_docs: one plain row per live record (object_type, record_id, title, body).
--     Domain triggers below rebuild a record's row whenever it or its emails/domains change, and
--     drop it when the record is soft-deleted or purged.
--   * core_search: an external-content FTS5 index over core_search_docs, kept in step by the
--     standard external-content triggers. Query it with
--       SELECT d.object_type, d.record_id FROM core_search s
--       JOIN core_search_docs d ON d.id = s.rowid WHERE core_search MATCH ? ORDER BY rank
--
-- What is indexed: people (display, given and family names; all emails), organisations (name;
-- all domains), activities (subject, body) and tasks (title, notes). unicode61 splits emails and
-- domains on punctuation, so "ada", "example" and "com" are tokens; prefix indexes keep
-- type-ahead queries ("ad*") fast.

CREATE TABLE core_search_docs (
  id INTEGER PRIMARY KEY,
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  UNIQUE (object_type, record_id)
);

CREATE VIRTUAL TABLE core_search USING fts5(
  title,
  body,
  content = 'core_search_docs',
  content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3'
);

CREATE TRIGGER core_search_docs_ai AFTER INSERT ON core_search_docs
BEGIN
  INSERT INTO core_search (rowid, title, body) VALUES (NEW.id, NEW.title, NEW.body);
END;

CREATE TRIGGER core_search_docs_ad AFTER DELETE ON core_search_docs
BEGIN
  INSERT INTO core_search (core_search, rowid, title, body)
  VALUES ('delete', OLD.id, OLD.title, OLD.body);
END;

CREATE TRIGGER core_search_docs_au AFTER UPDATE ON core_search_docs
BEGIN
  INSERT INTO core_search (core_search, rowid, title, body)
  VALUES ('delete', OLD.id, OLD.title, OLD.body);
  INSERT INTO core_search (rowid, title, body) VALUES (NEW.id, NEW.title, NEW.body);
END;

-- person
CREATE TRIGGER core_person_search_ai AFTER INSERT ON core_person
BEGIN
  DELETE FROM core_search_docs WHERE object_type = 'person' AND record_id = NEW.id;
  INSERT INTO core_search_docs (object_type, record_id, title, body)
  SELECT 'person', p.id,
    trim(p.display_name || ' ' || coalesce(p.given_name, '') || ' ' || coalesce(p.family_name, '')),
    coalesce((SELECT group_concat(e.email, ' ') FROM core_person_emails e WHERE e.person_id = p.id), '')
  FROM core_person p WHERE p.id = NEW.id AND p.deleted_at IS NULL;
END;

CREATE TRIGGER core_person_search_au AFTER UPDATE OF display_name, given_name, family_name, deleted_at ON core_person
BEGIN
  DELETE FROM core_search_docs WHERE object_type = 'person' AND record_id = NEW.id;
  INSERT INTO core_search_docs (object_type, record_id, title, body)
  SELECT 'person', p.id,
    trim(p.display_name || ' ' || coalesce(p.given_name, '') || ' ' || coalesce(p.family_name, '')),
    coalesce((SELECT group_concat(e.email, ' ') FROM core_person_emails e WHERE e.person_id = p.id), '')
  FROM core_person p WHERE p.id = NEW.id AND p.deleted_at IS NULL;
END;

CREATE TRIGGER core_person_search_ad AFTER DELETE ON core_person
BEGIN
  DELETE FROM core_search_docs WHERE object_type = 'person' AND record_id = OLD.id;
END;

-- organisation
CREATE TRIGGER core_organisation_search_ai AFTER INSERT ON core_organisation
BEGIN
  DELETE FROM core_search_docs WHERE object_type = 'organisation' AND record_id = NEW.id;
  INSERT INTO core_search_docs (object_type, record_id, title, body)
  SELECT 'organisation', o.id, o.name,
    coalesce((SELECT group_concat(d.domain, ' ') FROM core_organisation_domains d
              WHERE d.organisation_id = o.id), '')
  FROM core_organisation o WHERE o.id = NEW.id AND o.deleted_at IS NULL;
END;

CREATE TRIGGER core_organisation_search_au AFTER UPDATE OF name, deleted_at ON core_organisation
BEGIN
  DELETE FROM core_search_docs WHERE object_type = 'organisation' AND record_id = NEW.id;
  INSERT INTO core_search_docs (object_type, record_id, title, body)
  SELECT 'organisation', o.id, o.name,
    coalesce((SELECT group_concat(d.domain, ' ') FROM core_organisation_domains d
              WHERE d.organisation_id = o.id), '')
  FROM core_organisation o WHERE o.id = NEW.id AND o.deleted_at IS NULL;
END;

CREATE TRIGGER core_organisation_search_ad AFTER DELETE ON core_organisation
BEGIN
  DELETE FROM core_search_docs WHERE object_type = 'organisation' AND record_id = OLD.id;
END;

-- activity
CREATE TRIGGER core_activity_search_ai AFTER INSERT ON core_activity
BEGIN
  DELETE FROM core_search_docs WHERE object_type = 'activity' AND record_id = NEW.id;
  INSERT INTO core_search_docs (object_type, record_id, title, body)
  SELECT 'activity', a.id, coalesce(a.subject, ''), coalesce(a.body, '')
  FROM core_activity a WHERE a.id = NEW.id AND a.deleted_at IS NULL;
END;

CREATE TRIGGER core_activity_search_au AFTER UPDATE OF subject, body, deleted_at ON core_activity
BEGIN
  DELETE FROM core_search_docs WHERE object_type = 'activity' AND record_id = NEW.id;
  INSERT INTO core_search_docs (object_type, record_id, title, body)
  SELECT 'activity', a.id, coalesce(a.subject, ''), coalesce(a.body, '')
  FROM core_activity a WHERE a.id = NEW.id AND a.deleted_at IS NULL;
END;

CREATE TRIGGER core_activity_search_ad AFTER DELETE ON core_activity
BEGIN
  DELETE FROM core_search_docs WHERE object_type = 'activity' AND record_id = OLD.id;
END;

-- task
CREATE TRIGGER core_task_search_ai AFTER INSERT ON core_task
BEGIN
  DELETE FROM core_search_docs WHERE object_type = 'task' AND record_id = NEW.id;
  INSERT INTO core_search_docs (object_type, record_id, title, body)
  SELECT 'task', t.id, t.title, coalesce(t.notes, '')
  FROM core_task t WHERE t.id = NEW.id AND t.deleted_at IS NULL;
END;

CREATE TRIGGER core_task_search_au AFTER UPDATE OF title, notes, deleted_at ON core_task
BEGIN
  DELETE FROM core_search_docs WHERE object_type = 'task' AND record_id = NEW.id;
  INSERT INTO core_search_docs (object_type, record_id, title, body)
  SELECT 'task', t.id, t.title, coalesce(t.notes, '')
  FROM core_task t WHERE t.id = NEW.id AND t.deleted_at IS NULL;
END;

CREATE TRIGGER core_task_search_ad AFTER DELETE ON core_task
BEGIN
  DELETE FROM core_search_docs WHERE object_type = 'task' AND record_id = OLD.id;
END;

-- person child rows
CREATE TRIGGER core_person_emails_search_ai AFTER INSERT ON core_person_emails
BEGIN
  DELETE FROM core_search_docs WHERE object_type = 'person' AND record_id = NEW.person_id;
  INSERT INTO core_search_docs (object_type, record_id, title, body)
  SELECT 'person', p.id,
    trim(p.display_name || ' ' || coalesce(p.given_name, '') || ' ' || coalesce(p.family_name, '')),
    coalesce((SELECT group_concat(e.email, ' ') FROM core_person_emails e WHERE e.person_id = p.id), '')
  FROM core_person p WHERE p.id = NEW.person_id AND p.deleted_at IS NULL;
END;

CREATE TRIGGER core_person_emails_search_au AFTER UPDATE ON core_person_emails
BEGIN
  DELETE FROM core_search_docs WHERE object_type = 'person' AND record_id = OLD.person_id;
  INSERT INTO core_search_docs (object_type, record_id, title, body)
  SELECT 'person', p.id,
    trim(p.display_name || ' ' || coalesce(p.given_name, '') || ' ' || coalesce(p.family_name, '')),
    coalesce((SELECT group_concat(e.email, ' ') FROM core_person_emails e WHERE e.person_id = p.id), '')
  FROM core_person p WHERE p.id = OLD.person_id AND p.deleted_at IS NULL;
  DELETE FROM core_search_docs WHERE object_type = 'person' AND record_id = NEW.person_id;
  INSERT INTO core_search_docs (object_type, record_id, title, body)
  SELECT 'person', p.id,
    trim(p.display_name || ' ' || coalesce(p.given_name, '') || ' ' || coalesce(p.family_name, '')),
    coalesce((SELECT group_concat(e.email, ' ') FROM core_person_emails e WHERE e.person_id = p.id), '')
  FROM core_person p WHERE p.id = NEW.person_id AND p.deleted_at IS NULL;
END;

CREATE TRIGGER core_person_emails_search_ad AFTER DELETE ON core_person_emails
BEGIN
  DELETE FROM core_search_docs WHERE object_type = 'person' AND record_id = OLD.person_id;
  INSERT INTO core_search_docs (object_type, record_id, title, body)
  SELECT 'person', p.id,
    trim(p.display_name || ' ' || coalesce(p.given_name, '') || ' ' || coalesce(p.family_name, '')),
    coalesce((SELECT group_concat(e.email, ' ') FROM core_person_emails e WHERE e.person_id = p.id), '')
  FROM core_person p WHERE p.id = OLD.person_id AND p.deleted_at IS NULL;
END;

-- organisation child rows
CREATE TRIGGER core_organisation_domains_search_ai AFTER INSERT ON core_organisation_domains
BEGIN
  DELETE FROM core_search_docs WHERE object_type = 'organisation' AND record_id = NEW.organisation_id;
  INSERT INTO core_search_docs (object_type, record_id, title, body)
  SELECT 'organisation', o.id, o.name,
    coalesce((SELECT group_concat(d.domain, ' ') FROM core_organisation_domains d
              WHERE d.organisation_id = o.id), '')
  FROM core_organisation o WHERE o.id = NEW.organisation_id AND o.deleted_at IS NULL;
END;

CREATE TRIGGER core_organisation_domains_search_au AFTER UPDATE ON core_organisation_domains
BEGIN
  DELETE FROM core_search_docs WHERE object_type = 'organisation' AND record_id = OLD.organisation_id;
  INSERT INTO core_search_docs (object_type, record_id, title, body)
  SELECT 'organisation', o.id, o.name,
    coalesce((SELECT group_concat(d.domain, ' ') FROM core_organisation_domains d
              WHERE d.organisation_id = o.id), '')
  FROM core_organisation o WHERE o.id = OLD.organisation_id AND o.deleted_at IS NULL;
  DELETE FROM core_search_docs WHERE object_type = 'organisation' AND record_id = NEW.organisation_id;
  INSERT INTO core_search_docs (object_type, record_id, title, body)
  SELECT 'organisation', o.id, o.name,
    coalesce((SELECT group_concat(d.domain, ' ') FROM core_organisation_domains d
              WHERE d.organisation_id = o.id), '')
  FROM core_organisation o WHERE o.id = NEW.organisation_id AND o.deleted_at IS NULL;
END;

CREATE TRIGGER core_organisation_domains_search_ad AFTER DELETE ON core_organisation_domains
BEGIN
  DELETE FROM core_search_docs WHERE object_type = 'organisation' AND record_id = OLD.organisation_id;
  INSERT INTO core_search_docs (object_type, record_id, title, body)
  SELECT 'organisation', o.id, o.name,
    coalesce((SELECT group_concat(d.domain, ' ') FROM core_organisation_domains d
              WHERE d.organisation_id = o.id), '')
  FROM core_organisation o WHERE o.id = OLD.organisation_id AND o.deleted_at IS NULL;
END;

UPDATE core_meta SET value = '6' WHERE key = 'schema_version';
