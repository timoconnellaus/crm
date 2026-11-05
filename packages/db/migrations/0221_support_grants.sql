-- Stage 10 (SaaS): customer-approved, time-limited support access without impersonation
-- (ADR 0212).
--
-- The hosted control plane inserts a grant with status 'requested' (and may set 'revoked'),
-- everything else happens here through support.grant.* operations, so it is in the audit log.
-- Approving creates a support user (core_user.support_grant_id = the grant): its own identity,
-- never a customer's account. Support users never count against the plan's user limit and are
-- not listed in crm_users.
CREATE TABLE core_support_grants (
  id TEXT PRIMARY KEY NOT NULL,
  staff_email TEXT NOT NULL,
  reason TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
  requested_minutes INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('requested', 'approved', 'denied', 'revoked')),
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  expires_at TEXT,
  user_id TEXT
) WITHOUT ROWID;
CREATE INDEX core_support_grants_status_idx ON core_support_grants (status);

ALTER TABLE core_user ADD COLUMN support_grant_id TEXT;

-- Support users are not people of the organisation: keep them out of user lists and pickers.
DROP VIEW crm_users;
CREATE VIEW crm_users AS
SELECT u.id, u.name, u.email, u.role, u.image, u.created_at
FROM core_user u
WHERE u.kind = 'human' AND u.support_grant_id IS NULL;

UPDATE core_meta SET value = '221' WHERE key = 'schema_version';
