# ADR 0192: The DeepSeek provider, per-deployment model role presets, and no shipped custom provider

Status: accepted, 2026-11-05. Amends ADR 0150 (role requirements), ADR 0151 (where the runner
learns a key is BYOK) and ADR 0180 (the shipped Together custom provider is gone).

## Context
The user decided that **their own deployment** runs every model role except `embed` on
**DeepSeek V4.1 Flash on the DeepSeek platform**. That covers build, assistant, summarise,
extract, classify, vision and review. Workers AI is each role's fallback. `embed` stays on
Workers AI (bge-small, 384 dims), because DeepSeek has no embedding model. Calls go through AI
Gateway, with the DeepSeek key stored there as BYOK (ADR 0180). This replaces their earlier plan
of DeepSeek on Together AI (`custom-together`).

**The shipped defaults do not change.** Every role still defaults to Workers AI (ADR 0009), so a
fresh install needs only Cloudflare. The DeepSeek choice is per-deployment config.

## Decision

### The `deepseek` provider
AI Gateway has DeepSeek **built in**, with provider slug `deepseek`. Its native endpoint is
`https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/deepseek/chat/completions`, and
BYOK works there: send `cf-aig-authorization` and no `Authorization` header, and the gateway adds
the stored key. On the newer unified endpoint the model is named `deepseek/{model}`
([DeepSeek provider](https://developers.cloudflare.com/ai-gateway/usage/providers/deepseek/),
[providers](https://developers.cloudflare.com/ai-gateway/usage/providers/), read 2026-11-05).
Because it is built in, **no custom provider** is needed.

`PROVIDER_INFO.deepseek` holds:
- the gateway slug `deepseek`;
- the direct base URL `https://api.deepseek.com` (OpenAI-compatible), used with no gateway;
- the Workers secret `AI_KEY_DEEPSEEK`.

The runner uses the gateway's provider-native path (`GATEWAY_PATHS.deepseek = "deepseek"`), like
every other provider (ADR 0150 does not use the unified endpoint). The provider is optional and
is never a shipped default.

### `deepseek-flash`: what was verified
The catalogue entry is based on probes of `https://api.deepseek.com` with a real key on
2026-11-05. The key was never printed or stored.

| Capability | Result |
| --- | --- |
| `GET /models` | `deepseek-flash`, named "DeepSeek-V4.1-Flash"; `context_window` 1,048,576; `max_output_tokens` 393,216; `input_modalities: ["text","image"]` |
| Tool calling | Works: `finish_reason: "tool_calls"`, with well-formed arguments |
| `response_format: json_object` | Works: valid JSON |
| `response_format: json_schema` | **Refused**: HTTP 400, "This response_format type is unavailable now" |
| Image input | Works: a 128×128 base64 PNG of solid red is answered "Red". On a 16×16 one, the model's reasoning called it white before the budget ran out, so very small images may be unreliable |
| `max_tokens` | Valid range is 1 to 393,216; 393,217 is refused |
| Thinking | On by default. Thinking tokens count against `max_tokens`: a 50-token budget was spent entirely on thinking, with empty content and `finish_reason: "length"`. `thinking: {"type":"disabled"}` turns it off. `reasoning_effort: "low"` is accepted |
| Multi-turn tool calls with thinking on | The API **requires `reasoning_content` to be passed back** on the assistant's tool-call turn: HTTP 400 without it. They work with thinking off |

`deepseek-flash` is an **alias that tracks DeepSeek's latest Flash model** (V4.1 Flash on that
date). The platform has no dated id, so its behaviour can change under the same name. The
catalogue records `toolUse`, `vision`, `jsonObject` (JSON mode) and a 1,048,576-token context.
It records **`jsonSchema: false`**. No price is recorded, because none was verified for this
alias.

### JSON output, modelled accurately
`build`, `extract`, `review` and `assistant` required `jsonSchema`, so `deepseek-flash` would
have been rejected for all four. But no code path sends `response_format: json_schema`:
- `widget.describe` (build) asks for JSON in the prompt, parses it, validates the widget and
  retries once;
- the runner's proposal summary (build) is plain text;
- `codemode:ai` extract parses the first JSON object in the reply;
- the assistant's structured output is its tool calls;
- the adjudicator (review, stage 7b) is not built yet.

So the requirement was stricter than the code. The registry now separates two capabilities:

- **`jsonObject`** (capability): JSON mode, `response_format: json_object`. `jsonSchema` implies
  it.
- **`json`** (requirement): the caller parses and validates JSON itself, so JSON mode or a
  schema-constrained model will do. `build`, `extract` and `review` require `json`.
- **`jsonSchema`** (requirement) is kept for a role that actually sends a schema. No role does
  today.
- `assistant` requires tool use and no JSON capability.

Every catalogued Workers AI model has `jsonSchema`, so nothing that passed before fails now. A
model with neither capability is still rejected for the JSON roles. **If stage 7b sends a
schema** (for example, for the adjudicator's verdict), that role must require `jsonSchema` again.
`deepseek-flash` will then be rejected for it, and the role will run on its fallback or the
shipped default. Settings → AI shows "JSON schema" and "JSON mode" badges, and the custom-model
form has both checkboxes.

### Thinking, as a role param
`params.thinking` (optional boolean) switches a reasoning model's thinking off where the provider
supports it. For `deepseek` the runner sends `thinking: {"type":"disabled"}` through the AI SDK's
provider options; other providers, including the Workers AI fallbacks, ignore it. The role's
**Test** button always turns thinking off, because its 16-token budget would otherwise be spent
thinking.

### Presets: per-deployment model roles
`ROLE_PRESETS` in `packages/core/src/ai/roles.ts` holds named deploy layers. The first is
**`deepseek-flash`**:

| Role | Model | Fallback (Workers AI, the shipped default) | Params |
| --- | --- | --- | --- |
| build | deepseek-flash | llama-3.3-70b-instruct-fp8-fast | 1,200 tokens, 0.1, thinking off |
| assistant | deepseek-flash | kimi-k2.6 | 8,000 tokens, 0.2, thinking on |
| summarise | deepseek-flash | glm-4.7-flash | 500 tokens, 0.2, thinking off |
| extract | deepseek-flash | glm-4.7-flash | 512 tokens, 0, thinking off |
| classify | deepseek-flash | granite-4.0-h-micro | 64 tokens, 0, thinking off |
| vision | deepseek-flash | llama-4-scout | 800 tokens, 0.1, thinking off |
| review | deepseek-flash | gpt-oss-120b | 4,000 tokens, 0, thinking on |
| embed | *(unchanged: bge-small-en-v1.5, 384 dims)* | none | |

Thinking is off for short, direct answers. Those callers pass small budgets, some as low as 64
tokens, and thinking would spend them before the answer. The assistant and the reviewer keep
thinking, with larger budgets.

**How a deployment chooses it.** We reuse what exists: the deployment state's per-Worker `vars`,
which the installer, `ros upgrade` and the self-updater already keep.
- `create-relationship-os --model-roles <preset | file.json | inline JSON | default>` checks the value
  strictly (`modelRolesVar`). Bad JSON, an unknown role, or a model or fallback the role would
  reject fails the install, rather than being dropped at run time the way `parseRoleLayer` drops
  it. The result is stored as `AI_MODEL_ROLES` on every Worker that declares it (ros-app and
  ros-runner, from the manifest's new `AI_MODEL_ROLES` input). Re-runs and upgrades keep it, and
  `default` clears it.
- `scripts/deploy.mjs` (wrangler, from a checkout) reads `ROS_AI_MODEL_ROLES` with the same
  values and writes it into the git-ignored `wrangler.deploy.jsonc` for both Workers. Nothing is
  committed.
- Settings → AI overrides (the admin layer) still win, role by role.

### BYOK the registry can see: `AI_GATEWAY_BYOK`
`create-relationship-os --provider-key deepseek=…` stored the key in the gateway. But the runner treated a
provider as BYOK only when D1's `ai_settings.byok` listed it, which is set by Settings → AI. A key
stored by the installer therefore looked missing: the provider showed "No key", and because
`AiNotConfiguredError` does not trigger the fallback, every role on it would fail. A new
deploy-config var fixes this:
- **`AI_GATEWAY_BYOK`** is a comma-separated list of registry providers whose key the gateway
  holds. It is declared on both Workers (empty by default) and joins `ai_settings.byok`.
- `--provider-key` adds the registry provider for a built-in gateway slug: `deepseek` →
  `deepseek`, `google-ai-studio` → `google`. A custom provider (`custom-<slug>`) is not a
  registry provider, so it is left out.
- `scripts/deploy.mjs` takes it from `ROS_AI_GATEWAY_BYOK`.

The var names providers only. It never holds a key.

### No shipped custom provider
The `together` entry in `apps/app/deploy-inputs.json` `aiGateway.customProviders` existed only
for the user's old Together plan, and DeepSeek on its own platform replaces it. **It is
removed**, and the list ships empty. The mechanism stays: `checkAiGateway`, provisioning, BYOK
for `custom-<slug>`, and the tests, which now use a fixture provider (`example-llm` →
`https://llm.example.com`). A deployment that already created `custom-together` keeps it: we
never delete account-wide providers.

## Consequences
- The user's deployment needs one command (`docs/deploying.md`, "Using DeepSeek for every
  role"). Every other deployment is unchanged.
- **Known trade-off: the `review` role loses its independence.** ADR 0031 wants the policy
  adjudicator on a different model from the acting actor's. The shipped defaults keep them
  apart: the assistant is on Kimi K2.6 and review is on gpt-oss-120b. With this preset both are
  `deepseek-flash`, so the adjudicator judges the assistant's changes with the same model and
  shares its blind spots. ADR 0031 is unchanged. Before the adjudicator leaves shadow mode on
  this deployment, consider overriding `review` in Settings → AI (for example, back to
  gpt-oss-120b) or using Jev, and watch the agreement rate.
- **Stage 7b notes.**
  - With thinking on, the assistant's tool loop must keep each step's reasoning. Within one AI
    SDK `generateText` call this already happens: `@ai-sdk/openai-compatible` sends
    `reasoning_content` back. A conversation stored as plain text, however, must keep the
    reasoning parts of any turn that ends in tool calls, or turn thinking off for the assistant.
  - Any role that switches to `json_schema` must require it again (above).
- An empty reply caused by `finish_reason: "length"` is not an error, so it does not trigger the
  fallback. The preset's budgets and thinking switches are set so that this should not happen.
- `deepseek-flash` can change behind its alias. The capability table is dated and should be
  probed again if DeepSeek announces a new Flash.
- The release manifest gains two `var` inputs (`AI_MODEL_ROLES`, `AI_GATEWAY_BYOK`), and its
  `aiGateway.customProviders` is now empty. `MANIFEST_VERSION` stays 1. Older CLIs ignore the
  inputs, and vars not declared in a manifest were always passed through.
- `create-relationship-os` now bundles `@relationship-os/core/ai-roles` (pure data and functions), so it uses the same
  registry, presets and checks as the app.

> Amended 2026-11-05 ([ADR 0203](0203-gateway-first-model-registry.md)): with a gateway, DeepSeek
> is now called through the unified endpoint as `deepseek/deepseek-flash`
> (`…/{gateway}/compat/chat/completions`), not the provider-native `…/{gateway}/deepseek` path;
> the `thinking` body field is sent the same way. The review-independence trade-off above is now
> shown as a non-blocking warning on the review role in Settings → AI (`reviewIndependence`).
