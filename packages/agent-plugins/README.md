# @relationship-os/agent-plugins

Assistant plugins: the `plugin.json` schema, import of the open Agent Plugins format (skills and
MCP servers), fingerprinting, the three-way diff, the merge-proposal protocol and scope resolution.

Part of the assistant packages described in
[ADR 0350](../../docs/adr/0350-agent-package-boundary.md). MIT licensed (see `LICENSE`), unlike the
rest of the repository. It may import only other `@relationship-os/agent-*` packages, `zod`, `ai`,
`agents` and React (as a peer); `pnpm lint` checks this.

A host declares its item kinds with `createKindRegistry` and supplies the storage; the CRM binding is
`packages/core/src/plugins/`.
