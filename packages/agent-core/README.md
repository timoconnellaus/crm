# @relationship-os/agent-core

One long-lived assistant thread per person, with no CRM in it. Models, tools, stores and channels
are injected by the host.

- `thread.ts`: the thread model. Messages with `seq`, `turn`, `role`, `via`, `parts`, `playout`
  and `deletedAt`, and their mapping to and from AI SDK model messages.
- `store.ts`: the message store interface, a SQLite store with an FTS5 search index (the shape of
  a Durable Object's `ctx.storage.sql`) and an in-memory store.
- `context.ts`: context assembly. A byte-stable prefix (instructions, tools, memory, the
  compaction note), the history since the compaction, and a per-turn tail. `prefixHash` lets a
  test prove the prefix did not change.
- `pending.ts`: pending memory lines, which ride in the tail until compaction folds them in.
- `unread.ts`: the unread count.
- `turn.ts`: the turn loop over injected models and tools, with fallback before anything happened.
- `channel.ts`: the channel seam (interface only).

The compaction planner and cache-lifetime learner live in `src/compaction/` (stage 17, W2).

Part of the assistant packages described in
[ADR 0350](../../docs/adr/0350-agent-package-boundary.md). MIT licensed (see `LICENSE`), unlike the
rest of the repository. It may import only other `@relationship-os/agent-*` packages, `zod`, `ai`,
`agents` and React (as a peer); `pnpm lint` checks this.
