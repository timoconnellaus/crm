# ADR 0009: Model roles

Status: accepted, 2026-11-04 (stage 0 architecture interview).

## Decision
- Code asks for a **model role**, never a model: `build`, `assistant`, `summarise`, `extract`, `classify`, `embed`, `vision`, `review`.
- The core model registry maps each role to a provider + model, params and a fallback.
- Each role declares the capabilities it requires (tool use, JSON schema, context size, vision). The registry rejects models that lack them.
- Providers include Workers AI (the default for every role), OpenAI, Google, OpenRouter, Anthropic and Jev (for `review`), all optional except Workers AI. All calls go through AI Gateway. Keys are Worker secrets or Gateway BYOK, never stored in D1.
- Configuration is layered: shipped defaults → deploy config → in-app admin overrides (Settings → AI).
- Shipped defaults: **every role uses Workers AI**, so a deployment needs no third-party AI key. Admins can switch any role to another provider.
- A provider-agnostic client library sits under the registry. Choose between TanStack AI and the AI SDK in the stage that first needs it.

> Amended 2026-11-04: the project does not use Claude or Anthropic as a default provider. Every role defaults to Workers AI, and evaluation harnesses run through the same model-role layer (or an OpenAI-compatible endpoint), never a hard-coded vendor SDK.

> Amended 2026-11-05 (stage 7a): the registry is built ([ADR 0150](0150-model-role-registry-and-ai-sdk.md)).
> The client library is the AI SDK. Keys are Workers secrets or AI Gateway BYOK set from
> Settings → AI ([ADR 0151](0151-provider-keys-as-workers-secrets-or-byok.md)); usage and spend
> per role come from AI Gateway ([ADR 0152](0152-usage-and-spend-per-role.md)). The shipped
> defaults are listed in ADR 0150; every one is a Workers AI model.

> Amended 2026-11-05 ([ADR 0180](0180-ai-gateway-provisioned-per-deployment.md)): **all AI calls
> route through AI Gateway by default; keys via BYOK.** The installer and the updater create a
> gateway per deployment (logging and authentication on) and wire `AI_GATEWAY_ID` and
> `AI_GATEWAY_TOKEN`. Default models stay on Workers AI, reached through the gateway. Provider keys
> are stored in the gateway as BYOK rather than as Workers secrets. Providers the gateway does not
> have built in are custom providers (the first is `custom-together`).

> Amended 2026-11-05 ([ADR 0192](0192-deepseek-provider-and-model-role-presets.md)): DeepSeek
> is an optional provider, built in to AI Gateway, so no custom provider ships (`custom-together`
> is gone). A deployment can choose a **model role preset**, such as `deepseek-flash` for every
> role but `embed`. The shipped defaults are still Workers AI for every role.

> Amended 2026-11-05 ([ADR 0230](0230-jev-as-the-typed-judge.md), proposed with stage 11): **Jev
> is no longer a provider for a model role.** It answers typed questions with probabilities and
> writes no text, so it is the **judge**, a seam beside the registry: code asks the judge for a
> **placement** (such as `adjudicator.policy`), never a model, as it asks the registry for a role.
> The `jev` provider and the `judgement` capability leave the registry. The `review` role stays,
> for the adjudicator's LLM reviewer. Jev is reached through AI Gateway first (custom provider
> `custom-typesafe`), its key is BYOK or the Worker secret `TYPESAFE_API_KEY`, never D1, and its
> model is pinned in code because thresholds are calibrated per model version
> ([ADR 0231](0231-judge-calibration-and-replay.md)).
