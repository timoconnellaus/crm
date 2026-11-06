# ADR 0043: Extension executor and stable loader ids

Status: accepted, 2026-11-04 (runtime rework after the Cloudflare cost audit). Amends ADRs 0006,
0025, 0040 and 0042. Decides D1 and D2 of
[`docs/research/cloudflare-cost-audit.md`](../research/cloudflare-cost-audit.md).

## Context
Stage 3 ran every execution (tool runs, manifest evaluation, Code Mode, type checks) through
`@cloudflare/computer`'s `worker-javascript` backend inside the one `ExtensionWorkspace` Durable
Object. Two problems came out of the cost audit:

- **F1.** The backend calls `LOADER.load()` with no id. Each execution is a new billed Dynamic
  Worker ($0.002 a day beyond 1,000 a month) with a cold start that parses the 470 KB SDK bundle.
  Stage 5 automations would make that about $180–600 a month. Wrapping the backend with `get()` was
  not safe: its runtime re-patches `Date`, `Math.random`, timers and `fetch` on every evaluation,
  so a reused isolate would stack the patches.
- **F2.** The DO serialised every execution in the deployment behind one queue, about 1–5 runs a
  second for the whole org. Code Mode, type checks and listing queued behind it too.

Worker Loader's documented contract
([API](https://developers.cloudflare.com/dynamic-workers/api-reference/),
[pricing](https://developers.cloudflare.com/dynamic-workers/pricing/)): `get(id, callback)` caches
isolates by id, and the callback runs only when no isolate with that id is loaded. The same id
must always return the same code. A unique Dynamic Worker is "Worker ID and code", counted per day;
`load()` or no id counts one per invocation. Warm reuse is likely but never guaranteed.

## Decision

**The rule.** Anything that runs more than once gets its Dynamic Worker from
`LOADER.get(stableId, …)`. The id is deterministic. Only throwaway code, Code Mode scripts, uses
`LOADER.load()`.

| Worker | Id | Inputs hashed into it |
| --- | --- | --- |
| Tool run (and stage 5 steps) | `ext:<id>:<commit12>:<hash>` | extension id, commit, sorted host-module set, `RUNTIME_HASH`, `SDK_HASH`, supported contract versions, compatibility date and flags |
| Manifest evaluation | `manifest:<id>:<hash>` | extension id, a content hash of the source files, the same runtime key |
| Type checker | `tsc@<typescript version>+<checker hash>` | the bundled compiler, SDK declarations and checker entry |
| Code Mode script | none (`load()`) | new code every time |

`scripts/bundle.mjs` computes `RUNTIME_HASH` from the SDK bundle, sucrase's version, `build.ts`
and the entry module source (`src/executor/worker-code.ts`), so a release that changes what a
build produces changes every id.

**Our own executor** (`apps/runner/src/executor/`) replaces the computer backend for execution.
`@cloudflare/computer` stays for the workspace filesystem and git only.

- **Fixed entry module.** A `WorkerEntrypoint` with `evaluateManifest()` and
  `runTool(request, host)` (stage 5 adds `runStep`). Its text depends only on the declared
  host-module set, which is part of the id. It patches no globals, so a warm isolate starts every
  run the same way.
- **Per-run context as RPC arguments.** The request carries the tool, input, version, run id and
  deadline. `host` is a per-run `RpcTarget` (`RunHost`) that holds the principal, the declared
  modules and permissions, the deadline, and the run's logs and operations. Its
  `call(module, method, args)` is the only way to reach the CRM. The worker gets `env: {}` and
  `globalOutbound: null`. Host modules are not `env` service stubs: a stub would need the
  principal baked into the worker (breaking the rule above) or supplied by the untrusted code.
- **ADR 0025's guarantees, unchanged.** No network (`globalOutbound: null`). Only declared host
  modules: the entry wires only those, and `RunHost` refuses any other. `codemode:crm` is gated as
  the extension principal (actor `extension`). There is a wall-clock deadline (30 s tools, 10 s
  manifests, 30 s Code Mode) with a matching `limits.cpuMs`. On timeout or the end of a run,
  `RunHost` is closed, so a run that is still executing cannot act. Run history, the failure
  counter, quarantine and rollback are unchanged.
- **Isolation.** Two runs on one warm worker share module state, which is ADR 0025's accepted
  caveat: one id is one extension version, so the same principal. They never share run state,
  which lives in each run's `RunHost`. Tests prove that globals are the same objects before and
  after runs, that logs stay per run, including for concurrent runs, and that the worker is
  actually reused.

**Execution out of the workspace DO (D2).**

- Tool runs, manifest evaluation, type checks and Code Mode run in the caller's isolate: ros-runner's
  stateless entrypoint, and from stage 5 a Workflow step.
- The DO keeps git, working copies and two caches. Only git mutations are serialised.
- A tool run reads its `core_extensions` row from D1 and calls `LOADER.get`. It touches the DO only
  when no isolate is warm, to fetch the cached build in the callback.

**Builds by content hash.**

- A build is the sucrase transpile and import rules (`build.ts`) plus the type check.
- It is cached in DO storage under a hash of the source files, `RUNTIME_HASH` and
  `CHECKER_HASH`. A commit maps to its source hash once.
- The work runs in the caller, not the DO. `extension.check` on a working copy and
  `extension.propose` of the same files share one build, one type check and one manifest worker.
- The cache keeps the 200 most recent builds. The stage 3 `/build/` directories are removed once.

**The type checker** runs in its own Dynamic Worker:

- The compiler, the SDK declarations and `src/checker/entry.ts` are bundled into `checker.txt`.
- ros-runner ships `checker.txt` as a Text module, so it never parses the 3.5 MB compiler.
- The SDK bundle is a Text module too.

**Code Mode** (ADR 0042) runs in the stateless entrypoint with `LOADER.load()`, and the script
source goes straight into the worker (no more `/code/<uuid>` directories). Its limits:

- **Permission:** `code.run` needs `records:write`.
- **Concurrency:** one script per user at a time. A `CodeModeGate` DO per user (`getByName(userId)`)
  holds a lease that expires after the timeout plus 5 s. A second run fails with `rate_limited`.
- **Rate limit:** the `CODE_MODE_RATE_LIMIT` Workers Rate Limiting binding in ros-app, keyed per
  user. `withCodeModeRateLimit` wraps ros-app's host.

**Smaller audit fixes in the same change:**

- `extension.list` reads directory names plus a stored dirty flag. There are no per-file reads and
  no git status.
- `extension.write` and `extension.eject` return paths, not contents.
- `extension.read` reads only what it is asked for.
- Proposal diffs are bounded: 8M LCS cells per proposal. The stored diff is capped at 500 KB
  (`capDiff`), and files past the cap keep their path and counts.
- The `build` role's summary is cached by (extension, commit, base) and runs outside the DO.
- Migration 0070 drops the unused `core_extension_proposals_ext_idx`.

## Measurements (local workerd, `apps/runner/test`)

| | Before | After |
| --- | --- | --- |
| Loader calls per tool run | 1 `load()`, a new billed Dynamic Worker each time | 1 `get()`, with the same id on every run of a version: one unique Dynamic Worker per version per day |
| Code Mode | 1 `load()`, plus a directory written and deleted in the DO | 1 `load()`, with no DO |
| 20 concurrent tool runs (each one `crm.call` and a 50 ms wait) | 1,452 ms (13.8 runs/s), serialised | 82 ms (244 runs/s) |
| One warm tool run | 71 ms | 55 ms |
| ros-runner main module | 10,348 KiB (2,069 KiB gzip for the whole upload) | 3,368 KiB. The whole upload is 7,768 KiB (1,772 KiB gzip), with the compiler and the SDK in Text modules |
| Type check of the example, cold | 203 ms, plus about 130 ms to load the compiler in ros-runner | 281 ms in the checker worker, including loading the compiler |
| Type check of the example, warm | about 110 ms | 97–121 ms |
| `extension.check` again on unchanged source | a full build and type check | 2 ms (cache hit) |
| `check` then `propose` of the same files | 2 builds and 2 type checks | 1 |

## Consequences

- Stage 5 automations must use the same executor (`runStep` on the fixed entry, the same id
  scheme). They must never use `load()`.
- A Worker request can have 4 Dynamic Workers in flight, and a DO 10. Nested tool calls stay well
  under that.
- If a `get()` callback fails (a commit that no longer builds), the run fails with code `build`.
  Worker Loader does not document whether it caches a failed callback. The failure is
  deterministic for that id, so either way the result is the same.
- Module state survives across runs of one version. Extension authors must not keep per-call
  state in module scope. The SDK README now says so.
- Upstreaming a reuse-safe mode (a `loaderId` option) to `cloudflare/computer` remains a possible
  follow-up (audit D1, option a). Nothing here depends on it.

> Amended 2026-11-05: the ros-runner main-module budget is raised from 4,096 to 5,120 KiB (stage 5's automation engine reached 4,221 KiB; stage 7a's AI SDK adds about 1.1 MB). The rule that the TypeScript compiler must not be in the main module is unchanged.

> Amended 2026-11-06 (stage 17 W6, ADR 0346): saved A2UI producers are a fourth stable id, `a2ui:<name>@<version>:<hash>`, hashing the version, its source, the entry module and the compatibility date. They run on `LOADER.get`, with a fixed entry that patches no globals, and the viewer's host as a per-run argument.
