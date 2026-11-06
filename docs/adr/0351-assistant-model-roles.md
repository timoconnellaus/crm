# ADR 0351: Assistant model roles, per-role settings, and prices and cache lifetimes in the registry

Status: Accepted (2026-11-06). Stage 17 spec: [`docs/stages/17-assistant.md`](../stages/17-assistant.md),
W10. Amends the role list of [ADR 0009](0009-model-roles.md) and
[ADR 0150](0150-model-role-registry-and-ai-sdk.md); routing stays as in
[ADR 0203](0203-gateway-first-model-registry.md).

## Context
Stage 7 has one `assistant` role. Stage 17 has a front agent that should answer fast, agents that
do longer work and may want a different model, speech in and out, and a dictation cleanup that
must be quick. The compaction planner (ADR 0341) needs prices for uncached input, cache writes,
cached reads and output, and a model's published cache lifetime. The registry has
`price: { input, output }` only. Roles also need settings such as thinking and output limits; a
fixed "thinking off" would lose quality on models that do better with it.

## Decision
1. **Roles.** Replace `assistant` with:
   - **`assistant.core`**: the front agent (ADR 0344);
   - **`assistant.subagent`**: the default for agents; a profile may name another role;
   - **`transcribe`**: speech-to-text (AssemblyAI streaming, ADR 0349);
   - **`speak`**: text-to-speech (ElevenLabs, ADR 0349);
   - **`dictation.cleanup`**: the dictation cleanup pass, no thinking.
2. **Migration.** Existing `assistant` config maps to `assistant.core`: a migration rewrites
   `ai_settings`, and `AI_MODEL_ROLES` still accepts the old key with a deprecation warning.
   ADR 0031's warning when `review` shares the assistant's model now compares with
   `assistant.core`.
3. **Per-role settings**: thinking (off, on, or a level), max output tokens and temperature, set
   per deployment and in Settings → AI. Thinking is never forced off; `dictation.cleanup` ships
   with it off.
4. **Agent profiles may name another role, never a model.**
5. **Prices and cache metadata.** Each model in the registry gains
   `price: { input, cacheWrite, cachedInput, output }` (per million tokens) and an optional
   `cacheLifetimeSeconds` where the provider publishes one. Unknown cache prices mean cached input
   is treated as uncached. The planner reads these for the role's resolved model; the learner
   (ADR 0341) fills in lifetimes that are not published.
6. **Speech roles** use their own capability checks (streaming audio in, or voices out) and price
   units (seconds of audio, characters).
7. **This deployment's settings** (every text role on one model) stay as configured; the shipped
   defaults are unchanged.

## Why
- Separate roles let a deployment run a fast front agent and a stronger agent model, or the same
  model for both.
- Settings per role are where thinking and output limits belong; code still asks for a role.
- The planner cannot price compaction without cache prices.

## Consequences
- Every place that asks for `assistant` moves to `assistant.core`, and the evals' `EVAL_VIA=assistant`
  runs against it.
- Settings → AI lists five more roles and their settings.
- Price data needs upkeep as providers change prices; unknown values degrade safely.

## Alternatives considered
- **Keep one `assistant` role.** Rejected: agents and the front agent want different trade-offs.
- **Name models in agent profiles.** Rejected: code asks for a role, never a model.
- **Force thinking off for the assistant.** Rejected by the user: some models do better with it.
- **Speech outside the registry.** Rejected: one place to choose providers, check capabilities and
  show spend.
