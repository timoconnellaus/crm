# ADR 0025: Extension authority and runtime

Status: accepted, 2026-11-04 (stage 3 interview).

## Decision
- Runtime extension source lives in an `@cloudflare/computer` Workspace in a DO in `crm-runner`. Git provides versions, diffs and rollback. Code runs in the `worker-javascript` backend with `globalOutbound: null`.
- **Shipped extensions** run through the same runtime and permission model. There is no static fast path.
- Each extension runs as principal `extension:<id>`, with permissions declared in its manifest and approved like OAuth scopes. Calls are gated as actor `extension`, and automations as `automation`. Widening permissions is reviewable.
- **Host modules:** `codemode:crm`, `codemode:storage` (per-extension KV), `codemode:log`, `codemode:ai` (model roles). There is no HTTP module; external access is through gatekeepers (stage 6).
- After 3 consecutive failures an extension is **quarantined**: disabled, admins notified, and rollback to last-known-good offered.
- **Approvals** show the git diff, a host-computed impact summary (schema, permissions, host modules, triggers), the `check` result, and an AI-written summary labelled as such.
- **Code Mode MCP tool:** scripts run as the connected user's `mcp` actor, under the same gate and simulation.

## Note, 2026-11-04 (stage 3a build)
The principal (`core_user` kind `extension`), the `extension` actor and its gate row, the workspace
DO, host-module wiring, run history, quarantine and the `installExtension` path that stage 3b's
approve will call are described in [ADR 0040](0040-extension-runtime-build.md).
