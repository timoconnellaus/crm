-- Stage 6a: delete reconciliation (ADR 0112). When the message was sent or the event starts:
-- after each caught-up pass the host lists one time window from the provider and deletes what
-- was synced there but is no longer listed, comparing against these rows.
ALTER TABLE core_sync_item ADD COLUMN occurred_at TEXT;
CREATE INDEX core_sync_item_window_idx ON core_sync_item (connection_id, kind, occurred_at)
  WHERE activity_id IS NOT NULL;

UPDATE core_meta SET value = '112' WHERE key = 'schema_version';
