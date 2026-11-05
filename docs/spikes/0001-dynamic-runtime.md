# Spike 0001: `@cloudflare/computer` + Worker Loader

Stage 0 spike for [ADR 0006](../adr/0006-dynamic-runtime-cloudflare-computer.md). Date: 2026-11-04.

## What was built

In `apps/runner`, behind the dev-only `/dev/spike/*` routes (served only when `DEV_ROUTES=true`):

- `SpikeWorkspace` ([`src/spike/workspace.ts`](../../apps/runner/src/spike/workspace.ts)): a
  Durable Object holding a `Workspace` (DO SQLite filesystem, `createGitClient()`) with one
  `WorkerJavaScriptBackend` on the `LOADER` Worker Loader binding, `globalOutbound: null`.
- Host modules: `codemode:crm` with a fake `getPerson(id)`, and `codemode:git`
  (`createGitModule()`).
- `GET /dev/spike/bench` ([`src/spike/routes.ts`](../../apps/runner/src/spike/routes.ts)) runs every
  scenario below and returns JSON; [`scripts/spike-bench.mjs`](../../apps/runner/scripts/spike-bench.mjs)
  drives it. `test/spike.test.ts` keeps the basics (host module call, no network) covered in CI.

Versions: `@cloudflare/computer` 0.9.0 (upstream commit `b995d86`), wrangler 4.157.0,
workerd 1.20261103.1, compatibility date 2026-10-01.

## Where the numbers come from

**Local workerd only** (`wrangler dev`, Apple M5, macOS). The brief for this stage ruled out
deploying to a Cloudflare account, so nothing here was measured on the production network. Local
workerd runs every isolate in one process with no network hop between the DO and the Dynamic
Worker, so treat these as a lower bound and the shape of the behaviour, not production latency.

Reproduce:

```sh
cp apps/runner/.dev.vars.example apps/runner/.dev.vars
pnpm --filter @relationship-os/runner exec wrangler dev --port 18787
node apps/runner/scripts/spike-bench.mjs http://127.0.0.1:18787 10 50
```

"Outer" is measured in the calling Worker around the DO RPC; "inner" is measured in the DO around
`runtime.exec()` → `handle.result()`. Three runs of 10 cold and 50 warm samples each:

## Results

### Execution latency for a trivial module (`export default () => 1`)

| | run 1 p50 / p95 | run 2 p50 / p95 | run 3 p50 / p95 |
| --- | --- | --- | --- |
| Cold (new DO + new Workspace + first Dynamic Worker), outer | 11 / 14 ms | 10 / 11 ms | 10 / 15 ms |
| Cold, inner | 9 / 11 ms | 8 / 9 ms | 8 / 13 ms |
| Warm (same DO), outer | 6 / 8 ms | 7 / 9 ms | 7 / 8 ms |
| Warm, inner | 6 / 8 ms | 6 / 9 ms | 6 / 8 ms |

Every execution gets a fresh Dynamic Worker, so "warm" means a warm DO and Workspace, not a reused
isolate. Most of the ~6 ms warm cost is building the module graph, minting the Dynamic Worker and
the result round trip; the DO RPC hop adds well under 1 ms locally. "Cold" here is a cold DO in an
already-running process; the very first execution after `wrangler dev` starts was not separated
out.

### Host module call (`codemode:crm.getPerson`)

Timed inside the isolate with `Date.now()` (which only advances across I/O, so it measures the
calls themselves):

| | run 1 | run 2 | run 3 |
| --- | --- | --- | --- |
| 1 call | 1 ms | 1 ms | 0 ms |
| 100 sequential calls | 5 ms | 6 ms | 4 ms |
| **Per call** | **~0.05 ms** | **~0.06 ms** | **~0.04 ms** |
| Whole execution with 100 calls (inner) | 11 ms | 13 ms | 9 ms |

300 calls in one execution fail with `Workspace execution exceeds 256 capability calls.`: the
default `maxCapabilityCalls` is 256 per execution, counting every filesystem and host-module call.

### Behaviour at the per-execution timeout

