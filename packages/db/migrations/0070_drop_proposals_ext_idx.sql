-- Migration 0070: drop an unused index (docs/research/cloudflare-cost-audit.md, ADR 0043).
--
-- core_extension_proposals is read by action_id (its primary key) for the approval screen. Nothing
-- queries it by (extension_id, created_at), so the index only cost an extra row written per
-- proposal and its storage.

DROP INDEX IF EXISTS core_extension_proposals_ext_idx;

UPDATE core_meta SET value = '70' WHERE key = 'schema_version';
