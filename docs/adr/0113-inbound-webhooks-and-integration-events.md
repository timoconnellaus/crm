# ADR 0113: Inbound webhooks and integration events

Status: accepted, 2026-11-05 (stage 6a build). Stage 5 turns these events into automation triggers.

## Decision
- **`gatekeeper-webhook`** (ours, on `gatekeeper-kit`) is an auto-provisioned gatekeeper. An admin
  creates an org connection, then binds endpoints (`webhook://endpoint/<id>`) through the resource
  picker. The signing secret is set only through the configurator `ui` capability (UI-only, never an
  agent session): generated when not given, shown once.
- `POST /gatekeeper/webhook/in/<id>` verifies the signature in constant time for four schemes
  (generic HMAC-SHA256 with optional timestamp, GitHub, Stripe, Slack, with a 5-minute tolerance).
  A missing, bad or stale signature is answered 401 and nothing is stored or delivered. Verified
  deliveries are shaped into typed events (`{id, endpointId, scheme, type, receivedAt, payload,
  headers}`, with a safe header allowlist), deduplicated by delivery id, and delivered through the
  endpoint's hook with retries.
- Binding an endpoint makes the integration host subscribe a **system hook** whose callback records
  each event in **`core_integration_event`** (source `webhook`, typed, deduplicated by
  `<endpoint>:<delivery id>`). Sync events (ADR 0112) share the table with source `sync`.
- `integrationEvent.list` lists them (filter by source, type, connection; keyset pages). Events are
  kept 90 days (daily cron, `purgeIntegrationEvents`). `consumed_at` is for stage 5.

## Consequences
- Stage 5 reads unconsumed events by index and marks them consumed; until then events only
  accumulate for 90 days.
- Endpoint ids are global to the deployment; whoever can configure the webhook connection can
  reconfigure any endpoint (admins only, through Settings → Integrations).
