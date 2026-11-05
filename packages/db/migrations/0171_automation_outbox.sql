-- Migration 0171: the automation events outbox (stage 6b, ADR 0171).
--
-- An operation that changes records writes its automation events here in the same D1 batch as
-- the change itself, then sends them to the queue after commit and deletes the row. A row that is
-- still here (the send failed, or the Worker died before it) is retried by crm-runner's minute
-- cron with backoff. Reads never write here. Runs are idempotent per event id, so a resend after
-- a lost delete starts nothing twice.

CREATE TABLE core_automation_outbox (
  id TEXT PRIMARY KEY NOT NULL,
  -- JSON array of AutomationQueueMessage (one operation's events, at most ~900 KB a row).
  messages TEXT NOT NULL CHECK (json_valid(messages)),
  attempts INTEGER NOT NULL DEFAULT 0,
  -- When the cron may take it: a minute after it was written (the post-commit send goes first),
  -- then with backoff after each failed attempt.
  next_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL
);
-- No secondary index: rows live for milliseconds, so the table is nearly always empty and the
-- cron reads at most one page of it in primary-key (time) order.

UPDATE core_meta SET value = '171' WHERE key = 'schema_version';
