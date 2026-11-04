-- Migration 0130: automations (stage 5, ADR 0028, ADR 0130).
--
-- core_automations mirrors the `automations` of every installed extension (one row per
-- automation, written by extension.install from the manifest). The queue consumer matches events
-- against enabled rows through core_automations_trigger_idx; the manifest JSON is in `spec`.
CREATE TABLE core_automations (
  -- `<extensionId>.<key>`, e.g. `deals.wonOnboarding`.
  id TEXT PRIMARY KEY NOT NULL,
  extension_id TEXT NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  -- record | fieldChanged | schedule | dateRelative | manual | approvalDecided (6b: webhook, syncEvent)
  trigger_type TEXT NOT NULL,
  -- The trigger's object, when it has one.
  trigger_object TEXT,
  -- The automation's manifest (AutomationManifest JSON).
  spec TEXT NOT NULL,
  -- The extension commit this definition came from.
  commit_oid TEXT,
  -- Enabled by an admin (automation.enable / disable). Shipped automations start enabled.
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  -- Set when a rail auto-paused it (rate limit); cleared by automation.enable.
  paused_reason TEXT,
  paused_at TEXT,
  -- Set when a later version of the extension no longer declares it (kept for run history).
  removed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Matching: enabled, live automations by trigger type and object.
CREATE INDEX core_automations_trigger_idx
  ON core_automations (trigger_type, trigger_object)
  WHERE enabled = 1 AND paused_reason IS NULL AND removed_at IS NULL;
CREATE INDEX core_automations_extension_idx ON core_automations (extension_id);

-- One row per run (and per test run). `workflow_id` is the Workflow instance id, derived from the
-- run's idempotency key (event id + automation id, or automation id + period for schedules and
-- date-relative triggers): its unique index makes a duplicate delivery a no-op.
CREATE TABLE core_automation_runs (
  id TEXT PRIMARY KEY NOT NULL,
  automation_id TEXT NOT NULL,
  extension_id TEXT NOT NULL,
  commit_oid TEXT,
  workflow_id TEXT,
  -- JSON: { type, eventId, period?, manual?, approval?, change? }
  trigger TEXT NOT NULL,
  record_object TEXT,
  record_id TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'running', 'waiting', 'review', 'completed', 'failed', 'cancelled', 'expired',
    'skipped'
  )),
  status_reason TEXT,
  test INTEGER NOT NULL DEFAULT 0 CHECK (test IN (0, 1)),
  depth INTEGER NOT NULL DEFAULT 0,
  root_event_id TEXT,
  -- JSON array of RunStepRecord.
  steps TEXT NOT NULL DEFAULT '[]',
  -- Records written by the run (rate limit: writes per hour).
  writes INTEGER NOT NULL DEFAULT 0,
  -- The change set its pending actions go in (review pause).
  change_set_id TEXT,
  -- When a waiting run resumes (sleep) or gives up (waitForEvent, review expiry).
  wait_until TEXT,
  retry_of TEXT,
  replay_of TEXT,
  -- Test runs: the AutomationTestReport JSON.
  report TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE UNIQUE INDEX core_automation_runs_workflow_idx
  ON core_automation_runs (workflow_id) WHERE workflow_id IS NOT NULL;
-- An automation's runs, newest first (Runs tab, recent runs, rails).
CREATE INDEX core_automation_runs_automation_idx
  ON core_automation_runs (automation_id, started_at);
-- Retention (ADR 0090): the oldest finished runs of a status.
CREATE INDEX core_automation_runs_status_idx ON core_automation_runs (status, started_at);

-- Records a run touched (its trigger record and records it wrote): the per-record Automations
-- section on record pages.
CREATE TABLE core_automation_run_records (
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  -- trigger | create | update | delete
  role TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (object_type, record_id, run_id)
) WITHOUT ROWID;
CREATE INDEX core_automation_run_records_run_idx ON core_automation_run_records (run_id);

-- Per-automation counters per UTC hour (rails: writes per hour; run counts), one upsert per run.
CREATE TABLE core_automation_counters (
  automation_id TEXT NOT NULL,
  -- 'YYYY-MM-DDTHH'
  hour TEXT NOT NULL,
  runs INTEGER NOT NULL DEFAULT 0,
  writes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (automation_id, hour)
) WITHOUT ROWID;

-- Settings: the kill switch (human admins only), the schedule timezone and the debounce window.
INSERT OR IGNORE INTO core_settings (key, value, updated_at)
VALUES ('automations_kill_switch', 'false', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
INSERT OR IGNORE INTO core_settings (key, value, updated_at)
VALUES ('automation_timezone', '"UTC"', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
INSERT OR IGNORE INTO core_settings (key, value, updated_at)
VALUES ('automation_debounce_seconds', '30', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

UPDATE core_meta SET value = '130' WHERE key = 'schema_version';
