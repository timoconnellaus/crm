-- The hosted control plane's own database (ADR 0210). It holds accounts, billing state, instance
-- metadata and audit: never customer data. Customer records live only in each customer's own D1.

-- People who sign in to app.relationshiposcrm.com (account owners; staff are listed in STAFF_EMAILS).
CREATE TABLE cp_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_sign_in_at TEXT
);

-- One-time sign-in links (sha256 of the token, never the token).
CREATE TABLE cp_login_tokens (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  next TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE cp_sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX cp_sessions_user ON cp_sessions (user_id);

-- A customer: who pays, on which plan, and how they are deployed.
CREATE TABLE cp_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  plan TEXT NOT NULL CHECK (plan IN ('free', 'team', 'business', 'enterprise')),
  -- Stripe subscription status, or 'none' (Free, nothing to pay).
  billing_status TEXT NOT NULL DEFAULT 'none',
  -- Stripe event time (unix seconds) of the last applied subscription change; older events are ignored.
  billing_event_at INTEGER NOT NULL DEFAULT 0,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  trial_ends_at TEXT,
  -- Prepaid AI credit in micro-dollars (Free plan), shown to customers in dollars.
  ai_credit_micros INTEGER NOT NULL DEFAULT 0,
  -- saas: a user Worker set in our dispatch namespace. dedicated: ordinary Workers in our account
  -- (enterprise). managed: the customer's own Cloudflare account (enterprise, runbook-operated).
  deployment_model TEXT NOT NULL DEFAULT 'saas' CHECK (deployment_model IN ('saas', 'dedicated', 'managed')),
  -- Enterprise contract terms as JSON (SLA, SSO adapter, custom domain, contract reference).
  enterprise TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'deleted')),
  cancelled_at TEXT,
  delete_after TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX cp_accounts_owner ON cp_accounts (owner_user_id);
CREATE UNIQUE INDEX cp_accounts_stripe_customer ON cp_accounts (stripe_customer_id);
CREATE INDEX cp_accounts_delete_after ON cp_accounts (delete_after) WHERE delete_after IS NOT NULL;

-- A customer deployment (one per account).
CREATE TABLE cp_instances (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  hostname TEXT NOT NULL UNIQUE,
  custom_hostname TEXT UNIQUE,
  custom_hostname_status TEXT,
  placement TEXT NOT NULL CHECK (placement IN ('namespace', 'account', 'customer-account')),
  cf_account_id TEXT,
  namespace TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'provisioning', 'active', 'paused', 'suspended', 'failed', 'deleting', 'deleted')),
  suspended_reason TEXT,
  version TEXT,
  cohort TEXT NOT NULL DEFAULT 'general' CHECK (cohort IN ('canary', 'general')),
  -- The Stage 8 DeploymentState (resource ids, names, vars): infrastructure, not customer data.
  state TEXT,
  database_id TEXT,
  -- Deployed script name → cron expressions, run by the dispatch Worker while the tenant is active.
  crons TEXT,
  last_activity_at TEXT,
  paused_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX cp_instances_status ON cp_instances (status);

CREATE TABLE cp_rollouts (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'completed', 'rolled_back', 'cancelled')),
  -- [{ "name": "canary" | "10%" | "all", "percent": n }]
  waves TEXT NOT NULL,
  current_wave INTEGER NOT NULL DEFAULT 0,
  -- Failures tolerated per wave before the rollout pauses.
  max_failures INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX cp_rollouts_status ON cp_rollouts (status);

CREATE TABLE cp_rollout_targets (
  rollout_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  wave INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'rolled_back', 'failed', 'reverted', 'skipped')),
  from_version TEXT,
  bookmark TEXT,
  error TEXT,
  finished_at TEXT,
  PRIMARY KEY (rollout_id, instance_id)
);
CREATE INDEX cp_rollout_targets_wave ON cp_rollout_targets (rollout_id, wave, status);

-- Our mirror of support grants; the customer's deployment holds the authoritative row.
CREATE TABLE cp_support_grants (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  staff_email TEXT NOT NULL,
  reason TEXT NOT NULL,
  role TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  status TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  synced_at TEXT
);
CREATE INDEX cp_support_grants_instance ON cp_support_grants (instance_id, created_at);

CREATE TABLE cp_audit (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('customer', 'staff', 'system', 'stripe')),
  actor TEXT NOT NULL,
  account_id TEXT,
  instance_id TEXT,
  action TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX cp_audit_account ON cp_audit (account_id, at);
CREATE INDEX cp_audit_at ON cp_audit (at);

-- AI spend per instance per UTC day, metered from the instance's AI Gateway (ADR 0213).
CREATE TABLE cp_ai_usage (
  instance_id TEXT NOT NULL,
  day TEXT NOT NULL,
  month TEXT NOT NULL,
  requests INTEGER NOT NULL,
  provider_cost_micros INTEGER NOT NULL,
  billable_cost_micros INTEGER NOT NULL,
  charged_micros INTEGER NOT NULL,
  overage_cents INTEGER NOT NULL DEFAULT 0,
  credit_debit_micros INTEGER NOT NULL DEFAULT 0,
  unpriced INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0,
  meter_identifier TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (instance_id, day)
);
CREATE INDEX cp_ai_usage_month ON cp_ai_usage (instance_id, month);

-- Stripe webhook events already handled (Stripe retries and may send duplicates).
CREATE TABLE cp_stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at TEXT NOT NULL
);

-- Data exports: links to Cloudflare-hosted dumps and a scoped read token, never the data itself.
CREATE TABLE cp_exports (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'ready', 'failed')),
  d1_url TEXT,
  r2_bucket TEXT,
  r2_token_id TEXT,
  requested_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  error TEXT
);
CREATE INDEX cp_exports_instance ON cp_exports (instance_id, created_at);

-- PLATFORM_MODE=fake only: mail that would have been sent (dev, tests, e2e).
CREATE TABLE cp_dev_mail (
  id TEXT PRIMARY KEY,
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX cp_dev_mail_to ON cp_dev_mail (to_address, created_at);
