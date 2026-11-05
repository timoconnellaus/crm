# ADR 0213: AI usage billing from AI Gateway, in dollars

Status: accepted, 2026-11-05 (Stage 10). Uses ADR 0152 (spend per role) and ADR 0180 (a gateway
per deployment).

## Decision
- **Source.** Each hosted deployment has its own AI Gateway, which logs every model call with its
  provider and AI Gateway's cost estimate. Once a day the control plane pages through yesterday's
  logs (`GET …/ai-gateway/gateways/{id}/logs`, filtered by `created_at`, up to 400 pages of 50) and
  stores one `cp_ai_usage` row per deployment per day.
- **What is billed.** Only providers we pay for (`PLATFORM_AI_PROVIDERS`, default `workers-ai`),
  excluding cache hits. Any other provider in the gateway is the customer's own key (BYOK): shown,
  never billed. An AI client connected over MCP uses its own model and never touches the gateway.
- **Price.** `charged = billable cost × (1 + AI_MARKUP_PERCENT/100)`, default 20%, kept in
  micro-dollars and shown in dollars: no opaque credits.
- **Paid plans.** Charged spend beyond the plan's monthly allowance (Team $10, Business $25) is
  reported as a Stripe Billing Meter event (`STRIPE_METER_EVENT`, value in cents, `identifier`
  `ai-<tenant>-<day>`, timestamp midday of that day). Whole cents of month-to-date overage minus
  cents already reported, so rounding never loses or double-counts. A metered price on the
  subscription turns the meter into an invoice line.
- **Free plan.** Charged spend is debited from prepaid credit (Checkout one-off payments of $10,
  $25 or $50). When the balance reaches zero, the entitlement `platformAi` turns off (ADR 0211) and
  the owner is emailed; buying credit turns it back on.
- Idempotent: a day already metered is skipped; a retried meter event reuses its identifier.

## Consequences
- **Latency**: usage is daily, so a Free account can overspend its credit by up to a day of usage
  (shown as a negative balance, deducted from the next purchase). Hourly metering is a cron change.
- **To verify at go-live**: that the logs API lists gateways created after 2026-09-24 (Workers Logs
  storage) and that `cost` is populated for Workers AI. Logs without a cost are counted as
  `unpriced` and shown in the admin console; if Workers AI has no cost, price it from tokens.
- The 20-gateways-per-account limit (ADR 0210) affects this design directly.

> **Amended 2026-11-05 (user decision): one shared platform gateway, and BYOK outside it.**
> This replaces "each hosted deployment has its own AI Gateway" for hosted customers, and resolves
> the 20-gateway limit (go-live blocker B1). Not built yet; to be built after Stage 7b reworks the
> model registry.
> - **Platform AI** (the AI we pay for and bill) goes through **one shared gateway** in our
>   account. Every call carries a tenant tag (`cf-aig-metadata`: tenant id and plan), and the daily
>   metering filters that gateway's logs by tenant. The billing rules above (what is billed, the 20%
>   markup, allowances, Free credit) are unchanged.
> - **Conditions on the shared gateway**, because it serves every tenant:
>   - caching is **off**, or keyed per tenant, so no tenant can receive another's cached response;
>   - **prompt and response logging is off**, keeping only metadata, tokens and cost, so the
>     control plane still never holds customer data;
>   - the tenant tag is set by host code in the model client, never by extension code or anything
>     reachable through `codemode:ai`, so a tenant cannot bill its usage to another.
> - **The customer's own key (BYOK)** is configured in the app, in Settings → AI, and called
>   **directly** at the provider, not through our gateway. The key is never stored in D1: Settings
>   hands it to the control plane, which sets it as a secret on that tenant's Worker, through the
>   Workers for Platforms script-secrets API. BYOK usage is shown to the customer and never billed.
> - **Optional: the customer's own AI Gateway.** A customer who wants logs and spend tracking for
>   their own keys can connect their own gateway (id and token, stored the same way as a key).
> - **Same codebase, a placement setting.** "Platform AI" is one more provider in the model registry
>   (the shared gateway plus the tenant tag), switched on for hosted deployments by their
>   entitlements. Self-hosted installs keep their own per-deployment gateway (ADR 0180). There is
>   no hosted-only fork.

> **Amended 2026-11-05: the amendment above is built.** How, and what changed in the detail:
> - **Placement switch.** A deployment is hosted when provisioning set `AI_PLATFORM_GATEWAY_ID`
>   (`packages/core/src/ai/platform.ts`). There, every Workers AI role, primary or fallback,
>   resolves to the registry provider **`platform`** ("Platform AI": Workers AI's catalogue,
>   `onPlatform`), and plain `workers-ai` is refused, so nothing calls Workers AI untagged.
>   `platformAi: false` in the entitlements blocks it (`AiAllowanceError`); a Workers secret key is
>   the customer's own on a hosted deployment and is never blocked (`platformPaid`).
> - **Not the `AI` binding.** Platform AI calls Workers AI's OpenAI-compatible REST endpoint
>   (`api.cloudflare.com/client/v4/accounts/{platform account}/ai/v1`, with
>   `cf-aig-gateway-id: <shared gateway>`) with the shared platform token (`AI_PLATFORM_TOKEN`:
>   Workers AI Read and AI Gateway Run). Reason: "prompt and response logging off" is the request
>   header `cf-aig-collect-log-payload: false`; the binding's gateway options have only
>   `collectLog`, which drops the metadata (tokens, cost) too, and AI Gateway documents no
>   gateway-level payload switch (logging page and create-gateway API, read 2026-11-05).
> - **The tag can't be set by a caller.** Every Platform AI request goes through `platformFetch`,
>   which deletes any `cf-aig-*` and `Authorization` header the caller set and writes the host's:
>   `cf-aig-metadata: {"role","tenant","plan"}` (tenant from `ROS_TENANT_ID`, plan from the
>   entitlement row), `cf-aig-collect-log-payload: false`, `cf-aig-skip-cache: true`. Tested with
>   hostile per-call headers, smuggled options and `codemode:ai` arguments
>   (`packages/core/test/ai-hosted.test.ts`, `apps/runner/test/ai-hosted.test.ts`).
> - **The shared gateway** is `PLATFORM_AI_GATEWAY` (default `ros-platform`). Every provision
>   creates it if missing (`cache_ttl: 0`, `collect_logs: true`, `authentication: true`) and puts
>   back any of those settings that drifted (`ensurePlatformGateway`, audited).
> - **Metering** reads the shared gateway's logs with the filter `metadata.value eq <tenant>` and
>   then keeps only logs whose parsed tag's `tenant` is that tenant (the API does not pair a
>   metadata value with its key). A deployment provisioned before this keeps its own gateway's logs
>   counted as well. The billing rules are unchanged.
> - **The customer's own keys** go from Settings → AI to the control plane over the signed
>   deployment channel ([ADR 0250](0250-deployment-to-control-plane-channel.md)), which sets
>   `AI_KEY_<PROVIDER>` on the tenant's AI Workers. They are called at the provider's own URL, or
>   through the customer's own AI Gateway when they connected one (`ai.connectGateway`, the secret
>   `AI_CUSTOMER_GATEWAY`: account id, gateway id, optional token). An AI Gateway custom provider
>   needs that own gateway.
> - **Usage shown to the customer.** The customer's own calls reach no gateway we read, so a hosted
>   deployment counts every model call in its own D1 (`core_ai_usage`, migration 0260: requests and
>   tokens per day, role and provider, billed or not; never content). Settings → AI shows it split
>   into "Your plan" and "Your own key". Billing still comes only from the gateway's logs.
