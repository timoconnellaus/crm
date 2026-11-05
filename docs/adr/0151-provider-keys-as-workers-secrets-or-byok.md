# ADR 0151: Provider keys as Workers secrets or AI Gateway BYOK, never D1

Status: accepted, 2026-11-05 (stage 7a build). Applies ADR 0009 ("keys are Worker secrets or
Gateway BYOK, never stored in D1").

## Context
Settings → AI lets an admin enter a key for an optional provider (OpenAI, Google, OpenRouter,
Anthropic, Jev, a custom endpoint). The key must reach the running Workers without ever being
written to D1, where `query.sql`, backups, Time Travel and the audit log would all expose it.

## Decision
- **`ai.setProviderKey { provider, apiKey, mode }`** (admins, actor `human` only, not exposed to
  MCP). The handler passes the key straight to the `AiAdmin` port (`cloudflareAiAdmin` in
  `packages/core/src/ai/admin.ts`), which calls the Cloudflare API:
  - **`secret`** (default): `PUT /accounts/{account}/workers/scripts/{script}/secrets` with
    `{ name: "AI_KEY_<PROVIDER>", text, type: "secret_text" }` on each script in
    `AI_SECRET_SCRIPTS` (default `ros-app,ros-runner`). The API "adds a secret … by creating a new
    version with that secret"
    ([secrets API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/update/));
    the next request served by that version sees `env.AI_KEY_<PROVIDER>`.
  - **`byok`**: `POST /accounts/{account}/ai-gateway/gateways/{gateway}/provider_configs` with
    `{ alias: "default", default_config: true, provider_slug, secret }`
    ([provider configs](https://developers.cloudflare.com/api/resources/ai_gateway/subresources/provider_configs/methods/create/)).
    The key lives in Secrets Store and the gateway adds it when the request carries no provider
    `Authorization` header ([BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/)).
    D1 records only that the provider uses BYOK (`ai_settings.byok`), so the runner leaves the
    header out.
- **What D1 and the audit log keep**: the audit row's input has `apiKey: "[redacted]"` (the
  pipeline redacts secret-named keys, and the operation lists `apiKey` in `redact`); its change
  row says where the key lives (`keyStore: "secret" | "byok"`); the output and errors never echo
  the request. `packages/core/test/ai-keys.test.ts` sets a key and then reads every row of every
  table to assert the key is nowhere in the database.
- **The API token** is the `CLOUDFLARE_API_TOKEN` secret on ros-app (set by `pnpm run deploy` from
  `ROS_AI_ADMIN_TOKEN`), with `CLOUDFLARE_ACCOUNT_ID` as a var. Permissions:
  - Account → Workers Scripts → Edit: store keys as Workers secrets.
  - Account → AI Gateway → Edit and Account → Secrets Store → Edit: BYOK
    ([Secrets Store access](https://developers.cloudflare.com/secrets-store/access-control/)).
  - Account → AI Gateway → Read: usage and spend (ADR 0152).
  AI Gateway permissions are account-scoped and cannot be limited to one gateway
  ([authentication](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)).
- **Without the token** Settings → AI shows what to set instead of the form, and
  `ai.setProviderKey` fails with a config error naming the missing variables. Keys can always be
  set by hand with `wrangler secret put AI_KEY_<PROVIDER>` on both Workers.
- `ai.deleteProviderKey` deletes the secret from each script (also a new version), or forgets the
  BYOK flag (the stored key is removed in the AI Gateway dashboard).

## Consequences
- A key change is a Worker version change: it appears in the Workers deployment history, and it
  takes effect within seconds, not mid-request.
- The token in ros-app can edit the Worker's own scripts. It is an admin-only path (human actor,
  `settings:manage`), audited, and the token itself is env-only, like the auth secrets.
- Because AI Gateway BYOK on the binding path uses only the `default` alias, we always store keys
  under `default`.

> Amended 2026-11-05 ([ADR 0180](0180-ai-gateway-provisioned-per-deployment.md)): BYOK in AI
> Gateway is now the default home for provider keys. Every deployment has a gateway, and
> `create-relationship-os --provider-key <provider>=<key>` stores a key there with
> `CloudflareClient.setGatewayProviderKey` (from `@relationship-os/release`, which Settings → AI can use too).
> Workers secrets remain possible, but they are no longer the recommended path.

> Amended 2026-11-05 ([ADR 0192](0192-deepseek-provider-and-model-role-presets.md)): BYOK can
> also be declared in deploy config. `AI_GATEWAY_BYOK` (comma-separated providers, set by
> `create-relationship-os --provider-key`) joins `ai_settings.byok`, so a key the installer stored in the
> gateway is used without a Settings → AI step. The var names providers only, never keys.