| Scenario (`timeoutMs: 2000`) | Result |
| --- | --- |
| Never-settling promise | `failed`, exit 1, stderr `JavaScript execution timed out`, after 2,003–2,004 ms |
| CPU-bound loop with a body (`for (…) x += i`) | `failed`, exit 1, same message, but only after 11.3–12.1 s locally |
| Empty infinite loop (`for (;;) {}`) | **Never returned locally.** It wedged the whole `wrangler dev` process (every later request hung) until it was restarted |
| Next execution on the same DO after a timeout | `completed` normally (6–7 ms) |
| `fetch("https://example.com")` from the module | `failed`: "This worker is not permitted to access the internet via global functions like fetch()" |

The CPU cases are a local-runtime artefact as far as we can tell: workerd locally runs all isolates
on one thread and does not enforce CPU limits, so the DO's timer can't fire while the Dynamic
Worker spins. In production each Dynamic Worker call has its own CPU limit (the smaller of the
timeout and `maxCpuMs`, capped by the platform at about 5 minutes per the library docs). **This
must be re-measured on a deployed runner** before automations run untrusted loops.

### Commit with `codemode:git`, read the diff with the host git client

Extension code ran `init`, wrote `automation.js`, `add` and `commit` through `codemode:git`'s `cli`;
a second execution changed the file and committed again. The DO then read the last commit's diff
through `workspace.git.log()` / `diff({ ref, to })` / `diffSummary()`:

```diff
--- automation.js
+++ automation.js
@@ -1,1 +1,1 @@
-export default () => "v0";
+export default () => "v1";
```

`diffSummary` → `[{ path: "automation.js", status: "M", insertions: 1, deletions: 1 }]`.
Timings: first commit (with `init`) 23–44 ms, second 23–24 ms, reading log + diff + summary on
the host 2–3 ms.

Gotcha: the git client needs the optional peer dependency **`@platformatic/vfs`**. Without it every
git call fails with "@cloudflare/computer/git requires @platformatic/vfs as an optional peer
dependency". It is now a dependency of `apps/runner`.

### Workers Paid limits

None hit, but none could be: nothing ran on a real account. Limits to plan around, from the
library docs and what we saw:

- `maxCapabilityCalls` 256 per execution (hit deliberately, above). Automations that loop over
  records will need it raised, together with `maxCapabilityRequestBytes` /
  `maxCapabilityResponseBytes` (8 MiB each by default).
- A Durable Object can have at most 10 Dynamic Workers in flight; one Workspace runs one execution
  at a time by default. A single extension-workspace DO is therefore a concurrency bottleneck for
  hot automations: shard executions across DOs, or keep the workspace DO for storage and git only.
- Per-execution timeout defaults to 3 min (`maxTimeoutMs`); longer runs need Workflows (as ADR
  0006 already says).
- Worker sizes: ros-runner uploads 1.41 MiB (286 KiB gzip) including the library and the spike.

## Recommendation

**Proceed with ADR 0006 as-is.** Storage, git, host modules and the no-network boundary all work
as the ADR assumes, and warm executions cost single-digit milliseconds locally, with host-module
calls far below a millisecond. Nothing seen here argues for the fallback (own thin loader for hot
automations).

Carry these into stage 3 (extension runtime) and stage 5 (automations):

1. Re-run `scripts/spike-bench.mjs` against a deployed runner on Workers Paid and record cold
   start, CPU-timeout behaviour and concurrency in this file before automations go live. That is
   the trigger to revisit the fallback.
2. Raise `maxCapabilityCalls` and the capability byte limits deliberately for automations.
3. Plan execution sharding (or a pool of executor DOs) so record-change automations don't
   serialise behind one extension-workspace DO.
4. Keep `@platformatic/vfs` alongside `@cloudflare/computer` and pin both (UPSTREAMS.md).

## Note, 2026-11-04 (stage 3a)
The spike code (`SpikeWorkspace`, `/dev/spike/*`, `scripts/spike-bench.mjs`) was replaced by the
real extension workspace (`apps/runner/src/extensions/`, ADR 0040). The findings above still hold;
executions are serialised in one Durable Object as predicted, and recommendation 3 (sharding) is
open for stage 5.
