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
