-- Hosted AI (ADR 0213 amendment): model usage counted in the workspace itself.
--
-- On a hosted deployment the customer's own keys are called directly at the provider, not through
-- any gateway we can read, so the deployment counts every model call here: requests and tokens per
-- day, role and provider, and whether the call was Platform AI (billed to the plan) or the
-- customer's own key (never billed). Settings → AI shows it. Never a prompt, a reply or a key.
-- Self-hosted deployments read usage from their own AI Gateway instead (ADR 0152) and leave this
-- table empty.
CREATE TABLE core_ai_usage (
  day TEXT NOT NULL,
  role TEXT NOT NULL,
  provider TEXT NOT NULL,
  billed INTEGER NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, role, provider)
) WITHOUT ROWID;

UPDATE core_meta SET value = '260' WHERE key = 'schema_version';
