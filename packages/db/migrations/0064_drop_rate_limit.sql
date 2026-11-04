-- Migration 0064: MCP rate limits moved to the Workers Rate Limiting binding (ADR 0091, cost
-- audit F7, decision D4). Nothing writes the per-request D1 counter any more, so it is dropped.
DROP INDEX core_rate_limit_window_idx;
DROP TABLE core_rate_limit;

UPDATE core_meta SET value = '64' WHERE key = 'schema_version';
