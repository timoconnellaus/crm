# @crm/gatekeeper-webhook

The inbound webhook gatekeeper (Worker `crm-gatekeeper-webhook`). External systems POST events to
the CRM. This Worker verifies each delivery's signature, refuses the ones that don't verify, shapes
the rest into typed `WebhookEvent`s and delivers them to the hook the CRM's integration host bound.
The host stores them as events; Stage 5 turns them into automation triggers
(`docs/stages/06-integrations.md`, "Inbound webhook gatekeeper", acceptance criterion 5).

It is auto-provisioned (no connect flow, no credentials) and has no outbound actions.

## Exports

| Export | What it is |
| --- | --- |
| `GatekeeperVendor` (also the default export) | The vendor entrypoint. Its `fetch` serves the public delivery route. `describe()` reports `autoProvisionsAccount: true`; `createAccount()` mints a `WebhookAccount`; `connectAccount()` throws. |
| `WebhookAccount` | The account (`GatekeeperUser`). `getGatekeeperClassFor("webhook://endpoint/<id>")` returns the facet class; `startResourceConfigurator("webhook://endpoint/:endpointId")` returns `{ iframeHtml, ui }`. |
| `WebhookEndpointGatekeeper` | The per-endpoint gatekeeper facet (Durable Object class, `Gatekeeper<WebhookSession>`). |
| `WebhookHookController` | The `HookController` the session passes to `bindHook()` (props `{ endpointId }`). |
| `WebhookEndpoint` | The Durable Object per endpoint (`idFromName(endpointId)`): secret, scheme, counters, recent events, seen ids, the hook's initiator and its delivery queue. |
| `WebhookVerifier` | The trivial `GatekeeperUserVerifier` (every collaborator may observe). |

The agent-facing types are in [`src/types.d.ts`](src/types.d.ts), served by `getTypeScriptTypes()`.
The configurator spec module is `@crm/gatekeeper-webhook/configurator/endpoint`.

## Resource

One grantable type, **Webhook endpoint**, URL pattern `webhook://endpoint/:endpointId`. An endpoint
id is 3 to 64 characters of `[a-z0-9-]`. The suggested binding name is `WEBHOOK`.

## Routes

`POST ${BASE_URL}/in/:endpointId`, served by the default entrypoint's `fetch`. The CRM proxies
`https://<crm-origin>/gatekeeper/webhook/*` to it, so with `BASE_URL=https://crm.example.com/gatekeeper/webhook`
the public URL is `https://crm.example.com/gatekeeper/webhook/in/<endpointId>`.

| Answer | When |
| --- | --- |
| `200 {"ok":true,"id":"<event id>"}` | Verified and stored (and queued for the hook, if one is enabled). |
| `200 {"ok":true,"id":"…","duplicate":true}` | Verified, but the delivery id was seen before: acknowledged, not stored or delivered again. |
| `200 {"challenge":"…"}` | A verified Slack `url_verification` request. Nothing is stored. |
| `401 {"ok":false,"error":"<reason>"}` | Missing, malformed or wrong signature, or a stale timestamp. Nothing is stored or delivered; the rejection is counted. |
| `404` | Unknown path, invalid endpoint id, or an endpoint with no secret configured. |
| `405` | Not a POST. |
| `413` | Body over 256 KB (by `Content-Length` or as streamed). |

## Signature schemes

All are HMAC-SHA256 with the endpoint's secret, compared in constant time
(`crypto.subtle.verify`). Signatures are lower- or upper-case hex. Timestamps are Unix seconds and
must be within 5 minutes of now (either direction).

| Scheme | Headers | Signed bytes |
| --- | --- | --- |
| `hmac-sha256` (generic) | `X-Webhook-Signature: sha256=<hex>`, optional `X-Webhook-Timestamp: <unix seconds>` | the raw body, or `${timestamp}.${body}` when the timestamp header is present |
| `github` | `X-Hub-Signature-256: sha256=<hex>` | the raw body |
| `stripe` | `Stripe-Signature: t=<ts>,v1=<hex>[,v1=<hex>…]` (any `v1` may match; other keys ignored) | `${t}.${body}` |
| `slack` | `X-Slack-Signature: v0=<hex>`, `X-Slack-Request-Timestamp: <ts>` | `v0:${ts}:${body}` |

Stripe and Slack secrets are the provider's (`whsec_…`, the app's signing secret) and are used as
given. For GitHub and the generic scheme, let the gatekeeper generate one.

## Events

```ts
type WebhookEvent = {
  id: string;          // provider delivery id, or a generated UUID
  endpointId: string;
  scheme: "hmac-sha256" | "github" | "stripe" | "slack";
  type: string;
  receivedAt: string;  // ISO 8601
  payload: unknown;    // parsed JSON, or { raw: string } when the body is not JSON
  headers: Record<string, string>; // allowlisted, lower-case names
};
```

