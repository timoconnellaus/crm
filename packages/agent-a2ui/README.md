# @relationship-os/agent-a2ui

A2UI cards for an assistant: the schema (zod), the catalogue registry and its versioning, text
fallbacks, and a React renderer that takes an injected component map and action handler.

Part of the assistant packages described in
[ADR 0350](../../docs/adr/0350-agent-package-boundary.md). MIT licensed (see `LICENSE`), unlike the
rest of the repository. It may import only other `@relationship-os/agent-*` packages, `zod`, `ai`,
`agents` and React (as a peer); `pnpm lint` checks this.

Three entries, so a Worker never loads React:

- `@relationship-os/agent-a2ui`: the catalogue, `validateDocument`, `prepareCard` (a card ready to
  store, with its fallback), `catalogueGuide` (the catalogue as a model reads it) and the saved
  producer registry.
- `@relationship-os/agent-a2ui/react`: `A2uiView`, which validates a card again before drawing it,
  and `useA2uiAction`.
- `@relationship-os/agent-a2ui/samples`: one sample of every component, for hosts' tests.

To add a component: define it in `src/catalogue.ts` with `since` set to a new catalogue version, add
a sample, and add a renderer to each host's component map.
