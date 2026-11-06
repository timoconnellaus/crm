# ADR 0340: One assistant thread per user, in an `AssistantAgent` Durable Object on the Agents SDK

Status: Accepted (2026-11-06). Stage 17 spec: [`docs/stages/17-assistant.md`](../stages/17-assistant.md),
W1. Supersedes the per-conversation object of [ADR 0030](0030-in-app-assistant.md) and
[ADR 0200](0200-in-app-assistant-build.md). [ADR 0201](0201-assistant-reasoning-content.md)
(reasoning content kept and replayed) still holds.

## Context
Stage 7b built the assistant as one `AssistantConversation` Durable Object per conversation, with a
conversation list in D1 (`core_assistant_conversation`) and no alarms. In the stage 17 interview
the user asked for one assistant and one chat per person that never resets: it remembers what
matters, works on its own when asked, runs longer work in the background and can be talked to.
A list of conversations works against that. Each new conversation starts with no context, and
memory, routines and background work need a single place to report to.

The Agents SDK (`agents@0.33.0`, already a dependency of `apps/app`) gives a Durable Object base
class with hibernatable WebSockets, resumable streams, scheduling on alarms, SQLite helpers and
the voice module that ADR 0349 uses. The hand-rolled object would need all of these.

## Decision
1. **One thread per user.** `AssistantAgent extends Agent`, named `idFromName("user:" + userId)`,
   in ros-app. There is no reset and no conversation list. `/assistant` is a full-page view of the
   same thread the docked sidebar shows.
2. **Storage in the object's SQLite**: messages with `seq`, `role`, `via` (`text`, `voice`,
   `dictation`, `routine`, `agent`, `connected`), `parts` (text, reasoning, tool calls, A2UI,
   notices), `playout` (`spoken`, `partly_spoken` with `unsaid`, `unspoken`) and `deletedAt`;
   turns; compactions (ADR 0341); pending memory lines (ADR 0342); an FTS5 index over message
   text; the unread count; and the jobs it started (ADR 0344).
3. **Transport.** Chat frames, stream resumption and voice audio go over one hibernatable
   WebSocket. The HTTP routes stay for evals and MCP-style clients: `POST /api/assistant/turn`
   now runs against the single thread.
4. **Tools and authority are unchanged.** The turn is still an in-process MCP client of
   `createCrmMcpServer`, acting as actor `assistant` for the signed-in person. The MCP session id
   becomes the thread id.
5. **D1** keeps `core_assistant_thread` (one row per user: last activity, unread count, compaction
   state), written once per finished turn, and the refs table keyed by thread, so erase still finds
   what to redact (ADR 0019 amendment, ADR 0320).
6. **Search and delete.** The model searches older messages with `thread.search`, and the person
   searches them in the UI. `thread.deleteMessage` removes a message from the thread and the
   index, and deletes memory lines whose `sourceMessageSeq` is that message.
7. **Page context** (page, record, selection) travels with each turn as a tail block, never in
   the cached prefix (ADR 0341).
8. **Existing conversations are dropped.** There are no real users yet. A migration in block N
   deletes `core_assistant_conversation` rows; the table goes in a later cleanup migration.

## Why
- One thread is what the user asked for, and it gives memory, routine messages, agent results and
  connected-assistant notices one home.
- The Agents SDK provides the WebSocket, resumable streaming, alarms and voice the design needs,
  maintained upstream.
- Keeping the MCP client in process keeps ADR 0030's "one tool surface" by construction.

## Consequences
- The thread grows without end, so compaction (ADR 0341) and search are required parts of the
  design.
- Alarms now exist on the assistant object: compaction before cache expiry, reminders for pending
  agent changes, and delivery. Each is scheduled only when there is work, within the cost rules.
- The conversation list UI and the `assistant.startConversation` and
  `assistant.deleteConversation` operations go away. Deleting a single message replaces deleting
  a conversation.
- The Agents SDK is a runtime dependency of the core assistant path. It is pinned and wrapped in
  `agent-core` (ADR 0350) so an upstream change is absorbed in one place.

## Alternatives considered
- **Keep per-conversation objects and add memory across them.** Rejected: context still restarts
  with each conversation, and routine messages and agent results have no obvious home.
- **One object per user holding many conversations.** Rejected: the same split for the person,
  with more code.
- **Store the thread in D1.** Rejected: per-message D1 writes break the cost rules, and the turn
  needs a single writer anyway.
- **Keep the hand-rolled object and add WebSockets and alarms ourselves.** Rejected: it rebuilds
  what the Agents SDK already ships, including the voice module.
