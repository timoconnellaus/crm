-- Migration 0131: the in-app notification centre (stage 5, ADR 0029, ADR 0132).
--
-- One row per notification per user. Typed (`type`, see NOTIFICATION_TYPES in @crm/core) so stage
-- 6b can route types to email or Slack. Kept 90 days (the daily maintenance cron).
CREATE TABLE core_notifications (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  -- JSON NotificationLink: record, approval, automationRun or automation.
  link TEXT,
  -- JSON: { actor, automationId?, runId?, userId? }
  source TEXT NOT NULL DEFAULT '{}',
  -- Optional: one notification per (user, key), e.g. one per change set waiting for approval.
  dedupe_key TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL
);
-- The inbox, newest first.
CREATE INDEX core_notifications_user_idx ON core_notifications (user_id, created_at);
-- The bell's unread count.
CREATE INDEX core_notifications_unread_idx ON core_notifications (user_id) WHERE read_at IS NULL;
CREATE UNIQUE INDEX core_notifications_dedupe_idx
  ON core_notifications (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
-- Retention.
CREATE INDEX core_notifications_created_idx ON core_notifications (created_at);

UPDATE core_meta SET value = '131' WHERE key = 'schema_version';
