-- The hosted plugin marketplace (ADR 0347). Still no customer data: only what a workspace chose to
-- submit for publication, and our review of it.

-- A plugin we have reviewed. `version` is the listed version; its manifest is in
-- cp_marketplace_versions. `owner` is the submitter of the first approved version
-- (`tenant:<id>` or `token:<id>`): only they may publish new versions of this plugin id.
CREATE TABLE cp_marketplace_listings (
  plugin_id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  name TEXT NOT NULL,
  publisher TEXT NOT NULL,
  description TEXT NOT NULL,
  -- The listing as a workspace reads it (`listingOf`), without installs and updatedAt.
  listing TEXT NOT NULL,
  owner TEXT NOT NULL,
  installs INTEGER NOT NULL DEFAULT 0,
  delisted INTEGER NOT NULL DEFAULT 0 CHECK (delisted IN (0, 1)),
  updated_at TEXT NOT NULL
);
CREATE INDEX cp_marketplace_listings_visible ON cp_marketplace_listings (delisted, installs);

-- Every version we approved.
CREATE TABLE cp_marketplace_versions (
  plugin_id TEXT NOT NULL,
  version TEXT NOT NULL,
  manifest TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  PRIMARY KEY (plugin_id, version)
);

CREATE TABLE cp_marketplace_submissions (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  version TEXT NOT NULL,
  manifest TEXT NOT NULL,
  note TEXT,
  -- `tenant:<id>` or `token:<id>`.
  submitted_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_review', 'approved', 'rejected')),
  reason TEXT,
  reviewed_by TEXT,
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);
CREATE INDEX cp_marketplace_submissions_status ON cp_marketplace_submissions (status, created_at);
-- One open submission per submitter and version, so a replayed signed call (ADR 0250) adds nothing.
CREATE UNIQUE INDEX cp_marketplace_submissions_open
  ON cp_marketplace_submissions (plugin_id, version, submitted_by) WHERE status = 'in_review';

-- A self-hosted workspace's marketplace token (sha256 of the token, never the token).
CREATE TABLE cp_marketplace_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
