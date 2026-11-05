# ADR 0180: Every deployment gets an AI Gateway, provisioned by the installer and the updater

Status: accepted, 2026-11-05 (follow-up to stage 8). Amends ADR 0009, ADR 0150, ADR 0151 and
ADR 0160. Stage 7b moves the model registry to gateway-first; this ADR covers provisioning only.

## Context
Until now AI Gateway was optional: an operator created one by hand and passed `--ai-gateway <id>`
(or set `AI_GATEWAY_ID`), and an authenticated gateway's token was a secret they set themselves.
Most deployments would have had no gateway. Without one there are no logs, no usage and spend per
role (ADR 0152) and no BYOK. The user decided:

- **Every AI call goes through AI Gateway by default.** The gateway is the routing layer for every
  provider.
- **The default models stay on Workers AI**, reached through the gateway.
- **Provider keys live in AI Gateway as BYOK**, not as Workers secrets.
- Providers that AI Gateway does not have built in are added as **custom providers**. The first
  is Together AI (`custom-together` → `https://api.together.xyz`), so the assistant role can use
  `custom-together/deepseek-ai/DeepSeek-V4.1-Flash-1017`.

## Decision

### What is provisioned
With the `ai` feature on (the default, ADR 0156), `create-relationship-os` install and repair, `ros upgrade`
and the self-updater all run the same function, `provisionAiGateway` in
`packages/release/src/gateway.ts`. Upgrades call it inside `runUpdate`'s switch step, after the
new release's resources and before the Workers switch, so an upgrade creates whatever is missing.
This is the path ADR 0164 already uses for resources.

1. **The gateway.** Its id is the install name: the app Worker's deployed name without `-app`, so
   `ros-app` → `crm`. `--ai-gateway <id>` picks another id. The installer finds the gateway by id
   and creates it if it does not exist. It is created with logging on (`collect_logs`), no caching,
   no rate limit, and **authentication on**. Authentication is on for new gateways by default and
   cannot be turned off once on. An existing gateway that has logging or authentication off gets
   them turned on; its other settings are sent back unchanged, because the update API replaces
   them all. `aiGatewayCreated` in the deployment state records whether we created it, so
   `ros uninstall` deletes only gateways it created. `--ai-gateway off` opts out: there is then no
   gateway, and Workers AI is called directly.
2. **Custom providers**, from `deploy-inputs.json` `aiGateway.customProviders`, carried in the
   release manifest as `aiGateway`. Custom providers are account-wide. Each one is found by slug,
   created if it is missing, and updated if its base URL changed or it was disabled. A provider
   with slug `together` is called through the gateway as `custom-together`. The settings a
   gateway is created with are data too (`aiGateway.settings`), but authentication is always
   forced on. The release build checks this block (`checkAiGateway`): it needs an https base URL
   and a slug with no `custom-` prefix, slugs must be unique, and turning authentication off fails
   the build.
3. **`AI_GATEWAY_ID`** is set as a var on every Worker that declares it, which is the manifest's
   `AI_GATEWAY_ID` input: ros-app and ros-runner.
4. **`AI_GATEWAY_TOKEN`.** This is the value of `cf-aig-authorization`, an API token with
   **AI Gateway Run**. The installer creates an **account-owned API token** with only that
   permission group, scoped to the account. It looks up the group by name with the
   permission-groups API. The token is stored as a secret on the same Workers. It is created
   again only when one of those Workers lacks the secret, and the token it replaces is then
   deleted. `--secret AI_GATEWAY_TOKEN=…` supplies a token instead of generating one. Workers AI
   calls through the `AI` binding are already authenticated within the account and need no token
   ([authentication](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)).

Every step checks the current state before it changes anything, so a re-run converges and a
finished install re-run makes no AI Gateway writes. A step that the API token is **not allowed**
to do (HTTP 401 or 403) is printed as a warning and skipped, and the install or update goes on.
For example, an update token stored before this ADR has no AI Gateway permission. With the gateway
skipped, the deployment keeps working, and Workers AI is called directly. Any other error fails
the step: an install fails, and an update rolls back.

### Provider keys (BYOK)
`CloudflareClient.setGatewayProviderKey(accountId, gatewayId, provider, key)` stores a key under
the `default` alias. `provider` is the gateway's provider slug: built-in (`openai`,
`google-ai-studio`, …) or `custom-<slug>`. It does the following:

- If the gateway has no Secrets Store, it attaches the account's store, creating one if the
  account has none. The key is kept in "the Secrets Store configured on the gateway".
- It deletes any key already stored for that provider and alias. The API has no update call, and
  a gateway holds one key per provider and alias.
- It then creates the provider config with `secret`.

The key is sent only in the request body, so it never appears in a log, a return value or an
error message (the client already guarantees that last point). `create-relationship-os --provider-key
together=…` (repeatable) calls it and maps a release custom provider's slug to `custom-<slug>`.
Settings → AI's key form (stage 7b) is meant to use it too: `@relationship-os/core` already depends on
`@relationship-os/release`. The provider slug a custom provider's key is stored under is not stated in the docs.
We use `custom-<slug>`, the name the gateway uses for the provider in URLs and model strings. If
that turns out wrong, the first real call shows a provider authentication error.

