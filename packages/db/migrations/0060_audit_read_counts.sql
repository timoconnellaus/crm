-- Migration 0060: hourly read counts instead of one audit row per non-human read (ADR 0055,
-- docs/research/cloudflare-cost-audit.md finding F6, decision D3).
--
-- Before this, every successful read by an MCP client, extension, automation or the assistant
-- wrote a core_audit row: about 6 rows written (5 indexes) and ~1 KB stored per read. Successful
-- non-human reads are now counted here instead, one row per hour, actor, user, caller and
-- operation, upserted. Writes, refusals and failed reads still write full core_audit rows.
-- Human reads are still not recorded at all.
--
-- Rows hold ids and counts only (no inputs), so an erase (ADR 0019) has nothing to redact here.
-- They are not append-only: an upsert has to update the count. The audit retention purge
-- (migration 0061) deletes hours older than the retention window.
CREATE TABLE core_audit_read_counts (
  -- The UTC hour, 'YYYY-MM-DDTHH:00:00.000Z'.
  hour TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('human', 'assistant', 'mcp', 'automation', 'extension')),
  user_id TEXT NOT NULL,
  -- Who exactly, within the actor: the connected app (cap_…) for MCP, the extension id, the
  -- automation id, else the MCP client id, else ''.
  caller TEXT NOT NULL DEFAULT '',
  operation TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  -- How many of them saw the session's simulated pending changes (ADR 0032).
  simulated INTEGER NOT NULL DEFAULT 0,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  PRIMARY KEY (hour, actor, user_id, caller, operation)
) WITHOUT ROWID;
CREATE INDEX core_audit_read_counts_user_idx ON core_audit_read_counts (user_id, hour);

UPDATE core_meta SET value = '60' WHERE key = 'schema_version';
