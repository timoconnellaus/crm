-- Migration 0210: the daily digest in the app (stage 7b, ADR 0206, amends ADR 0172).
--
-- The digest now also arrives as an in-app notification (type `digest`), on for everyone unless
-- they turn it off; the email digest keeps its own preference (`digest`, off by default). Its
-- content reads indexes that already exist: core_audit_at_idx and core_audit_changes_audit_idx
-- (changes on my records), core_task_assignee_idx (tasks due) and core_notifications_user_idx.

-- A person's in-app digest preference. Rows written before this keep the default: on.
ALTER TABLE core_notification_preference
  ADD COLUMN digest_in_app INTEGER NOT NULL DEFAULT 1 CHECK (digest_in_app IN (0, 1));

-- The digest pass walks every person (by primary key, at most 50 a tick), not only those with the
-- email digest on, so the partial index on `digest = 1` is never read any more.
DROP INDEX IF EXISTS core_notification_preference_digest_idx;

-- The ledger's channel gains `inApp`: a digest that went to the app only is still claimed under
-- `digest:<date>:<userId>`, so it is written (and its model overview asked for) at most once.
CREATE TABLE core_notification_delivery_new (
  key TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('notification', 'escalation', 'digest', 'route')),
  channel TEXT NOT NULL CHECK (channel IN ('email', 'slack', 'inApp')),
  user_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'pending', 'failed', 'skipped')),
  detail TEXT,
  created_at TEXT NOT NULL
) WITHOUT ROWID;
INSERT INTO core_notification_delivery_new (key, kind, channel, user_id, status, detail, created_at)
SELECT key, kind, channel, user_id, status, detail, created_at FROM core_notification_delivery;
DROP TABLE core_notification_delivery;
ALTER TABLE core_notification_delivery_new RENAME TO core_notification_delivery;
CREATE INDEX core_notification_delivery_created_idx ON core_notification_delivery (created_at);

UPDATE core_meta SET value = '210' WHERE key = 'schema_version';
