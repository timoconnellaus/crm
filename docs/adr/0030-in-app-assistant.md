# ADR 0030: In-app assistant

Status: accepted, 2026-11-04 (stage 7 interview).

## Decision
- The **Assistant** is an MCP client of our own `/mcp`, running as actor `assistant` under the user's authority, with its agent loop in a Durable Object per conversation. It is model-agnostic: it uses the `assistant` role, is named "Assistant" by default and can be renamed per deployment, and is never called "Claude" in the UI.
- It is context-aware (page, record, selection) and appears as a Cmd-J panel, as `/assistant`, through "Ask AI" on records, through "Ask about N selected", and through every "Ask the assistant" link.
- It can work records and build dashboards, extensions and automations, with test mode shown inline. Every write follows the same gate, change sets and simulation as MCP.

## Why
One tool surface to design, test and evaluate. Anything the assistant can do, an external MCP client can do, and vice versa.

> Amended 2026-11-05 ([ADR 0200](0200-in-app-assistant-build.md), [ADR 0201](0201-assistant-reasoning-content.md)):
> built in stage 7b. The assistant is an MCP client of the same server `/mcp` builds, connected
> in process rather than over HTTP; the conversation id is its MCP session; under Balanced it keeps
> its own policy column (bulk writes up to 25 apply). Its history keeps reasoning content and
> replays it, so DeepSeek's thinking mode works.

> Amended 2026-11-06: the Cmd-J panel is no longer a sheet. On tablets and desktops (≥ 768 px) it
> is a **persistent sidebar docked on the right of the app shell**: the page reflows narrower
> beside it (nothing is overlaid), it stays mounted across page changes with the same
> conversation, scroll position, streaming reply and draft, and it updates its page context as
> the person moves, shown as an "On: …" chip. It is resizable from its left edge (drag or arrow
> keys, 288–720 px, giving way so the page keeps 320 px), and its width and open state are
> remembered per browser. On phones it stays a full-screen sheet. `/assistant` is unchanged.

> Amended 2026-11-06 ([ADR 0340](0340-one-assistant-thread-per-user.md), stage 17 spec): the
> Durable Object per conversation is superseded. Each person has one thread in one
> `AssistantAgent` object on the Agents SDK, with no reset and no conversation list; `/assistant`
> is a full-page view of that thread. The assistant is still an MCP client of our own server, in
> process, acting as actor `assistant`.
