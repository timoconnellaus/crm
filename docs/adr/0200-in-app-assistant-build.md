# ADR 0200: Building the in-app assistant

Status: accepted, 2026-11-05 (stage 7b build). Implements [ADR 0030](0030-in-app-assistant.md).
The reasoning-content decision is [ADR 0201](0201-assistant-reasoning-content.md).

## Context
ADR 0030 says the assistant is an MCP client of our own `/mcp`, runs as actor `assistant` under
the user's authority, with its loop in a Durable Object per conversation, and appears as a Cmd-J
panel, `/assistant`, "Ask AI" and "Ask about N selected". Stage 7a built the model registry
(ADR 0150) and the gateway-first routing came in ADR 0203. The cost rules forbid per-request D1
writes on hot paths and per-message alarms.

## Decision

### An MCP client of our own server, in process
- The conversation object builds the **same MCP server `/mcp` builds per request**
  (`createCrmMcpServer` in `apps/app/src/server/mcp/tools.ts`: curated tools,
  `describe_operations`, `call_operation`, server instructions) for a caller acting as actor
  `assistant`, and talks to it with the MCP SDK `Client` over `InMemoryTransport`
  (`apps/app/src/server/assistant/mcp-client.ts`). Tool names, descriptions, schemas, results and
  `pending_approval` envelopes are exactly what an external client sees.
- We do **not** go over HTTP to `/mcp`. That would need an OAuth token minted for the assistant and
  a connected app per user, and would add a network hop per tool call, for no difference in
  behaviour: the pipeline runs either way. The transport is the only difference.
- The invocation context is `/mcp`'s with three changes: `actor: "assistant"`; origin
  `{ surface: "assistant", sessionId: <conversation id> }` (a new origin surface); and no
  `grantedPermissions` (the person's role decides; there are no OAuth scopes). Writes count against
  `MCP_WRITE_RATE_LIMIT` keyed `assistant:<userId>`.
- The conversation id (`asc_…`) is the **MCP session**: its pending actions group in its change set
  and only its reads see them simulated (ADR 0022, ADR 0032). That is the "change set" ADR 0030
  gives the conversation.

### The gate
The assistant keeps **its own column** in the presets. Under Balanced it applies bulk writes of
up to 25 records (MCP queues every bulk write) because the person is in the conversation and sees
each change; Cautious and Autonomous match MCP. The approval test suite
(`packages/core/test/approval-suite.ts`) runs for both actors (stage 7 AC 3).

### The conversation object
- `AssistantConversation` (ros-app, `new_sqlite_classes`, binding `ASSISTANT`), named by the
  conversation id. SQLite tables: `meta` (the owner), `messages` (the AI SDK's model messages per
  turn), `turns` (status, model, error).
- One turn at a time. `startTurn` resolves the person from D1 (a deactivated account is refused),
  asks the registry for `chatModels("assistant")` (primary, then fallback), connects the MCP client,
  and runs `runAssistantTurn` (`packages/core/src/assistant/loop.ts`): AI SDK `streamText` with the
  MCP tools, at most 16 steps. The fallback is tried only if the primary failed before saying or
  doing anything, so a tool call never runs twice.
- **Resumable streaming.** Each turn's events (`turn-start`, `text`, `thinking`, `tool-call`,
  `tool-result` with any `pending`, `step`, `error`, `turn-end`) are numbered and kept in memory
  while it runs. `POST /api/assistant/turn` returns them as server-sent events; any reader can
  reconnect with `GET …/conversations/:id/stream?after=<seq>` and gets the rest. When the turn ends
  its messages and status are written in one transaction. A turn left `running` by an evicted
  object shows as interrupted.
- **No alarms**, and nothing runs when nobody is talking to it.
- D1 keeps only the list on `/assistant` (`core_assistant_conversation`, migration 0200): one row
  written when the conversation starts (`assistant.startConversation`) and one update per finished
  turn (`assistant.finishTurn`), both through operations. Never per token or tool call.
- The browser reaches it only through `/api/assistant/*` (`apps/app/src/server/assistant/http.ts`):
  the identity middleware resolves the Principal, `assistant.conversation` checks the conversation
  is theirs (the object checks its owner again), and writes must be same-origin.

### Context
The client sends `{ path, title?, record?, selection? }` with each turn. Record pages publish their
record (the "Ask AI" button does it), and every selectable list publishes up to 200 selected ids.
The instructions state them as machine-readable lines (`Current record: person per_…`,
`Selected records: organisation org_… org_…`), and labels are quoted as data, not instructions.

### Name and copy
The display name is `assistantName` in Settings → General (default "Assistant"); a name containing
"Claude" is refused. The instructions tell the model its name. No UI copy says "Claude".

### What it can do
Everything over MCP, so records, dashboards and widgets (`dashboard.create` / `widget.preview`
through `call_operation`), extensions, and automations. For automations the instructions ask for
a test-mode run of the proposal before it is approved: `automation.test` now takes
`proposal: { actionId, key }` (ADR 0133 amendment), and the chat shows the report inline. "Explain"
questions use `audit.listForRecord`, the timeline and automation runs.

### Local development and tests
With `AI_FAKE_MODEL=true` the `assistant` role is a scripted model
(`packages/core/src/assistant/fake.ts`): a fake OpenAI-compatible server driving the real AI SDK
provider, so the whole loop, the MCP client and the pipeline run without a model.

## Consequences
- ADR 0030's "one tool surface" holds by construction: a new curated tool is the assistant's too.
- A conversation's history is not erased by a person erase (ADR 0019): it lives in the object, not
  D1. Deleting a conversation (`assistant.deleteConversation` and the object's `deleteAll`) is the
  way to remove it. Recorded as a known limit. _(Superseded 2026-11-05: see the amendment below.)_
- An object evicted mid-turn (for example, every reader gone for minutes during a long tool loop)
  loses that turn's unsaved steps; the person sees "interrupted" and asks again. Tool calls already
  made stay made, and the next turn is told.
- The stage 2–5 evals run through the assistant with `EVAL_VIA=assistant` (stage 7 AC 5); no
  report against a real model exists yet.

## Amendment, 2026-11-05 (erase reaches conversations)
The known limit above is lifted. `assistant.finishTurn` takes the turn's `refs` (person and
organisation ids, hashed emails) and writes them to `core_assistant_conversation_refs` in its
batch (migration 0270), and the object has a `scrub` RPC that redacts an erased subject from its
stored messages, turn errors and a running turn. `person.erase` and `organisation.erase` use both
before they commit. The design, what is redacted and the limits are in
[ADR 0019](0019-audit-redaction-for-erasure.md)'s amendment of the same date.

## Amendment, 2026-11-06 (one thread per user)
The `AssistantConversation` object, the conversation list (`core_assistant_conversation`) and "no
alarms" are superseded by [ADR 0340](0340-one-assistant-thread-per-user.md): one
`AssistantAgent` thread per user on the Agents SDK, with alarms for compaction
([ADR 0341](0341-compaction-cost-model-and-cache-lifetime-learner.md)) and agent reminders. The
in-process MCP client, the assistant's column in the presets, the refs for erase and
`EVAL_VIA=assistant` carry over. The `assistant` model role becomes `assistant.core`
([ADR 0351](0351-assistant-model-roles.md)).
