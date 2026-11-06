-- Migration 0375: plugins (stage 17 W7, ADR 0347).
--
-- An install is a copy in the owning scope, stamped with the fingerprint of the version it came
-- from. `manifest` keeps that version whole: it is the base of every later three-way compare.
CREATE TABLE core_plugin_install (
  id TEXT PRIMARY KEY NOT NULL CHECK (id GLOB 'pli_*'),
  plugin_id TEXT NOT NULL,
  name TEXT NOT NULL,
  publisher TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('first_party', 'workspace', 'marketplace')),
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'team', 'role', 'org')),
  -- The person, for a personal copy.
  owner_user_id TEXT,
  -- The role, for scope 'role'.
  role TEXT,
  -- What a team install is called. Its members are in core_plugin_member (stage 14 adds teams).
  team_name TEXT,
  -- Members cannot change it; updates are central.
  locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
  -- A member's copy: the team or role install it came from.
  parent_install_id TEXT,
  version TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  manifest TEXT NOT NULL CHECK (json_valid(manifest)),
  -- The version before the last update, for "Go back".
  previous_manifest TEXT CHECK (previous_manifest IS NULL OR json_valid(previous_manifest)),
  -- JSON [{ from, to }]: what was swapped in to fit this workspace, kept across updates.
  adaptations TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(adaptations)),
  -- 0: "Stop updates".
  following INTEGER NOT NULL DEFAULT 1 CHECK (following IN (0, 1)),
  detached_at TEXT,
  -- A version the person turned down with Keep mine or Go back: no asking again for it.
  skipped_version TEXT,
  installed_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX core_plugin_install_owner_idx ON core_plugin_install (owner_user_id, plugin_id);
CREATE INDEX core_plugin_install_plugin_idx ON core_plugin_install (plugin_id, scope);
CREATE INDEX core_plugin_install_parent_idx ON core_plugin_install (parent_install_id)
  WHERE parent_install_id IS NOT NULL;

-- A team install's members.
CREATE TABLE core_plugin_member (
  install_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (install_id, user_id)
) WITHOUT ROWID;
CREATE INDEX core_plugin_member_user_idx ON core_plugin_member (user_id);

-- The copy's items as they stand now: the base is in the install's manifest. `name` is what the
-- item is called by (a skill, a saved card, an agent profile), for lookups.
CREATE TABLE core_plugin_item (
  install_id TEXT NOT NULL,
  key TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT,
  label TEXT NOT NULL,
  description TEXT,
  body TEXT NOT NULL CHECK (json_valid(body)),
  -- active; waiting (for a connection or an approval); offered (a preset, until the person accepts).
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'waiting', 'offered')),
  state_reason TEXT,
  PRIMARY KEY (install_id, key)
) WITHOUT ROWID;
CREATE INDEX core_plugin_item_lookup_idx ON core_plugin_item (kind, name);

-- What an item became in the workspace: a routine, a view, a dashboard, a memory line. One row per
-- person it was made for (`holder_user_id`, '' for one shared row). `restore` holds what to put
-- back on uninstall, for an item that changed something the person already had.
CREATE TABLE core_plugin_target (
  install_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  holder_user_id TEXT NOT NULL DEFAULT '',
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  restore TEXT,
  PRIMARY KEY (install_id, item_key, holder_user_id, target_id)
) WITHOUT ROWID;
CREATE INDEX core_plugin_target_lookup_idx ON core_plugin_target (target_kind, target_id);

-- The workspace's private registry: plugins made here, and what the assistant proposed in chat
-- (`status` proposed, until a person installs it or it is dropped).
CREATE TABLE core_plugin_registry (
  plugin_id TEXT NOT NULL,
  version TEXT NOT NULL,
  name TEXT NOT NULL,
  manifest TEXT NOT NULL CHECK (json_valid(manifest)),
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'published')),
  -- Where a marketplace submission of this version stands.
  marketplace_status TEXT CHECK (marketplace_status IN ('in_review', 'approved', 'rejected')),
  marketplace_id TEXT,
  marketplace_reason TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (plugin_id, version)
) WITHOUT ROWID;

-- A member's request for a marketplace plugin, when admins approve installs.
CREATE TABLE core_plugin_request (
  id TEXT PRIMARY KEY NOT NULL CHECK (id GLOB 'plr_*'),
  plugin_id TEXT NOT NULL,
  name TEXT NOT NULL,
  publisher TEXT NOT NULL,
  version TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX core_plugin_request_status_idx ON core_plugin_request (status, created_at);

-- An update's merge proposal, until it is applied or turned down. One open row per copy.
CREATE TABLE core_plugin_merge (
  id TEXT PRIMARY KEY NOT NULL CHECK (id GLOB 'plm_*'),
  install_id TEXT NOT NULL,
  version TEXT NOT NULL,
  -- JSON: the new manifest and the merged items.
  proposal TEXT NOT NULL CHECK (json_valid(proposal)),
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'applied', 'kept')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX core_plugin_merge_install_idx ON core_plugin_merge (install_id, status);
