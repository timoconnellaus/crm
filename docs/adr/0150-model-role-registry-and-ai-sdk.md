# ADR 0150: The model role registry and the AI SDK

Status: accepted, 2026-11-05 (stage 7a build). Implements ADR 0009. Replaces the minimal role
mapping of stages 3 and 4 (`modelFor` in `packages/core/src/models.ts`, ADR 0059's
`modelRunnerFromEnv`).

## Context
Until now each AI feature resolved its own role with a hard-coded Workers AI model:
`codemode:ai` and proposal summaries in ros-runner, "Describe a widget" in ros-app, and a
`DEFAULT_MODEL` constant in the eval harness. Two of those defaults
(`@cf/meta/llama-3.1-8b-instruct-fast`) are no longer in the Workers AI catalogue: their model
pages now redirect to "Model not available … deprecated, removed, or not found"
([models](https://developers.cloudflare.com/workers-ai/models/)). Stage 7 needs every role,
other providers, capability checks and admin overrides.

## Decision

### The registry (`packages/core/src/ai/roles.ts`)
- **Roles** stay ADR 0009's: `build`, `assistant`, `summarise`, `extract`, `classify`, `embed`,
  `vision`, `review`. Each declares **requirements** (`ROLE_REQUIREMENTS`): chat, tool use, JSON
  schema output, vision, embeddings, a minimum context window. `review` also accepts a
  typed-judgment model (Jev).
- **A model catalogue** (`MODEL_CATALOGUE`) records capabilities of known models. Workers AI
  entries come from each model's page (function calling, vision, context window) and its
  `sync-input.json` (`response_format` with `json_schema`), read 2026-11-05: for example
  [gpt-oss-120b](https://developers.cloudflare.com/workers-ai/models/gpt-oss-120b/) (128k, tools),
  [llama-3.3-70b-instruct-fp8-fast](https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/)
  (24k, tools), [llama-4-scout](https://developers.cloudflare.com/workers-ai/models/llama-4-scout-17b-16e-instruct/)
  (131k, tools, vision), [bge-small-en-v1.5](https://developers.cloudflare.com/workers-ai/models/bge-small-en-v1.5/)
  (384 dims, 512 tokens, 100 texts per call). A model the catalogue does not know (a custom
  endpoint) must **declare** its capabilities; otherwise it is rejected.
- **Capability checks** (`capabilityProblems`, `assertCapable`) run when an admin saves a role
  (`ai.updateRole` refuses with the problems listed), when a layer is resolved (an unsuitable
  deploy or admin layer is ignored and reported, never half-applied), for fallbacks, and in the
  Test button. The `embed` role must also produce exactly the Vectorize index's dimensions
  (`VECTORIZE_DIMENSIONS`), because an index's size is fixed at creation
  ([create indexes](https://developers.cloudflare.com/vectorize/best-practices/create-indexes/)).
- **Layers**: shipped defaults → deploy config (`AI_MODEL_ROLES`, JSON on both Workers) → admin
  overrides (`core_settings.ai_settings`, written by `ai.updateRole`). Each layer may set
  provider, model, params and fallback. The admin layer holds settings only, never keys
  (ADR 0151).
- **Shipped defaults, all Workers AI** (pricing from
  [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), USD per M
  input/output tokens):

  | Role | Model | Fallback | Why |
  | --- | --- | --- | --- |
  | build | llama-3.3-70b-instruct-fp8-fast | gpt-oss-120b | proven on "Describe a widget" (stage 4a evals) |
  | assistant | kimi-k2.6 | gpt-oss-120b | the eval harness's model (multi-turn tools, 262k); needs Workers Paid |
  | summarise | glm-4.7-flash | gpt-oss-20b | $0.06 / $0.40, 131k context |
  | extract | glm-4.7-flash | gpt-oss-20b | JSON schema, cheap |
  | classify | granite-4.0-h-micro | glm-4.7-flash | $0.017 / $0.112 |
  | embed | bge-small-en-v1.5 (384) | none | cost audit U9: 384 dims; `text[]` batches of 100 |
  | vision | llama-4-scout | none | vision + tools |
  | review | gpt-oss-120b | llama-3.3-70b | a different family from the assistant's default |

  No role defaults to Anthropic or any third party. Anthropic is listed only as an optional
  provider an admin can configure.

### Providers
`workers-ai` (the `AI` binding), `openai`, `google`, `openrouter`, `anthropic` (optional),
`jev` (stage 7b's adjudicator) and `openai-compatible` (any endpoint; base URL from
`AI_PROVIDERS`). Every non-Workers-AI provider is called through its OpenAI-compatible chat API.

### AI Gateway
When `AI_GATEWAY_ID` is set, every call goes through it:
- Workers AI: the binding's `gateway: { id, metadata: { role } }` option
  ([binding methods](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/)).
- Other providers: the gateway's provider-native path
  (`https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/{openai|google-ai-studio|openrouter|anthropic}/…`,
  [providers](https://developers.cloudflare.com/ai-gateway/usage/providers/)) with
  `cf-aig-metadata: {"role": …}` ([custom metadata](https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/))
  and, for an authenticated gateway, `cf-aig-authorization` from the `AI_GATEWAY_TOKEN` secret
  ([authentication](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)).
  The exact sub-paths for Google's and Anthropic's OpenAI-compatible APIs behind the gateway are
  our reading of the provider docs, not stated on the gateway page; a wrong path shows up in the
  Test button.
- We do not use the unified `/compat/chat/completions` endpoint: the docs now mark it
  "deprecated for single-model calls" ([chat completion](https://developers.cloudflare.com/ai-gateway/usage/chat-completion/)).

### The client library: the AI SDK
We use the AI SDK (`ai` 7.x) with `workers-ai-provider` (Cloudflare's provider for the `AI`
binding) and `@ai-sdk/openai-compatible`, rather than TanStack AI.
- The AI SDK has a maintained Workers AI provider that speaks the binding (no API token in the
  Worker) and the gateway option, an OpenAI-compatible provider that covers every other provider
  we list with one code path, `embedMany` with per-model batch limits, and tool calling and
  streaming that the stage 7b assistant will need.
- TanStack AI (1.x) is newer, and we would have had to write the Workers AI adapter ourselves.
- Versions are pinned to releases at least two weeks old. `workers-ai-provider` lists the
  Anthropic, OpenAI and Google AI SDK packages as **optional** peers; we install none of them.

### The runner (`packages/core/src/ai/client.ts`)
`createModelRunner({ env, loadSettings, fetch?, fakes? })` returns a `ModelRunner`:
`run(role, messages)`, `embed(texts)`, `roles()` (the resolved registry) and `test(role, ref?)`.
The admin layer loads once per runner (one `core_settings` read, only when AI is used). A failure
of the primary model tries the fallback once. `modelRunnerFromEnv` builds one when the Worker has
an `AI` binding or another provider configured. ros-app passes it to operations as `ctx.models`;
ros-runner uses the same registry for `codemode:ai` and proposal summaries (`runnerModels`). The
eval harnesses take their default model from the registry (`@relationship-os/core/ai-roles`,
`shippedModel("assistant")`), so no harness hard-codes a vendor.

## Consequences
- Switching a role is a setting, not a deploy (AC 1's swap test: `summarise` on an
  OpenAI-compatible fake, through deploy config and through an admin override).
- The summarise default changed model, so summaries cached by stage 3 code paths (proposal
  summaries are keyed by commit, not model) are unaffected; the new summary cache hashes the model
  (ADR 0153).
- The AI SDK costs bundle size: ros-runner's main module grew from 3,368 KiB to about 4,460 KiB
  (unminified), so its budget in `apps/runner/scripts/bundle-budget.mjs` rose from 4,096 to
  5,120 KiB. The TypeScript compiler still lives only in the checker's Text module. If cold
  starts suffer, the runner could load the SDK lazily or call ros-app for model roles.
- Deprecated Workers AI models are a recurring risk: the catalogue is data, and a role whose model
  disappears falls back once and shows the error in Settings → AI.

> Amended 2026-11-05 ([ADR 0180](0180-ai-gateway-provisioned-per-deployment.md)): **all AI calls
> route through AI Gateway by default; keys via BYOK.** `AI_GATEWAY_ID` is no longer optional in
> practice: `create-relationship-os` and the updater set it to a gateway they create (`--ai-gateway off` opts
> out), along with a generated `AI_GATEWAY_TOKEN`, so the "When `AI_GATEWAY_ID` is set" paths
> above are the default. Custom providers (`custom-together` for Together AI) are created from
> `deploy-inputs.json`. Stage 7b makes the registry gateway-first, including addressing models
> as `custom-<slug>/<model>`.

> Amended 2026-11-05 ([ADR 0192](0192-deepseek-provider-and-model-role-presets.md)): a
> `deepseek` provider (built in to AI Gateway) and a `deepseek-flash` catalogue entry. The JSON
> requirement now matches the code: `build`, `extract` and `review` need **JSON output**, which
> JSON mode (`jsonObject`) or a schema satisfies, because no caller sends `json_schema`. The
> `assistant` needs tool use only. `params.thinking` switches a reasoning model's thinking off.
> **Model role presets** (`ROLE_PRESETS`) are ready deploy layers that one deployment picks
> with `create-relationship-os --model-roles <name>`. The shipped defaults are unchanged.
