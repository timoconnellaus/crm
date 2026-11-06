# ADR 0348: Connected assistants work under a contract both people agreed, with Jev checking every message

Status: Accepted (2026-11-06). Stage 17 spec: [`docs/stages/17-assistant.md`](../stages/17-assistant.md),
W8. Builds on [ADR 0340](0340-one-assistant-thread-per-user.md),
[ADR 0345](0345-approvals-by-tap-typing-or-voice.md) and the judge
([ADR 0230](0230-jev-as-the-typed-judge.md)).

## Context
Colleagues hand work to each other: "ask Sam to add a follow-up task". Letting one person's
assistant act on another's records directly would bypass that person's authority and approval
policy. Free-form messages between assistants invite prompt injection: text in a customer's email
can end up in a message to someone else's assistant. Asking a person to approve every message
would bury them.

## Decision
1. **Same workspace only.** A person asks to connect (`assistantConnection.request`); the other accepts or
   declines.
2. **A contract in plain English.** The two assistants propose numbered rules, each tagged
   **Automatic**, **Asks you** or **Never**, shaped by what the people said and by their existing
   contracts (`contract.propose`). Both people approve. Either can change it by saying what they
   want different (`contract.update`).
3. **Narrow auto-accept.** A rule may auto-accept narrow, low-risk requests the person named
   ("add tasks Sam's assistant asks for to my list"), always within the approval policy. A message
   from another assistant never counts as approval of anything outside that.
4. **Every message is adjudicated** by the Jev placement `agent.message`, against the contract and
   for prompt injection, before delivery (`agentMessage.send`, internal). Blocked messages are
   logged with the verdict.
5. **Background by default.** Outcomes show as quiet lines in the chat ("Added a task from Sam's
   assistant · Undo"). The full log is under Assistant → Connected assistants
   (`agentMessage.log`).
6. **A display seam.** The harness emits the exchange as events, so another product, or a later
   version of this one, can show it live.

## Why
- A contract both people agreed is the boundary of what each assistant may ask, in words they
  wrote.
- Checking every message stops injected instructions crossing between people.
- Quiet outcome lines keep the person informed without a prompt per message.

## Consequences
- Each message costs one Jev call.
- Because every message must pass Jev, connected assistants need the judge. With it off, the
  build should keep messages from being delivered and say why.
- The operations are named `assistantConnection.request`, `.accept` and `.decline`, so they don't share the integration `connection.*` namespace ("Connection" means a gatekeeper account in `CONTEXT.md`).

## Alternatives considered
- **Direct access to the colleague's records through one's own assistant.** Rejected: it bypasses
  the colleague's approval policy.
- **Free-form messages with no contract.** Rejected: nothing to check them against.
- **A person approves every message.** Rejected: approval fatigue.
- **An open agent-to-agent protocol between workspaces** (such as A2A). Deferred: cross-workspace
  connections are out of scope, and within one deployment an internal operation is simpler. The
  channel seam leaves room for it.
