-- Migration 0310: assignment rules (stage 15, ADR 0246) and admin-editable select options.
--
-- core_assignment_rule: per object (`person`, `organisation`, or an extension object that
-- declares an owner field), ordered by position; the first enabled rule whose conditions all
-- hold sets the owner of a record created without one. `conditions` is a JSON array of
-- { field, op, value, via? } (via: a relation field, to test the related record's field);
-- `user_ids` a JSON array of user ids: the rotation for round-robin, or the one user.
CREATE TABLE core_assignment_rule (
  id TEXT PRIMARY KEY NOT NULL,
  object_type TEXT NOT NULL,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  conditions TEXT NOT NULL DEFAULT '[]',
  method TEXT NOT NULL CHECK (method IN ('roundRobin', 'user')),
  user_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE INDEX core_assignment_rule_object_idx ON core_assignment_rule (object_type, position);

-- Round-robin state: the rotation index of the next record. A create reads it, picks the owner
-- and advances it in its own batch, guarded by the value it read: a concurrent create makes the
-- guard write -1, the CHECK fails the batch and the pipeline retries the call (ADR 0246).
CREATE TABLE core_assignment_state (
  rule_id TEXT PRIMARY KEY NOT NULL,
  next_index INTEGER NOT NULL DEFAULT 0
    CONSTRAINT core_assignment_state_conflict CHECK (next_index >= 0),
  updated_at TEXT
) WITHOUT ROWID;

-- The owner used when no rule matches, per object. A missing row or a null user: no owner.
CREATE TABLE core_assignment_fallback (
  object_type TEXT PRIMARY KEY NOT NULL,
  user_id TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
) WITHOUT ROWID;

-- Admin-edited options of extension select fields declared with `editableOptions` (ADR 0246
-- amendment): replaces the declared options in the field registry. `options` is a JSON array of
-- { value, label, color? }; options the extension marks `fixed` are always kept.
CREATE TABLE core_field_options (
  object_type TEXT NOT NULL,
  field TEXT NOT NULL,
  options TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (object_type, field)
) WITHOUT ROWID;

UPDATE core_meta SET value = '310' WHERE key = 'schema_version';
