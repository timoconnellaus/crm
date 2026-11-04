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
