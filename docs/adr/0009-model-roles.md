# ADR 0009: Model roles

Status: accepted, 2026-11-04 (stage 0 architecture interview).

## Decision
- Code asks for a **model role**, never a model: `build`, `assistant`, `summarise`, `extract`, `classify`, `embed`, `vision`, `review`.
- The core model registry maps each role to a provider + model, params and a fallback.
- Each role declares the capabilities it requires (tool use, JSON schema, context size, vision). The registry rejects models that lack them.
- Providers include Workers AI, Anthropic, OpenAI, Google, OpenRouter and Jev (for `review`). All calls go through AI Gateway. Keys are Worker secrets or Gateway BYOK, never stored in D1.
- Configuration is layered: shipped defaults → deploy config → in-app admin overrides (Settings → AI).
- Shipped defaults:
  - `build` and `assistant`: Claude
  - bulk roles: a fast, cheap model
  - `embed`: Workers AI, which works with no keys
- A provider-agnostic client library sits under the registry. Choose between TanStack AI and the AI SDK in the stage that first needs it.
