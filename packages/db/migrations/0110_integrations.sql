-- Migration 0110: integrations (stage 6a, ADRs 0050, 0051, 0110, 0111).
--
-- The integration host (one Durable Object per connection in crm-runner) is the authority for
-- gatekeeper accounts, facets and hooks: those are RPC stubs that only DO storage can hold. The
-- tables below mirror connection state for the UI and record what the CRM itself decides:
-- which gatekeepers an admin enabled, which outbound action kinds may auto-apply, the outbound
-- items mirrored into the approval queue, and inbound events (webhooks, sync) for stage 5.

-- Gatekeepers an admin enabled for this deployment. A vendor with no row is disabled.
CREATE TABLE core_integration_vendor (
  vendor TEXT PRIMARY KEY NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  -- Auto-provisioned singletons (web search): 'off' | 'optional' (each user turns it on for
  -- their own actors) | 'on' (one org connection everyone's actors use). Null otherwise.
  mode TEXT CHECK (mode IS NULL OR mode IN ('off', 'optional', 'on')),
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

-- A connected gatekeeper account. Personal connections are used only by their owner's actors;
-- org connections are created by admins and used by everyone's. The host DO named by `id` holds
-- the account, facets and hooks; this row is the UI's mirror.
CREATE TABLE core_integration_connection (
  id TEXT PRIMARY KEY NOT NULL,
  vendor TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'org')),
  owner_user_id TEXT NOT NULL REFERENCES core_user (id),
  title TEXT NOT NULL,
  -- What the provider calls the account (a mailbox address, a workspace name).
  account_label TEXT,
  -- How synced mail and meetings are disclosed to the CRM (ADR 0052): full | metadata | none.
  sharing_level TEXT NOT NULL DEFAULT 'metadata'
    CHECK (sharing_level IN ('full', 'metadata', 'none')),
  status TEXT NOT NULL DEFAULT 'connecting'
    CHECK (status IN ('connecting', 'active', 'expired', 'error', 'disconnected')),
  error TEXT,
  -- JSON `[{ key, url, pattern, title, tsType, bindingName, hookTsType }]`: bound resources.
  resources TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(resources)),
  -- JSON: what sync does on this connection and how far it got (for the UI).
  sync TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(sync)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  connected_at TEXT,
  disconnected_at TEXT,
  last_sync_at TEXT
);
CREATE INDEX core_integration_connection_owner_idx
  ON core_integration_connection (owner_user_id, status);
CREATE INDEX core_integration_connection_scope_idx ON core_integration_connection (scope, status);
CREATE INDEX core_integration_connection_vendor_idx
  ON core_integration_connection (vendor, status);

-- Outbound action kinds (ADR 0051) the CRM has seen, and whether an admin let them auto-apply.
-- Only kinds the gatekeeper marks `autoApprovable` can be enabled; enabling is human-admin-only
-- and audited (outbound.setAutoApprove).
CREATE TABLE core_outbound_kind (
  tag TEXT PRIMARY KEY NOT NULL,
  vendor TEXT NOT NULL,
  label TEXT NOT NULL,
  auto_approvable INTEGER NOT NULL DEFAULT 0 CHECK (auto_approvable IN (0, 1)),
  auto_approve INTEGER NOT NULL DEFAULT 0 CHECK (auto_approve IN (0, 1)),
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  CHECK (auto_approve = 0 OR auto_approvable = 1)
);

-- Gatekeeper actions mirrored into the approval queue as `outbound` items (ADR 0051). The
-- gatekeeper journals the action; approval calls `applyAction(gk_action)` on the facet
-- `facet_key` of the host for `connection_id`, in gk_action order per facet.
ALTER TABLE core_pending_action ADD COLUMN connection_id TEXT;
ALTER TABLE core_pending_action ADD COLUMN facet_key TEXT;
ALTER TABLE core_pending_action ADD COLUMN gk_action INTEGER;
ALTER TABLE core_pending_action ADD COLUMN action_kind TEXT;
CREATE UNIQUE INDEX core_pending_action_outbound_idx
  ON core_pending_action (connection_id, facet_key, gk_action)
  WHERE connection_id IS NOT NULL;

-- Inbound events for stage 5 automations: verified webhook deliveries and sync events (an email
-- received from a customer, a meeting updated). Payloads hold ids and typed fields, never content
-- from a restricted read.
CREATE TABLE core_integration_event (
  id TEXT PRIMARY KEY NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('webhook', 'sync')),
  connection_id TEXT,
  type TEXT NOT NULL,
  -- The provider's delivery id (webhooks), for dedupe.
  external_id TEXT,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- Set by stage 5 once an automation trigger has taken the event.
  consumed_at TEXT
);
CREATE UNIQUE INDEX core_integration_event_dedupe_idx
  ON core_integration_event (source, connection_id, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX core_integration_event_type_idx ON core_integration_event (source, type, id);
CREATE INDEX core_integration_event_unconsumed_idx ON core_integration_event (id)
  WHERE consumed_at IS NULL;
CREATE INDEX core_integration_event_created_idx ON core_integration_event (created_at);

UPDATE core_meta SET value = '110' WHERE key = 'schema_version';
