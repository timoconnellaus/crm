# @relationship-os/agent-a2ui

A2UI cards for an assistant: the schema (zod), the catalogue registry and its versioning, text
fallbacks, and a React renderer that takes an injected component map and action handler.

Part of the assistant packages described in
[ADR 0350](../../docs/adr/0350-agent-package-boundary.md). MIT licensed (see `LICENSE`), unlike the
rest of the repository. It may import only other `@relationship-os/agent-*` packages, `zod`, `ai`,
`agents` and React (as a peer); `pnpm lint` checks this.

Status: a placeholder. The catalogue arrives with stage 17, W6.
