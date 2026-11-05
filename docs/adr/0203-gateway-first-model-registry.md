# ADR 0203: A gateway-first model registry, BYOK keys from Settings → AI, and a review-independence warning

Status: accepted, 2026-11-05 (stage 7b build). Amends ADR 0150 (how providers are called through
AI Gateway; it had rejected the unified endpoint), ADR 0151 (the key form's default and how BYOK
keys are stored), ADR 0180 (stage 7b's registry half) and ADR 0192 (DeepSeek's gateway path).

## Context
ADR 0180 made AI Gateway part of every deployment and said stage 7b would make the registry
gateway-first. Until now the runner called each third-party provider through the gateway's
**provider-native** path (`…/{gateway}/openai`, `…/{gateway}/deepseek`, …), kept a table of
those paths per provider, and had no way to name an AI Gateway **custom provider** at all: the
docs suggested pointing `openai-compatible` at `…/{gateway}/custom-<slug>/v1` by hand. Settings →
AI's key form posted BYOK keys to the provider-configs API itself and defaulted to Workers
secrets.

The user decided:
- **All AI goes through AI Gateway by default**, third-party providers through the gateway's
  **unified OpenAI-compatible endpoint** (`/compat`), with `provider/model` model ids.
- **Workers AI stays the default provider for every role**, behind the gateway.
- `--ai-gateway off` must still work.
- Settings → AI stores keys as BYOK through `CloudflareClient.setGatewayProviderKey`.
- The review role (the policy adjudicator) should warn, not block, when it shares the assistant's
  model (ADR 0031).

