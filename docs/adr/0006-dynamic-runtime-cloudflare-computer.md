# ADR 0006: Dynamic runtime on @cloudflare/computer

Status: accepted, 2026-11-04 (stage 0 architecture interview).

## Context
Frequently-changed logic that business users touch, such as marketing automations, computed widgets and custom tools, runs in Worker Loader dynamic workers. We need code storage, versioning, limits, cancellation, run logs and a capability boundary.

## Decision
- Use [`@cloudflare/computer`](https://github.com/cloudflare/computer) on top of Worker Loader.
- Runtime extension source lives in an **extension workspace** (DO SQLite filesystem with git). A commit is a version, approval reviews the diff, and rollback is a revert.
- Execution uses the `worker-javascript` backend with `globalOutbound: null`. Code reaches the world only through host modules: `codemode:crm` (operations), `codemode:ai` (model roles) and `codemode:<gatekeeper>` (enabled integrations).
- Runs longer than the per-execution cap (3 min by default) are modelled as Workflows whose steps are executions.

## Consequences / risks (stage 0 spike)
- Measure cold-start latency for automations triggered on every record change.
- Confirm Worker Loader limits on Workers Paid.
- The library is young: pin versions and track it in `UPSTREAMS.md`. The container backend is out of scope.
- Fallback if the hot path is too slow: keep the library for storage and git, and run hot automations through our own thin loader.

## Note, 2026-11-04 (stage 0 spike)
The spike ([`docs/spikes/0001-dynamic-runtime.md`](../spikes/0001-dynamic-runtime.md)) recommends
proceeding as-is, measured on local workerd only. Production cold start, CPU-timeout behaviour and
concurrency are to be re-measured on a deployed runner before automations go live.

## Amendment, 2026-11-04 (runtime rework, [ADR 0043](0043-extension-executor-and-stable-loader-ids.md))
Execution no longer uses the `worker-javascript` backend.

- **What changed.** That backend called `LOADER.load()` for every execution, which is billed as a
  new Dynamic Worker each time. Its runtime also re-patched globals on every run, so its isolates
  could not be reused.
- **Our own executor.** A small executor in `apps/runner/src/executor/` runs extension code. Repeat
  code gets its worker from `LOADER.get(stableId, …)`, and per-run context travels as RPC arguments.
  This is the "own thin loader" fallback this ADR named.
- **What stays on `@cloudflare/computer`.** The extension workspace (files and git).
- **What `load()` is for now.** Only Code Mode scripts.
