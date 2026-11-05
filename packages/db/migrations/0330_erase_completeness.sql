-- Migration 0330: erase reaches every store (ADR 0019 amendment 2026-11-05, ADR 0320).
--
-- core_erased_address: the addresses of erased people, so mail and calendar sync does not collect
-- them again. Only `sha256:<hex of the lower-cased, trimmed address>` is stored, never the
-- address. Sync ingest looks a batch's addresses up here (primary key, one query per batch) and
-- drops matches from payloads, links, suggestions and signatures. An admin can remove an entry
-- when the person comes back by consent (`erasure.allowAddress`).
CREATE TABLE core_erased_address (
  hash TEXT PRIMARY KEY NOT NULL CHECK (hash GLOB 'sha256:*'),
  object_type TEXT NOT NULL CHECK (object_type IN ('person', 'organisation')),
  erased_at TEXT NOT NULL,
  erased_by TEXT
) WITHOUT ROWID;

-- core_blob_deletion: R2 objects (synced email bodies) to delete after a commit. A delete in a
-- D1 batch cannot reach R2, so rows are queued here in the same batch and drained right after
-- the commit and by the 10-minute cron, with retries (like core_embedding_queue).
CREATE TABLE core_blob_deletion (
  key TEXT PRIMARY KEY NOT NULL,
  queued_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
) WITHOUT ROWID;
CREATE INDEX core_blob_deletion_due_idx ON core_blob_deletion (attempts, queued_at);

-- Any activity that loses its body reference queues the body for deletion: a hard delete (erase,
-- the Trash purge) or an update that clears or changes `body_ref` (an erase dropping a shared
-- email's body, sync sending a message to Trash).
CREATE TRIGGER core_activity_body_ad AFTER DELETE ON core_activity
WHEN OLD.body_ref IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO core_blob_deletion (key, queued_at)
  VALUES (OLD.body_ref, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER core_activity_body_au AFTER UPDATE OF body_ref ON core_activity
WHEN OLD.body_ref IS NOT NULL AND (NEW.body_ref IS NULL OR NEW.body_ref <> OLD.body_ref)
BEGIN
  INSERT OR IGNORE INTO core_blob_deletion (key, queued_at)
  VALUES (OLD.body_ref, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- Erase lookups by subject, so they are index reads rather than scans.
CREATE INDEX core_suggested_contact_person_idx ON core_suggested_contact (person_id)
  WHERE person_id IS NOT NULL;
CREATE INDEX core_automation_runs_record_idx ON core_automation_runs (record_object, record_id)
  WHERE record_id IS NOT NULL;

UPDATE core_meta SET value = '330' WHERE key = 'schema_version';
