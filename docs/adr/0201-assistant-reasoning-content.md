# ADR 0201: The assistant keeps reasoning content and replays it

Status: accepted, 2026-11-05 (stage 7b build). Follows the stage 7b note in
[ADR 0192](0192-deepseek-provider-and-model-role-presets.md).

## Context
The user's deployment runs the `assistant` role on DeepSeek V4.1 Flash (`deepseek-flash`) with
thinking on (the `deepseek-flash` preset, 8,000 tokens). Probed in #39: with thinking on, a
multi-turn tool conversation **must send each tool-call turn's `reasoning_content` back**, or the
API answers HTTP 400. The assistant's history outlives one request (ADR 0200), so whatever it
stores is what the next turn sends.

Two options: keep and replay the reasoning, or turn thinking off for the assistant.

## Decision
**Keep and replay.** Thinking stays on for the assistant, as the preset intends.
- The conversation object stores the AI SDK's model messages exactly as `streamText` returned them
  (`responseMessages`), reasoning parts included. `@ai-sdk/openai-compatible` sends an assistant
  message's reasoning parts as `reasoning_content`, so replaying the stored messages satisfies the
  rule.
- `messagesForModel` (`packages/core/src/assistant/history.ts`) keeps reasoning only on assistant
  messages that made tool calls (the ones the rule covers) and drops it from final text answers,
  which keeps prompts small. Old whole turns are dropped first when the history passes its budget;
  a turn is never split, so a tool call keeps its result.
- Providers that do not use reasoning ignore the parts (Workers AI's provider sends text only).

Thinking off was rejected: it is a quality trade the user did not ask for, and the store-and-replay
path costs nothing beyond keeping parts we already receive.

## Tests
`packages/core/test/assistant.test.ts` runs the loop against a fake OpenAI-compatible server that
**enforces DeepSeek's rule** (`fakeChatServer(…, { requireReasoningContent: true })`: 400 when an
assistant tool-call message lacks `reasoning_content` and thinking is not disabled), through the
real registry with the `deepseek-flash` preset:
- within one turn the second request carries the reasoning;
- a second turn built from the stored history succeeds and replays the first turn's reasoning;
- the control: the same history with reasoning stripped gets the 400.

## Consequences
- Stored conversations are larger by the reasoning text of tool-call turns.
- If DeepSeek later wants reasoning on every assistant message, the policy in `withReasoningPolicy`
  is the one place to change.
- Whether AI Gateway's compat endpoint passes `reasoning_content` through to DeepSeek unchanged is
  not verified against a real account (ADR 0203 lists it); the Test button and a first real
  conversation will show it.
