-- Migration 0002: CRM roles on users, and org settings (ADR 0015, ADR 0011, ADR 0018).
--
-- Roles live on core_user, the table Better Auth already owns. Better Auth is not told about the
-- column, so its sign-up endpoints can never set it; the DEFAULT applies. The first user of a
-- deployment becomes admin through a trigger, which works for every identity adapter (Better Auth
-- sign-up, or a Cloudflare Access user provisioned on first request).

ALTER TABLE core_user ADD COLUMN role TEXT NOT NULL DEFAULT 'member'
  CHECK (role IN ('admin', 'member', 'viewer'));

CREATE TRIGGER core_user_first_admin
AFTER INSERT ON core_user
WHEN (SELECT COUNT(*) FROM core_user) = 1
BEGIN
  UPDATE core_user SET role = 'admin' WHERE id = NEW.id;
END;

-- Users who already exist when this migration runs: the earliest becomes admin.
UPDATE core_user SET role = 'admin'
WHERE id = (SELECT id FROM core_user ORDER BY created_at, id LIMIT 1);

-- Org-wide settings, one JSON value per key. Changed only through operations (e.g. policy.update),
-- which audit every change.
CREATE TABLE core_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL CHECK (json_valid(value)),
  updated_at TEXT NOT NULL,
  updated_by TEXT REFERENCES core_user (id) ON DELETE SET NULL
);

INSERT INTO core_settings (key, value, updated_at)
VALUES ('approval_policy', '{"preset":"balanced"}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

UPDATE core_meta SET value = '2' WHERE key = 'schema_version';
