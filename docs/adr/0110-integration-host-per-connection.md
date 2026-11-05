# ADR 0110: The integration host, one Durable Object per connection

Status: accepted, 2026-11-05 (stage 6a build). Implements ADR 0050. Decides cost audit U10.

## Context
ADR 0050 puts the Workshop side of the Cloudflare OS gatekeeper interface in an "integration host
DO" in `ros-runner`. Gatekeeper accounts, facet classes and hook controllers are persistent RPC
stubs: only Durable Object storage can hold them (`allow_irrevocable_stub_storage`). The cost audit
(U10) warns that one host DO for the whole org would carry every gatekeeper call, hook firing,
outbound apply and sync pass of the deployment, and would be awake all the time.

## Decision

**Sharding.** One `IntegrationHost` DO per connection: `INTEGRATION_HOST.getByName(connectionId)`.
A connection's traffic (its sessions, hooks, outbound applies and sync) wakes only its own object.
Nothing needs a global index of stubs: listing comes from the D1 mirror. We rejected per-user plus
one org object: a busy shared inbox would still serialise everyone using it, and a per-user object
would mix unrelated mailboxes' sync alarms.

**What the host owns** (its own storage):
- `account`: the `Fetcher<GatekeeperUser>`, and `companion:<vendor>` for a companion gatekeeper
  connected in the same flow (Slack posting, ADR 0114);
- the staged account of a connect or reconnect, with the ticket hash and expiry;
- one facet per bound resource, keyed by the first 16 hex characters of SHA-256(resource URL),
  created with `ctx.facets.get("f-<key>", () => ({ class }))` from the class stub
  `getGatekeeperClassFor(url)` returned. The class stub is stored, so after a restart (or eviction)
  the facet is recreated from storage; the facet's own storage is the facet's. Auto-provisioned
  singletons (web search) are the facet `singleton`, from `getSingletonGatekeeperClass()`;
- hook controllers and their purpose (`sync`, `webhook`, or `agent`);
- sync state (ADR 0112), driven by the object's alarm.

**D1 mirrors state for the UI only** (`core_integration_connection`, migration 0110): status, error,
account label, bound resources (key, URL, binding name, session type), sync status. Operations
write it; the host writes only mirror columns for events that arrive outside an operation
(`credentialsExpired`, sync progress).

**Connect handoff.** `connection.create` writes the mirror row, then the host mints a per-flow nonce
(kept as a hash), passes `ctx.exports.ConnectCallback({ props: { connectionId, vendor } })` to
`connectAccount`, and returns the popup URL and nonce. The app opens a blank popup, writes the nonce
into its sessionStorage, and sends it to the provider. `callback.complete(user)` stages the account
and returns a ticket `<connectionId>.<random>` for the app's origin. `/connect/handoff#ticket`
redeems it with `connection.completeConnect` over the signed-in user's session: the host activates
the account only if the user is the one who started the flow, the nonce matches and the ticket is
fresh (15 minutes), and revokes it otherwise. Reconnect stages credentials the same way and commits
with `commitReconnect(stageId)`. A catalogue entry's companion connects next in the same popup.

**Public routes.** `ros-app` proxies `/gatekeeper/<vendor>/*` (no session: OAuth redirects, connect
pages, provider pushes) to `ros-runner.gatekeeperFetch(vendor, request)`, which forwards to the
gatekeeper Worker's default fetch. Each gatekeeper authenticates its own routes (nonces,
signatures). The request's origin is the handoff's target; `APP_ORIGIN` is the fallback.

**Gatekeeper bindings** are `GATEKEEPER_<NAME>` service bindings on `ros-runner` to each Worker's
`GatekeeperVendor` entrypoint. A deployment binds the gatekeepers it deploys; `availableVendors`
reports which exist, and an admin enables them (`core_integration_vendor`, `integration.setVendor`).
The committed config binds only the fake provider.

**The fake provider** is part of `ros-runner` (`FakeGatekeeperVendor`, its account DO, facet and
provider data DO), bound to itself as `GATEKEEPER_FAKE`, and answers only when
`INTEGRATIONS_FAKE_PROVIDER=true` (local development and tests). It implements the real interface
(OAuth-like consent page, handoff, facets, hooks, a journalled outbox) so the whole path is tested
without real accounts.

## Consequences
- Each connection's DO is small and idle unless its connection is used. A deployment with many
  connections has many objects, each billed only when awake.
- Facets of one connection share their host's isolate and storage limits; a very busy shared
  mailbox is still one object. Splitting further (per resource) is possible later without changing
  the D1 mirror or the operations.
- `ros-runner` now needs `allow_irrevocable_stub_storage`, the R2 bucket `ros-blobs` (ADR 0112) and
  the new Durable Object classes (migration tag `v4`).

## Stage 6b plug points
- **Automation run-as** (ADR 0051): every session and hook firing is opened with a `QueueCaller`
  (`apps/runner/src/integrations/queue.ts`). An automation step is an `actor` caller whose
  `IntegrationCaller.userId` is the bound connection's owner (for a personal connection) and whose
  origin carries `automationId`; `IntegrationHost.call` already refuses personal connections for
  anyone else. 6b adds the binding table and consent, and resolves the caller before calling
  `integration.call` / `codemode:<gatekeeper>`.
- **Revocation pauses automations**: `IntegrationHost.disconnect`, `credentialsChanged("expired")`
  and the mirror's `status` are where 6b observes a revoked or expired connection.
- **Hooks as triggers**: hooks agents ask for are stored with purpose `agent` and `enabled: false`
  (`hook:<id>` in the host). Stage 5 / 6b enables one by binding it to an automation and calling
  `controller.enable(initiator)`; `startHook()` then returns the automation's callback.
- **Notification channels**: email and Slack delivery are outbound actions on an org connection of
  `email-send` (kinds `email.send`, `email.internal`, the latter auto-approvable for internal
  recipients) or `slack-post` (`slack.post`, `slack.dm`), sent with `integration.call` as a system
  caller. Admin-enabled auto-approval (`outbound.setAutoApprove`) covers fixed-template internal
  notifications (cost audit U8).
