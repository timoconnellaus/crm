-- Migration 0111: email and calendar sync (stage 6a, ADR 0052, ADR 0112).
--
-- Synced mail and meetings become `email` and `meeting` activities. Cost audit U1/U2:
--   * dedupe across mailboxes uses an indexed key (`external_key`: 'email:<Message-ID>' or
--     'ical:<UID>'), never a scan of payload JSON;
--   * full bodies live in R2 (`body_ref`); D1 and the search index get a short snippet only;
--   * "emailed at least twice" is a counter table, not a scan.
-- Restricted reads (a gatekeeper observation with containsRestrictedData) are never written:
-- the sync service drops them before anything here is touched.

ALTER TABLE core_activity ADD COLUMN external_key TEXT;
CREATE UNIQUE INDEX core_activity_external_key_idx ON core_activity (external_key)
  WHERE external_key IS NOT NULL;
-- The conversation an email belongs to: 'thread:<root Message-ID>' (References / In-Reply-To).
ALTER TABLE core_activity ADD COLUMN thread_key TEXT;
CREATE INDEX core_activity_thread_idx ON core_activity (thread_key, occurred_at)
  WHERE thread_key IS NOT NULL;
-- Set when the activity was marked private: only this user sees it (activity.setPrivate).
ALTER TABLE core_activity ADD COLUMN private_to TEXT;
-- The R2 key of the full email body, when its mailbox shares full content.
ALTER TABLE core_activity ADD COLUMN body_ref TEXT;
-- What the activity discloses: 'full' or 'metadata' (synced activities only).
ALTER TABLE core_activity ADD COLUMN disclosure TEXT
  CHECK (disclosure IS NULL OR disclosure IN ('full', 'metadata'));

-- Private activities stay out of SQL views and search; their owner still sees them on timelines.
DROP VIEW crm_activities;
DROP VIEW core_base_activities;
CREATE VIEW core_base_activities AS
SELECT
  activity.id,
  activity.type,
  activity.subject,
  activity.body,
  activity.payload,
  activity.occurred_at,
  activity.author_user_id,
  activity.author_actor,
  activity.created_at,
  activity.updated_at
FROM core_activity activity
WHERE activity.deleted_at IS NULL AND activity.private_to IS NULL;
CREATE VIEW crm_activities AS SELECT b.* FROM core_base_activities b;

DROP VIEW crm_activity_links;
CREATE VIEW crm_activity_links AS
SELECT l.activity_id, l.object_type, l.record_id
FROM core_activity_links l
JOIN core_activity a ON a.id = l.activity_id AND a.deleted_at IS NULL AND a.private_to IS NULL;

DROP TRIGGER core_activity_search_ai;
CREATE TRIGGER core_activity_search_ai AFTER INSERT ON core_activity
BEGIN
  DELETE FROM core_search_docs WHERE object_type = 'activity' AND record_id = NEW.id;
  INSERT INTO core_search_docs (object_type, record_id, title, body)
  SELECT 'activity', a.id, coalesce(a.subject, ''), coalesce(a.body, '')
  FROM core_activity a WHERE a.id = NEW.id AND a.deleted_at IS NULL AND a.private_to IS NULL;
END;

DROP TRIGGER core_activity_search_au;
CREATE TRIGGER core_activity_search_au AFTER UPDATE OF subject, body, deleted_at, private_to
  ON core_activity
BEGIN
  DELETE FROM core_search_docs WHERE object_type = 'activity' AND record_id = NEW.id;
  INSERT INTO core_search_docs (object_type, record_id, title, body)
  SELECT 'activity', a.id, coalesce(a.subject, ''), coalesce(a.body, '')
  FROM core_activity a WHERE a.id = NEW.id AND a.deleted_at IS NULL AND a.private_to IS NULL;
END;

-- One row per message or event seen in one mailbox or calendar: which activity it became (null
-- when nothing was written: no known person or organisation). Deletes propagate when the last
-- mailbox holding a key drops it.
CREATE TABLE core_sync_item (
  connection_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  external_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('email', 'meeting')),
  activity_id TEXT,
  -- When the message was sent or the event starts: delete reconciliation lists a time window
  -- from the provider and compares it with these rows (ADR 0112).
  occurred_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, provider_id)
);
CREATE INDEX core_sync_item_key_idx ON core_sync_item (external_key);
CREATE INDEX core_sync_item_window_idx ON core_sync_item (connection_id, kind, occurred_at)
  WHERE activity_id IS NOT NULL;

-- Suggested contacts (ADR 0052): external addresses the org has exchanged mail with that match
-- no person. Counted once per distinct message. Shown from `message_count >= 2`, grouped by
-- domain. Nothing is created automatically.
CREATE TABLE core_suggested_contact (
  email TEXT PRIMARY KEY NOT NULL,
  domain TEXT NOT NULL,
  name TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'added', 'dismissed')),
  person_id TEXT,
  decided_by TEXT,
  decided_at TEXT
);
CREATE INDEX core_suggested_contact_open_idx
  ON core_suggested_contact (status, domain, message_count);

-- Job-change signals from mail (ADR 0052 amendment): a bounce from a known address, a new
-- signature, or a new domain for a known person. Confirming applies person.changeJob.
CREATE TABLE core_job_change_suggestion (
  id TEXT PRIMARY KEY NOT NULL,
  person_id TEXT NOT NULL,
  signal TEXT NOT NULL CHECK (signal IN ('bounce', 'signature', 'domain')),
  -- One open suggestion per person and evidence (e.g. 'bounce:ada@old.example').
  dedupe_key TEXT NOT NULL,
  evidence TEXT NOT NULL CHECK (json_valid(evidence)),
  -- What confirming would do: { organisationId?, organisationName?, domain?, title?, endOnly }.
  proposal TEXT NOT NULL CHECK (json_valid(proposal)),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'applied', 'dismissed')),
  created_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT
);
CREATE UNIQUE INDEX core_job_change_suggestion_dedupe_idx
  ON core_job_change_suggestion (person_id, dedupe_key);
CREATE INDEX core_job_change_suggestion_status_idx
  ON core_job_change_suggestion (status, created_at);

-- Job-change "new domain" signals look people up by name.
CREATE INDEX core_person_display_name_lower_idx ON core_person (lower(display_name))
  WHERE deleted_at IS NULL;

-- The last signature seen from each known person, to notice a new one.
CREATE TABLE core_person_signature (
  person_id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL,
  signature_hash TEXT NOT NULL,
  company TEXT,
  title TEXT,
  seen_at TEXT NOT NULL
);

UPDATE core_meta SET value = '111' WHERE key = 'schema_version';
