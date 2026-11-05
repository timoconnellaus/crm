-- Migration 0172: notification delivery (stage 6b, ADR 0029, ADR 0132, ADR 0172).
--
-- In-app notifications (core_notifications) are unchanged. People choose, per notification type,
-- whether it also goes to them by email or Slack DM, and whether they get a daily digest. Admins
-- choose the org connections email and Slack go out through, the escalation delay for unread
-- approvals, and channel routes (deal won → #sales). crm-runner's minute cron delivers.

-- One row per person who changed a default. `channels`: JSON { "<type>": ["email", "slack"] }.
CREATE TABLE core_notification_preference (
  user_id TEXT PRIMARY KEY NOT NULL,
  channels TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(channels)),
  digest INTEGER NOT NULL DEFAULT 0 CHECK (digest IN (0, 1)),
  updated_at TEXT NOT NULL
) WITHOUT ROWID;
-- The digest job reads the people who asked for it.
CREATE INDEX core_notification_preference_digest_idx
  ON core_notification_preference (user_id) WHERE digest = 1;

-- Every external delivery attempt, keyed so a repeated cron tick or a redelivered event never
-- sends twice: `n:<notificationId>:<channel>`, `esc:<notificationId>:<channel>`,
-- `digest:<date>:<userId>`, `route:<eventId>:<routeId>:<recordId>`.
CREATE TABLE core_notification_delivery (
  key TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('notification', 'escalation', 'digest', 'route')),
  channel TEXT NOT NULL CHECK (channel IN ('email', 'slack')),
  user_id TEXT,
  -- sending: claimed; sent: applied; pending: waiting for approval as an outbound action;
  -- failed / skipped: not delivered (detail says why).
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'pending', 'failed', 'skipped')),
  detail TEXT,
  created_at TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX core_notification_delivery_created_idx ON core_notification_delivery (created_at);

-- Admin settings: where email and Slack go out, escalation and the digest hour.
INSERT OR IGNORE INTO core_settings (key, value, updated_at)
VALUES (
  'notification_delivery',
  '{"email":null,"slack":null,"escalationMinutes":30,"escalationChannels":["email"],"digestHour":8}',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
-- Admin channel routes: [{ id, label, object, event, channel, enabled }].
INSERT OR IGNORE INTO core_settings (key, value, updated_at)
VALUES ('notification_routes', '[]', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

UPDATE core_meta SET value = '172' WHERE key = 'schema_version';
