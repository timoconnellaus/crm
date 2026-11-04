# ADR 0032: MCP sessions, connected apps and approval mechanics

Status: accepted, 2026-11-04 (stage 2 build).

## Context
ADRs 0021 and 0022 decide the MCP surface and the approval queue. Building them raised questions
they leave open:
- The Agents SDK's current MCP handler (`createMcpHandler` from `agents/mcp/server`, on MCP SDK v2
  and the 2026-07-28 protocol) is **stateless**. `McpAgent`, the sessionful Durable Object
  handler, is deprecated and feature-frozen. The stateless protocol has no `Mcp-Session-Id`, yet
  change sets and the simulation overlay are "per MCP session".
- Where revocation, scopes and "last used" live, given that `workers-oauth-provider` keeps
  grants and hashed tokens in KV.
- How simulation can work when handlers queue writes that cannot be read back before commit.

## Decision

**Transport.** `/mcp` uses the stateless `createMcpHandler` with an MCP SDK v2 `McpServer` built
per request, wrapped by `OAuthProvider` (one Worker is both authorization server and resource).
2025-era clients are served by the handler's stateless legacy lane.

**The MCP session is the connected app.** The consent step registers a `core_connected_app` row
(`connectedApp.register`, audited) and puts its id (`cap_…`) in the token props. That id is
`origin.sessionId` for every call: pending actions group by it and only it sees their simulated
state. Two conversations over the same connection share it; connecting again (or another client)
is a new session. Re-authorizing the same client replaces the old row (`revoke_reason =
replaced`), matching the provider's `revokeExistingGrants`.

**The D1 row is the authority.** Every `/mcp` request loads the connection: revoked means `401
invalid_token`, whatever the token's expiry. The provider's `tokenExchangeCallback` binds the
grant id at code exchange and refuses refreshes of a revoked connection with `invalid_grant`
(which also revokes the grant). `connectedApp.revoke` marks the row, and the UI adapter then
deletes the grant's tokens from KV. Scopes are stored on the row; effective permission is
role ∩ scopes (`scopePermissions`, `grantedPermissions` on the invocation context). `read` ⊂
`write` ⊂ `admin`; `admin` is only grantable by admins. Access tokens last one hour
(`MCP_ACCESS_TOKEN_TTL`), refresh tokens 30 days.

**Rate limits** are fixed one-minute windows in D1 (`core_rate_limit`), per connection:
`MCP_RATE_LIMIT_REQUESTS` (default 120) for every request (HTTP 429 with a JSON-RPC error and
`Retry-After`) and `MCP_RATE_LIMIT_WRITES` (default 30) for non-read operations (a tool error with
code `rate_limited`). Per connection rather than per access token, so refreshing does not reset
the budget. D1 rather than the Rate Limiting binding because it is exact, testable and needs no
account configuration.

**Simulation by dry run.** On `review`, the pipeline runs the handler with writes discarded and
`ctx.simulation` set, capturing its record changes. From them it stores, on the pending action,
the diff preview and each touched record as `<object>.get` would return it afterwards (from the
handler's output when it returns the record, otherwise rebuilt from the change snapshot over the
current or simulated record). Creates get provisional ids (`per_pending_<ulid>`, the dry-run id
with `_pending` inserted). Reads by the session (`*.get`, `*.list`, `search.global`,
`activity.listForRecord`) are patched from these records and marked `pending`. Link checks accept
provisional ids. A write that mentions a provisional id is always queued (it cannot apply first).
Updating a record that is still pending creation is refused with an explanation rather than
simulated; links to it are supported.

**Dependencies** are recorded at queue time: an action depends on the session's latest pending
action that changed any record it changes or mentions (including links).

**Applying** (`approval.approve`, human only): each target action, in queue order, re-runs through
the pipeline as its original actor, user (current role), origin and granted permissions, with
provisional ids replaced by earlier bindings. The gate is still evaluated: `deny` (policy or
floor) refuses; `review` proceeds because a person approved it. The audit row has gate decision
`review`, outcome `ok` and `pending_action_id`; the pending action's status, bindings and
`applied_audit_id` commit in the same batch as the change. If a previewed field's current value
differs from the preview's `before`, or the record is gone, the action fails with a reason, and
everything depending on it is skipped. Approving an action before a pending dependency is refused.
Rejecting cascades to dependents. A decided change set is closed; later actions open a new one.

**Bookkeeping operations** (`changeset.begin` / `commit`, `connectedApp.register` / `revoke`)
carry `bookkeeping: true`: the gate never queues them, though `deny` still applies.

**Audit columns.** Migration 0010 adds `core_audit.pending_action_id`. `gate_decision` keeps its
stage-1 values (`auto | review | deny`): a SQLite `CHECK` cannot be altered without rebuilding the
append-only, redaction-guarded table, and `review` + `ok` + a pending action id identifies an
approved application unambiguously.

## Consequences
- Simulated state is per connection, not per conversation. Claude is told so in the server
  instructions and in every pending result.
- Simulation fidelity depends on handlers recording before/after snapshots with registry field
  names, which every core writer already does. Extension objects need a loader in
  `SIMULATED_OBJECTS` to appear in simulated reads (stage 3).
- A deny-all floor can now block approved actions at apply time; they fail with the gate's reason.
- Pending action inputs and reasons are stored unredacted. (`*.erase` scrubs them: see the
  amendment below.)

## Amendment, 2026-11-04 (stage 2 UI pass): erase scrubs the approval queue
`*.erase` (ADR 0019) now also redacts pending actions, in the erase's own batch
(`queueRedactPending` in `packages/core/src/records/erase.ts`):
- **Which:** any pending action (whatever its status) that touches an erased record
  (`core_pending_action_records`) or whose stored `input`, `reason`, `preview`, `simulated`,
  `error`, `status_reason` or `result` mentions an erased id, email or phone number (the same
  case-insensitive 6+ character terms as audit redaction).
- **What:** `input` becomes `"[erased]"`, `reason` `[erased]`, `preview` `[]`, `simulated` empty,
  `result` `"[erased]"` and `error` `{ code, message: "[erased]" }`. The row, its operation, risk,
  status and links to the audit log stay, so the queue still shows that something was asked and
  what happened to it.
- **Still pending:** such actions are rejected ("a record it mentions was erased"), and pending
  actions depending on them are rejected with them: they could never apply.
- The erased records leave `core_pending_action_records` (no more record badges), and change set
  titles lose exact mentions of the subject.

Like audit redaction this is over-inclusive: an action that mentions the subject loses its whole
input. Free-text names are not matched (ADR 0019).

## Amendment, 2026-11-04 (cost audit follow-up)
- **Rate limits** moved from D1 to the Workers Rate Limiting binding (ADR 0091): `MCP_RATE_LIMIT`
  (requests) and `MCP_WRITE_RATE_LIMIT` (writes), still per connected app, now approximate and
  configured under `ratelimits` in `wrangler.jsonc`. `core_rate_limit` and the
  `MCP_RATE_LIMIT_*` vars are gone.
- **Stored pending actions are capped and compacted** (ADR 0090). An input over 1 MB is not
  queued. Long preview values are truncated with a marker whose hash still drives the "changed
  since queued" check. Actions decided or expired more than 30 days ago keep a summary instead of
  their input, preview and simulated records.
- **Reads by the session** are counted per hour in `core_audit_read_counts`, with how many saw
  simulated state, rather than audited one by one.