### API token permissions
| What | Permission (account) | Docs |
| --- | --- | --- |
| Create, read and update the gateway | AI Gateway Edit ("AI Gateway Write" in the API reference) | [create](https://developers.cloudflare.com/api/resources/ai_gateway/methods/create/), [get](https://developers.cloudflare.com/api/resources/ai_gateway/methods/get/) |
| Custom providers | AI Gateway Edit | [custom providers](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/) |
| Generate the gateway token | Account API Tokens Edit (Write) | [create account token](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/create/), [permission groups](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/subresources/permission_groups/methods/list/) |
| Store a provider key (BYOK) | Secrets Store Edit (Write) and AI Gateway Edit | [provider configs](https://developers.cloudflare.com/api/resources/ai_gateway/subresources/provider_configs/methods/create/), [stores](https://developers.cloudflare.com/api/resources/secrets_store/subresources/stores/methods/create/), [BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/) |
| Call the gateway (the generated token) | AI Gateway Run | [authentication](https://developers.cloudflare.com/ai-gateway/configuration/authentication/) |

The install token (and `ROS_UPDATE_TOKEN` for one-click updates) needs the first three on top of
ADR 0163's list, plus the fourth for `--provider-key`. An account-level resource in a token policy
is `com.cloudflare.api.account.<id>`
([create tokens via API](https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/)).

### Calling a custom provider
Through the unified OpenAI-compatible endpoint the request is
`https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/compat/chat/completions` with model
`custom-together/deepseek-ai/DeepSeek-V4.1-Flash-1017`. Through the provider-native endpoint it is
`…/{gateway}/custom-together/v1/chat/completions`, which proxies to
`https://api.together.xyz/v1/chat/completions`
([custom providers](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/),
[unified API](https://developers.cloudflare.com/ai-gateway/usage/chat-completion/)). The unified
page now calls the endpoint "deprecated" for standard single-model calls, though it "will
continue to work". The newer REST API (`/accounts/{id}/ai/v1/chat/completions`,
[REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/)) does not document
custom providers. Choosing the endpoint is stage 7b's call, in the registry.

All pages read 2026-11-05.

## Consequences
- A new install has logs, usage per role and BYOK with no manual steps. Upgrades of earlier
  installs add the gateway when the update token allows it.
- The install token asks for more: AI Gateway Edit and Account API Tokens Edit. Account API
  Tokens Edit can create other tokens, so a token that holds it should be kept to the CLI and not
  stored as `ROS_UPDATE_TOKEN` unless one-click updates are wanted. Without it, the gateway is
  still created. Only the token step is skipped, with a warning saying how to set
  `AI_GATEWAY_TOKEN` by hand.
- An update that fails after the token was generated rolls back. The token can then be left
  unused, because the state that records its id is rewound. It has only AI Gateway Run. Delete it
  in the dashboard if that matters.
- `scripts/deploy.mjs` (wrangler, from a checkout) does not create a gateway yet. Set
  `AI_GATEWAY_ID` and `AI_GATEWAY_TOKEN` by hand there.
- The manifest gains an optional `aiGateway` block. `MANIFEST_VERSION` stays 1: older CLIs ignore
  the block, and the new code treats a release without it as before.

> Amended 2026-11-05 ([ADR 0192](0192-deepseek-provider-and-model-role-presets.md)): **the
> Together custom provider no longer ships.** It existed only for the user's plan of DeepSeek on
> Together, which DeepSeek on its own platform replaces. DeepSeek is a **built-in** AI Gateway
> provider (slug `deepseek`), so it needs no custom provider. `aiGateway.customProviders` in
> `apps/app/deploy-inputs.json` is now empty. The mechanism above is unchanged and is tested with
> a fixture provider. An account that already has `custom-together` keeps it. `--provider-key`
> also records built-in providers in a new `AI_GATEWAY_BYOK` var, so the model registry knows
> the gateway holds their key, and `--model-roles` sets a deployment's `AI_MODEL_ROLES`.

> Amended 2026-11-05 ([ADR 0203](0203-gateway-first-model-registry.md)): **stage 7b chose the
> unified endpoint.** The registry calls third-party chat through
> `…/{gateway}/compat/chat/completions` with `provider/model` ids, and a role names a custom
> provider as `{ provider: "custom", model: "custom-<slug>/<model>" }`. Settings → AI's key form
> now uses `setGatewayProviderKey`, including for custom providers (`custom-<slug>`).

> Amended 2026-11-06 ([ADR 0330](0330-self-hosted-workers-ai-over-rest.md)): **the gateway token
> also holds Workers AI Read**, so self-hosted Workers AI can go over REST through the gateway with
> payload logging off. Generated tokens get AI Gateway Run and Workers AI Read; a token generated
> before (Run only) is replaced once, even while the Workers still hold it; a supplied token is
> checked by listing one Workers AI model with it. The installer sets `AI_GATEWAY_REST=true` on the
> gateway's Workers when the token can call Workers AI. A replaced token is now deleted only after
> the deploy succeeds (`retiredTokenId`), not during provisioning. "Workers AI calls through the
> `AI` binding ... need no token" still holds for installs without `AI_GATEWAY_REST`.