| Scheme | `id` | `type` |
| --- | --- | --- |
| `github` | `X-GitHub-Delivery` | `github.<X-GitHub-Event>[.<payload.action>]` |
| `stripe` | `payload.id` (the event id) | `payload.type` |
| `slack` | `payload.event_id` | `slack.<payload.event.type>` (else `slack.<payload.type>`) |
| `hmac-sha256` | `X-Webhook-Id` | `X-Webhook-Event`, else `payload.type`, else `webhook` |

An id or type must be printable ASCII without spaces, at most 200 characters; an unusable id is
replaced with a generated one. The kept headers are `content-type`, `user-agent`, the
`x-github-event`/`-delivery`/`-hook-*` headers, `x-slack-request-timestamp`, `x-slack-retry-num`,
`x-slack-retry-reason`, `x-webhook-event`, `x-webhook-id` and `x-webhook-timestamp`. Signature,
authorization and cookie headers are never kept.

Each endpoint keeps its last 100 events (for `listEvents`) and the delivery ids of the last 30 days
(at most 10,000) for replay dedupe.

## The session

```ts
interface WebhookSession {
  getEndpoint(): Promise<{ endpointId: string; url: string; scheme: WebhookScheme; configured: boolean }>;
  subscribe(hook: WebhookEventHook): Promise<void>; // a persistent stub
  listEvents(options?: { limit?: number }): Promise<WebhookEvent[]>; // 1..100, default 20, newest first
}
interface WebhookEventHook {
  receiveEvent(event: WebhookEvent): Promise<void>;
}
```

`listEvents` records an observation first. `getEndpoint` never returns the secret. There is no way
to set or read the secret from a session.

## Configuring an endpoint (host/UI only)

The secret is set only through the configurator capability, which the host gets from
`account.startResourceConfigurator("webhook://endpoint/:endpointId")` as `ui`:

- `ui.configure({ endpointId, scheme, secret? })` →
  `{ endpointId, scheme, secret, url }`. Without `secret`, one is generated (32 random bytes, hex).
  The secret is returned this once; reconfiguring rotates it.
- `ui.status(endpointId)` → `{ endpointId, url, configured, scheme, configuredAt, hookEnabled,
  accepted, duplicates, rejected, lastReceivedAt, lastRejectedAt, lastRejectionReason }`. Never
  the secret.
- `ui.resourceUrl(endpointId)` → `webhook://endpoint/<endpointId>`.

Endpoint ids are global to the deployment: whoever holds the capability can (re)configure any
endpoint. The secret is never logged.

## How the host binds the hook

1. `const account = await vendor.createAccount()`.
2. `const { class: cls } = await account.getGatekeeperClassFor("webhook://endpoint/<id>")`, then
   instantiate it as a facet: `ctx.facets.get(name, () => ({ class: cls }))`.
3. `const session = await facet.startSession(approvalQueue)`; the agent (or host) calls
   `session.subscribe(hookStub)`, which calls `approvalQueue.bindHook(controller, hookStub,
   { title, description })`.
4. Once a human approves, the host calls `controller.enable(initiator, { workspaceId, gadgetId? })`
   with its persistent `HookInitiator`. The endpoint DO stores the initiator; `controller.disable()`
   forgets it and cancels pending deliveries.
5. For each new verified event, the endpoint DO calls `initiator.startHook()` → `{ callback,
   approvalQueue }`, records an observation (`Webhook event <type>`) through that queue, then calls
   `callback.receiveEvent(event)`.

Delivery runs from the DO's alarm through the kit's `HookDeliveryQueue`: a failing hook is retried
with backoff (1 minute doubling, up to an hour, 8 attempts) and then dropped with a warning that
quotes nothing from the event.

## Environment

| Variable | Meaning |
| --- | --- |
| `BASE_URL` | The public base this Worker is served under, e.g. `https://crm.example.com/gatekeeper/webhook`. Builds the delivery URLs and the route prefix. Empty means `http://localhost:5173/gatekeeper/webhook` (the local dev server). |

Bindings: `WEBHOOK_ENDPOINT` (Durable Object `WebhookEndpoint`). Compatibility flag
`allow_irrevocable_stub_storage` (the stored initiator). No secrets.

## Development

```sh
pnpm --filter @crm/gatekeeper-webhook typecheck   # wrangler types --check + tsc
pnpm --filter @crm/gatekeeper-webhook test        # workerd, @cloudflare/vitest-plugin
pnpm --filter @crm/gatekeeper-webhook build       # wrangler deploy --dry-run
```

The tests run `__tests__/worker.ts`, which re-exports the Worker and adds `TestHost` (a Durable
Object that plays the integration host through `ctx.facets`) and `TestInitiator`.

No capnweb-validate decorators: the CRM's Vite dev server runs this Worker as an auxiliary worker
and cannot transform them, so every RPC input is checked by hand (`src/validate.ts`).
