# ADR 0042: Code Mode

Status: accepted, 2026-11-04 (stage 3b build). Refines ADR 0025's Code Mode bullet.

## Context
MCP tools are one call at a time. Some work is a loop or a join ("tag everyone at Acme who came to
the offsite", "which organisations have no activity this quarter"), and a model does it better as a
short program than as dozens of tool calls. ADR 0025 decided a single `code` tool whose scripts run
as the connected user's `mcp` actor, under the same gate and simulation. The build had to decide
how the script reaches operations, as whom, and within what limits.

## Decision
- **Operation and tool.** `code.run` is an operation (actors `mcp` and `assistant`, permission
  `records:read`, `bookkeeping` so the call itself is never queued, input redacted in the audit
  log). It is the curated MCP tool `code` (new `mcp.toolName`). Its description is written for the
  model, with a complete example and the advice to use one `*Many` operation for many records.
- **Where it runs.** The app calls `ExtensionHost.runCode` on crm-runner. The workspace DO
  transpiles the script (TypeScript allowed, sucrase), allows only `import … from "codemode:crm"`
  (rewritten to a wrapper whose `crm.call` returns values and throws errors with `code` and
  `details`), writes it under `/code/<uuid>/`, and runs an entry module in a Dynamic Worker with
  `globalOutbound: null`, read-only filesystem access and the same `codemode:crm` host module
  extensions use. The entry captures `console.*` and returns the default export (awaited, called
  when it is a function) as JSON.
- **As whom.** The DO's current-run context carries the caller (actor, user, origin with the MCP
  session, granted scopes, reason) instead of an extension. `codemode:crm` then invokes the
  pipeline exactly as `callForMcp` would: role ∩ scopes, the gate, simulation overlay for the
  session's reads, and a `review` decision queues a pending action in the caller's change set with
  the script's reason. A queued call returns its `pending_approval` result rather than throwing,
  and the run's result lists every pending action. Scripts cannot call `extension.*`, `x.*` (the
  runtime is busy running the script) or `code.run`.
- **Limits.** 30 s, 100 operation calls, 200 log lines (2,000 characters each) and a 256 KB result
  (larger results are replaced by a preview and a note). Runs are serialised with extension runs in
  the one workspace DO.
- **Audit.** The `code.run` call is audited (summary: ok, operations, pending); every operation the
  script calls is audited on its own as actor `mcp`, as if called as a tool.

## Consequences
- AC8 holds by construction: a script tagging 30 people through `person.updateMany` is one
  bulk-write pending action in the caller's change set, and the script's later `person.get` sees
  the tags (tested in `apps/runner/test/code-mode.test.ts`).
- A script looping over single updates gets the same per-call decisions as tool calls, so the
  description steers models to `*Many` operations.
- Code Mode shares the extension DO's serial queue; a long script delays extension tools. Sharding
  executions (ADR 0040) fixes both.
