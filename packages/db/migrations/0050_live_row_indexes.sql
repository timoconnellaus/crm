-- Migration 0050: partial Trash indexes, so list pages stop scanning every live row
-- (docs/research/cloudflare-cost-audit.md).
--
-- The 0003/0004 indexes on deleted_at covered every row. D1 databases carry no ANALYZE statistics,
-- so the planner took `deleted_at IS NULL` (true for nearly every row) as selective. It walked
-- the whole table through that index, computed the crm_* views' correlated subqueries for every
-- row, then sorted. The display-name, name and occurred-at indexes went unused, and so did the
-- primary key for `id IN (...)` lookups.
--
-- A default 50-row person.list on 20k people read about 82k rows. search.global's hydration
-- read about 20k rows per query.
--
-- Trash queries always say `deleted_at IS NOT NULL` or `deleted_at < ?`, so partial indexes still
-- serve them, and the planner can no longer pick them for live-row reads.

DROP INDEX core_person_deleted_idx;
CREATE INDEX core_person_deleted_idx ON core_person (deleted_at) WHERE deleted_at IS NOT NULL;

DROP INDEX core_organisation_deleted_idx;
CREATE INDEX core_organisation_deleted_idx ON core_organisation (deleted_at)
  WHERE deleted_at IS NOT NULL;

DROP INDEX core_activity_deleted_idx;
CREATE INDEX core_activity_deleted_idx ON core_activity (deleted_at) WHERE deleted_at IS NOT NULL;

DROP INDEX core_task_deleted_idx;
CREATE INDEX core_task_deleted_idx ON core_task (deleted_at) WHERE deleted_at IS NOT NULL;

-- task.list's default order (due date, then id) had no index, so every page sorted all tasks.
CREATE INDEX core_task_due_at_idx ON core_task (due_at, id);

UPDATE core_meta SET value = '50' WHERE key = 'schema_version';
