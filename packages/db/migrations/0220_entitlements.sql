-- Stage 10 (SaaS): plan entitlements (ADR 0211).
--
-- One row, key 'plan', written only by the hosted control plane through the D1 REST API. Its value
-- is JSON { plan, maxUsers, maxRecords, platformAi, updatedAt }. No row (a self-hosted install)
-- means no limits at all. Nothing in the deployment writes this table: no operation, no UI and no
-- AI path (identity and policy are not AI-configurable).
CREATE TABLE core_entitlements (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;

UPDATE core_meta SET value = '220' WHERE key = 'schema_version';