### What the docs say (all read 2026-11-05)
- [Unified API (chat completions)](https://developers.cloudflare.com/ai-gateway/usage/chat-completion/):
  `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway}/compat/chat/completions`, model as
  `{provider}/{model}` (examples `openai/…`, `anthropic/…`, `google-ai-studio/…`, `workers-ai/…`).
  An authenticated gateway takes `cf-aig-authorization: Bearer <token>`; a provider key goes in
  `Authorization`; the "Stored Key (BYOK)" examples send no provider key. The page says "For
  standard single-model chat completions, this endpoint is deprecated" and "The
  `/compat/chat/completions` endpoint will continue to work for existing integrations".
  Embeddings are not mentioned.
- [Custom providers](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/):
  through the unified endpoint, "Specify the model using the format `custom-{slug}/{model-name}`".
- [BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/): "AI
  Gateway substitutes the stored provider key only when the provider authorization header is
  absent"; `cf-aig-authorization` is still required; without `cf-aig-byok-alias` the `default`
  alias is used. It does not say whether the unified endpoint or custom providers use stored keys.
- [DeepSeek](https://developers.cloudflare.com/ai-gateway/usage/providers/deepseek/): model
  `deepseek/{model}` on the unified API; BYOK by omitting `Authorization` and sending
  `cf-aig-authorization`.
- [Worker binding methods](https://developers.cloudflare.com/ai-gateway/integrations/worker-binding-methods/):
  `env.AI.run(model, input, { gateway: { id, metadata, … } })`; the gateway "must be in the same
  account as your Worker". On the binding path only the `default` BYOK alias is consulted.
- [Authentication](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)
  (as cited in ADR 0180): binding calls are authenticated within the account and need no token.

## Decision

### Routing (`providerRoute` in `packages/core/src/ai/client.ts`)
| Provider | Gateway configured (`AI_GATEWAY_ID` + `CLOUDFLARE_ACCOUNT_ID`) | No gateway (`--ai-gateway off`) |
| --- | --- | --- |
| Workers AI | the `AI` binding with `gateway: { id, metadata: { role } }` | the binding, no option |
| openai, google, openrouter, deepseek, anthropic (chat) | `…/{gateway}/compat/chat/completions`, model `{gatewaySlug}/{model}` | the provider's own base URL, model as is |
| openai, google, openrouter (embeddings) | the provider-native gateway path (`…/{gateway}/openai/embeddings`, …) | own base URL |
| `custom` (an AI Gateway custom provider) | `…/{gateway}/compat`, model `custom-<slug>/<model>` as written | not available ("Custom providers need AI Gateway") |
| jev, openai-compatible | their configured base URL, **not** through the gateway | same |

- **Why compat, despite ADR 0150 rejecting it as deprecated.** One endpoint for every provider,
  so the per-provider path table (and our guesses at Google's and Anthropic's OpenAI-compatible
  sub-paths) goes away; custom providers are addressed the same way as built-in ones; and
  `provider/model` ids are the gateway's own naming, the same strings the docs, the dashboard
  and the logs use. **Risk:** Cloudflare calls the endpoint deprecated for single-model calls. It
  "will continue to work", but it may lag new features or be retired. The newer REST endpoint
  (`/accounts/{id}/ai/v1/chat/completions`) does not document custom providers, and it needs a
  Cloudflare API token rather than the gateway token. If compat is retired, `providerRoute` is the
  one place to change: the provider-native paths still exist for every built-in provider.
- **The registry's model id stays unprefixed.** A role still says `{ provider: "deepseek", model:
  "deepseek-flash" }`; the prefix is added at call time from `PROVIDER_INFO[provider].gatewaySlug`
  (`gatewayModelId`). Results report the registry's id, so summary caches (which hash the model,
  ADR 0153) are not invalidated by the routing change.
- **Custom providers: one provider id, the gateway's model id.** The smallest change: a new
  provider `custom` whose model id is exactly what the gateway wants, `custom-<slug>/<model>`
  (for example `custom-together/deepseek-ai/DeepSeek-V4.1-Flash-1017`). The capability check
  rejects a `custom` model not in that form. Unknown models declare their capabilities, as
  before. A custom provider exists only in the gateway, so it is `gatewayOnly`: it is ready
  whenever the gateway is configured, and its key is always BYOK. We cannot see from the Worker
  whether a key is stored, so a missing key shows up as the provider's authentication error on
  the first call (and the role's fallback answers).
- **Workers AI keeps the binding with the gateway option, not compat `workers-ai/@cf/…`.** The
  binding is authenticated in-account and needs no `AI_GATEWAY_TOKEN`, so Workers AI keeps
  working on a gateway whose token step was skipped (ADR 0180). It needs no
  `CLOUDFLARE_ACCOUNT_ID`; embeddings over the binding are documented, unlike compat embeddings;
  and the `--ai-gateway off` path is the same code with the option left out. Logs and
  `cf-aig-metadata` role tagging work the same way through the option's `metadata`.
- **Embeddings** are not documented on the unified endpoint, so a third-party embedding model
  goes to the provider's native gateway path where we know one (OpenAI, Google AI Studio,
  OpenRouter). A custom provider's embeddings go to `…/compat/embeddings` (unverified). The
  shipped `embed` role is Workers AI, so neither is on a default path.
- **Headers.** Every gateway call sends `cf-aig-metadata: {"role": …}` (usage per role, ADR 0152)
  and, when `AI_GATEWAY_TOKEN` is set, `cf-aig-authorization: Bearer <token>`. With a key from a
  Workers secret the call sends `Authorization: Bearer <key>`; with BYOK it sends no
  `Authorization`, so the gateway adds the stored key. **Gateway headers are never sent to a
  provider called directly**: before, a deployment with `AI_GATEWAY_ID` but no account id, or a
  jev / openai-compatible role, sent the gateway token to the third party.
- **DeepSeek's thinking switch** still travels as a provider option (`providerOptions.deepseek`),
  which `@ai-sdk/openai-compatible` copies into the request body as `thinking: {type}`. The client
  is still named after the registry provider, so the option key is unchanged on compat. Tested
  against a fake server; that the gateway forwards the field to DeepSeek is not verified.
- **The `chatModels(role)` seam** builds its models with the same `languageModel` and the same
  header function as `run`, so the assistant's tool loop is routed identically (tested).
- `generate()` is unchanged apart from the header helper, so the adjudicator's JSON-mode option
  (another stage 7b stream) merges cleanly. `review` keeps requiring `json`, not `jsonSchema`.

### Keys from Settings → AI (`ai.setProviderKey`)
- **BYOK goes through `CloudflareClient.setGatewayProviderKey`** (`@relationship-os/release`, ADR
  0180), the same path as `create-relationship-os --provider-key`: it attaches the account's
  Secrets Store to a gateway that has none (creating one if the account has none), deletes any
  key stored for the provider under `default`, and creates the provider config under `default`.
  Built-in providers use their gateway slug (`deepseek`, `google-ai-studio`, …); a custom
  provider's key goes under `custom-<slug>` (`gatewayKeySlug`).
- **The mode defaults to BYOK when the deployment has a gateway**, else a Workers secret. The form
  preselects the same. A custom provider takes a slug field and is BYOK only.
- Built-in providers stored as BYOK are still recorded in `ai_settings.byok` (names only), so the
  runner leaves `Authorization` out. Custom providers are not recorded: they are always BYOK.
- Keys never reach D1: `ai-keys.test.ts` stores keys each way, including a custom provider's and a
  gateway that needs a Secrets Store, then reads every row of every table.

### Review independence (ADR 0031)
`reviewIndependence(roles)` in `roles.ts` (pure, exported) compares the resolved `review` and
`assistant` roles. When both are the same provider and model it returns `{ ok: false, message }`.
`ai.settings` returns it as a `warnings` entry on the review role, and Settings → AI shows it on
the review card. It never blocks saving. The `deepseek-flash` preset triggers it (ADR 0192's known
trade-off). Fallbacks are not compared: with the shipped defaults the assistant's fallback is the
review model, and warning about that would be noise.

## Consequences
- One request shape for every third-party provider, and custom providers become a setting
  (`{ provider: "custom", model: "custom-<slug>/<model>", capabilities }`), not a hand-built
  base URL.
- We depend on an endpoint Cloudflare calls deprecated for this use. `providerRoute` isolates it.
- Unverified until a real account is used: that compat accepts `deepseek/deepseek-flash` and
  passes DeepSeek's `thinking` field and multi-turn `reasoning_content` through; that compat
  applies BYOK keys (the BYOK page is silent on it; DeepSeek's page shows BYOK on the native path);
  that a custom provider's BYOK key under `custom-<slug>` is picked up; that `openrouter/…` is
  accepted on compat (OpenRouter is not in the unified page's provider list); custom-provider
  embeddings on compat. The Test button in Settings → AI shows any of these as an error.
- `ProviderId` gains `custom`; zod enums follow `PROVIDERS`, so `ai.updateRole` and
  `ai.setProviderKey` accept it. `ai.setProviderKey` gains an optional `customProvider` slug, and
  its `mode` is now optional (defaulted as above).

> **Amended 2026-11-05 (hosted AI, ADR 0213 amendment):** `PROVIDERS` gains `platform` (Platform
> AI: Workers AI's models through the shared platform gateway with the tenant tag), reachable only
> on a hosted deployment, where every `workers-ai` role resolves to it. `providerRoute` is unchanged
> for self-hosted installs; on a hosted one the "gateway" for the customer's own keys is their own
> connected gateway, if any, else none (direct calls).
