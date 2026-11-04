-- Migration 0132: indexes for the automation runtime (stage 5, ADR 0130).
--
-- Fan-out budget: runs started from one root event (an import, a cascade), cost audit U3.
CREATE INDEX core_automation_runs_root_idx
  ON core_automation_runs (root_event_id) WHERE root_event_id IS NOT NULL;
-- Every automation's runs, newest first (automation.runs without an automation).
CREATE INDEX core_automation_runs_started_idx ON core_automation_runs (started_at);
-- The latest test-mode report of an automation (automation.get).
CREATE INDEX core_automation_runs_test_idx
  ON core_automation_runs (automation_id, started_at) WHERE test = 1;
-- Retention: counters older than two days.
CREATE INDEX core_automation_counters_hour_idx ON core_automation_counters (hour);

UPDATE core_meta SET value = '132' WHERE key = 'schema_version';
