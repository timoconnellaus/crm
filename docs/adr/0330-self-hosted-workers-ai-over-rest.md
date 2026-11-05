# ADR 0330: Self-hosted Workers AI over REST through the deployment's gateway, with no prompt logging

Status: accepted, 2026-11-06 (user decision). Amends ADR 0180 (the gateway token), ADR 0203
(how Workers AI is routed) and ADR 0320 (its "not covered" AI Gateway logs).

## Context
ADR 0320 turned off payload logging (`cf-aig-collect-log-payload: false`) on every AI Gateway call
the model client makes with headers. Self-hosted Workers AI was the exception: it went through the
Worker's `AI` binding with the binding's `gateway` option, whose only logging switch,
`collectLog: false`, drops the metadata (tokens, cost) that Settings → AI's usage reads as well.
So the default path, every shipped role, logged prompts and responses in the gateway, where an
erase cannot reach them.

Hosted deployments already avoid this (ADR 0213 amendment): Platform AI calls Workers AI's
OpenAI-compatible REST endpoint with `cf-aig-gateway-id`, `cf-aig-collect-log-payload: false` and
a token holding Workers AI Read and AI Gateway Run. The user decided self-hosted installs do the
same whenever a gateway is configured (the default), keep the binding with `--ai-gateway off`, and
get the token from the installer.

### What the docs say (read 2026-11-06)
- [Workers AI OpenAI-compatible endpoints](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/):
  base `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1`, with
  `/v1/chat/completions` and `/v1/embeddings` (example model `@cf/baai/bge-large-en-v1.5`); "Workers
  AI endpoints work with AI Gateway". No token permissions are named.
- [Workers AI through AI Gateway](https://developers.cloudflare.com/ai-gateway/usage/providers/workersai/):
  the REST example sends `Authorization: Bearer $CLOUDFLARE_API_TOKEN` and
  `cf-aig-gateway-id: <gateway>` to `…/ai/v1/chat/completions`. It does not mention
  `cf-aig-authorization` or embeddings.

## Decision

### Routing (`packages/core/src/ai/workers-ai-rest.ts`, used by `client.ts`)
- Workers AI goes over REST when **`AI_GATEWAY_REST` is `"true"`** and `AI_GATEWAY_ID`,
  `CLOUDFLARE_ACCOUNT_ID` and `AI_GATEWAY_TOKEN` are set, on a self-hosted deployment. Hosted
  deployments are unchanged (Platform AI).
- Chat goes to `…/ai/v1/chat/completions` and embeddings to `…/ai/v1/embeddings`, through
  `@ai-sdk/openai-compatible`, the same client Platform AI uses for the same models. **Embeddings
  take the same route**: the REST endpoint documents them. The model id is the registry's
  (`@cf/…`), unprefixed.
- Every request carries `cf-aig-gateway-id: <gateway>`, `cf-aig-metadata: {"role"}`,
  `cf-aig-collect-log-payload: false`, `Authorization: Bearer <token>` and
  `cf-aig-authorization: Bearer <token>`. The REST docs show only `Authorization`; the gateway is
  authenticated (ADR 0180), so we also send the gateway header with the same token, which only
  ever goes to Cloudflare.
- **The payload switch cannot be dropped.** `workersAiRestFetch`, like `platformFetch`, deletes
  every `cf-aig-*` and `Authorization` header a caller set (the AI SDK's per-call headers, the
  assistant's own loop through `chatModels`, anything later) and writes the host's. Tested with
  hostile headers, smuggled options, generated and streamed calls.
- **Otherwise the binding, unchanged:** without `AI_GATEWAY_REST`, without a token, or with
  `--ai-gateway off` (no `AI_GATEWAY_ID`), Workers AI uses the binding exactly as before (with the
  `gateway` option when there is a gateway).
- Usage recording, fallbacks, JSON mode (`response_format: json_object`), the Settings → AI Test
  button and `keySource: "binding"` (self-hosted has no allowance) behave as on the binding.

### Why a var, not "gateway + token"
A token generated before this ADR holds AI Gateway Run only, and the REST endpoint would refuse
it. An older self-updater deploying this release runs its own (older) provisioning code, which
does not replace the token. Deciding by "a token is set" would then break every Workers AI call
until the next update. So the installer, which knows what the token can do, says so with
`AI_GATEWAY_REST`, and the runtime trusts only that.

### One token, not two
The user asked for one more account-owned token with only Workers AI Read and AI Gateway Run,
**or the existing token if one token can hold both safely.** We extend the existing
`AI_GATEWAY_TOKEN` to both permission groups:
- **The REST call needs both on one token anyway.** One `Authorization` header authenticates the
  Workers AI call and the authenticated gateway, so a REST token must hold AI Gateway Run. It
  would be a strict superset of `AI_GATEWAY_TOKEN`, making the older token redundant.
- **Same holders.** Both are secrets on ros-app and ros-runner, read only by host code (the model
  client); extension code never sees them (`codemode:ai` takes no headers or keys).
- **No new capability for those holders.** The added permission runs Workers AI models in this
  account (and reads the model catalogue). Those Workers already have the `AI` binding, which
  does exactly that. Nothing in either group writes or changes anything.
- **Same destination.** Only Cloudflare (`api.cloudflare.com`, `gateway.ai.cloudflare.com`);
  gateway headers are never sent to a provider called directly (ADR 0203).
- **Leak radius.** A leaked token could also run Workers AI on the account's bill. It could
  already spend the gateway's BYOK keys, a larger exposure. Scope stays the one account.

### Provisioning (`provisionAiGateway`, `packages/release/src/gateway.ts`)
Install, repair, `ros upgrade` and the self-updater all run it (ADR 0180), so each does all of
this:
- A generated token gets **AI Gateway Run and Workers AI Read** (looked up by name; if Workers AI
  Read is not found, the token gets Run only, with a warning, and Workers AI stays on the binding).
- **Existing installs:** the deployment state gains `aiGatewayTokenWorkersAi`. A token we
  generated (`aiGatewayTokenId`) without it is **replaced once**, even though the Workers still
  hold it. Without Account API Tokens Edit the old token is kept, with a warning, and Workers AI
  stays on the binding.
- **The replaced token is deleted only after the deploy** (`retiredTokenId` →
  `retireGatewayToken`, after the Workers switch and, for updates, the smoke check), so a failed
  deploy never leaves Workers holding a deleted token. This now also applies when a Worker lost
  the secret (ADR 0180 deleted at once).
- **A supplied token** (`--secret AI_GATEWAY_TOKEN=…`) is checked, not assumed: the installer lists
  one Workers AI model with it (`GET /accounts/{id}/ai/models/search?per_page=1`, which needs
  Workers AI Read). Refused → Workers AI stays on the binding, with a warning. A supplied token
  supersedes a generated one, which is retired. A token set by hand in an earlier run, whose
  ability is unknown, is left alone with a warning.
- `AI_GATEWAY_REST=true` is set on the gateway's Workers exactly when the token they will hold can
  call Workers AI, and removed otherwise; `--ai-gateway off` and `--ai off` remove it.
- `AI_GATEWAY_REST` is a manifest var input on ros-app and ros-runner (declared empty in both
  `wrangler.jsonc`).

## Consequences
- Self-hosted Workers AI prompts and responses no longer reach AI Gateway's logs; metadata,
  tokens and cost still do, so Settings → AI usage is unchanged. ADR 0320's "not covered" item is
  closed for installs that have a gateway and a token.
- Prompts are still logged when the token cannot call Workers AI (a hand-set or older token whose
  replacement was not permitted). The installer warns each time.
- The install token's Account API Tokens Edit now creates a token with one more group. Cloudflare
  may require the creating token to hold Workers AI itself; that is a real-account check
  (`docs/deploying.md`, "Verify on a real account: Workers AI over REST").
- Workers AI calls now leave the Worker as HTTP subrequests instead of binding calls. Each counts
  towards the Worker's subrequest limit (embedding batches already run two calls at a time).
- `scripts/deploy.mjs` (from a checkout) is unchanged: it sets no `AI_GATEWAY_REST`, so Workers AI
  stays on the binding there unless set by hand along with a suitable token.
- **Unverified until a real account is used:** that the REST endpoint accepts the token with
  these two groups; that an authenticated gateway accepts the call (with `Authorization` and
  `cf-aig-authorization` both set); that `cf-aig-gateway-id` routes `/ai/v1/embeddings` through
  the gateway (if it does not, embeddings still work but are missing from the gateway's usage);
  that the gateway's logs show no body with `cf-aig-collect-log-payload: false`; and that the
  catalogue probe needs Workers AI Read. Steps in `docs/deploying.md`.
