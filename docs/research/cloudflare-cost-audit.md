# Cloudflare cost and limits audit

**Date:** 2026-11-04. **Code audited:** `main` at `3f497b2`, plus the vendored `packages/gatekeeper-*` and `mcp-shared`, and the stage 4–8 specs.

**Question:** where does this CRM use Cloudflare primitives in ways that cost a lot, or hit platform limits, as a deployment grows?

**Scenario used for estimates:** one org with 10 users, 100k records (about 60k people, 20k organisations, the rest activities and tasks), 50 automations once stage 5 lands, and 5 mailboxes once stage 6 lands. All prices are Workers Paid.

**Headline:** at this scale the dollar figures are mostly small. The real risks are four:

- the Dynamic Worker load path, which is billed per execution;
- D1 time on the single-threaded primary;
- one Durable Object (DO) for the whole deployment;
- D1's 10 GB hard cap.

**Fixed in the same PR:** list pages read about 200 times fewer rows (82k → 413 for a 50-row page on 20k people). Search hydration, the Trash list and other sorts also read far less. A few needless per-request writes and computations are gone.

The remaining big items need a design decision. They are in [Decisions needed](#decisions-needed).

**Update, 2026-11-04 (runtime rework, [ADR 0043](../adr/0043-extension-executor-and-stable-loader-ids.md)):**

- **D1 and D2 are decided and built.** F1, F2 and F18 are fixed.
- **Stage 3b issues fixed in the same change:**
  - The type checker's cache is keyed by a content hash, not `check-<uuid>`, so `check` and
    `propose` no longer build and type-check the same files twice.
  - The checker runs in its own Dynamic Worker (`tsc@<version>+<hash>`), out of the workspace DO
    and out of ros-runner's main bundle (10,348 KiB before, 3,368 KiB after).
  - `extension.list` reads directory names plus a dirty flag, with no git status.
  - `extension.write` and `extension.read` no longer read every working-copy file.
  - Proposal diffs are bounded (8M LCS cells) and capped (500 KB).
  - The AI summary is cached by (commit, base) and runs outside the DO.
  - Code Mode needs `records:write` and no longer writes `/code/<uuid>` directories.
  - The unused `core_extension_proposals_ext_idx` is dropped (migration 0070).

## 1. Pricing and limits (official docs, fetched 2026-11-04)

| Product | Billing model and included amounts | Limits that matter here | Source |
| --- | --- | --- | --- |
| Workers | $5/month minimum. 10M requests included, then $0.30/M. 30M CPU-ms included, then $0.02/M CPU-ms. No charge for wall time, subrequests or egress. | 30 s CPU per request by default (5 min max). 128 MB per isolate. 10,000 subrequests (Paid). 32 Worker invocations per request, service bindings included. 1 s startup. | [pricing](https://developers.cloudflare.com/workers/platform/pricing/), [limits](https://developers.cloudflare.com/workers/platform/limits/), [service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) |
| Service bindings | No extra request fee: one billed request for the first invocation plus the CPU of both Workers. | Each call counts toward the subrequest limit and the 32-invocation limit. | [pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Static assets | Free and unlimited, unless a path matches `run_worker_first`. | – | [assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) |
| **Dynamic Workers (Worker Loader)** | **1,000 unique Dynamic Workers a month included, then $0.002 per Dynamic Worker per day.** Requests and CPU (startup included) are billed like Workers. "Unique" means id plus code. **`load(code)`, or no id, counts one per invocation.** The docs advise "use `.get()` with a stable ID to avoid being billed for multiple creations". | `get(id, cb)` caches by id. Warm reuse is likely but not guaranteed. The same id must always return the same code. A Worker request can have 4 Dynamic Workers in flight, a DO can have 10. | [pricing](https://developers.cloudflare.com/dynamic-workers/pricing/), [API](https://developers.cloudflare.com/dynamic-workers/api-reference/), [limits](https://developers.cloudflare.com/dynamic-workers/platform/limits/) |
| Code Mode | `DynamicWorkerExecutor` "spins up an isolated Dynamic Worker for each execution", so each is a billed load. | – | [codemode example](https://developers.cloudflare.com/dynamic-workers/examples/codemode/) |
| Durable Objects | 1M requests included, then $0.15/M. RPC sessions and alarm runs each count. **Duration:** 400k GB-s included, then $12.50/M GB-s, billed at 128 MB per object while it is active or idle but unable to hibernate. | Hibernates after about 10 s idle, but only with no timers, no pending I/O, no outbound connection and no `ws.accept()` socket. Pending I/O can hold it awake for up to 15 min. Soft limit of 1,000 requests/s per object. 10 GB SQLite per object. | [pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/), [limits](https://developers.cloudflare.com/durable-objects/platform/limits/) |
| DO alarms | Each alarm run is a request. Each `setAlarm()` is 1 row written. | One alarm per object. A new `setAlarm` replaces the old one. Up to 6 retries. | [pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) |
| DO SQLite storage | 25B rows read included, then $0.001/M. 50M rows written included, then $1/M. 5 GB-month included, then $0.20/GB-month. KV calls are billed as rows. A write that touches an indexed column costs at least one extra row. | 2 MB per row, 100 KB per statement, 100 bound params. | [pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [storage best practices](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/) |
| **D1** | 25B rows read included, then $0.001/M. 50M rows written included, then $1/M. 5 GB included, then $0.75/GB-month. **Rows read are rows scanned:** a full scan of 5,000 rows is `rows_read` 5000. Each index a write touches adds a row written. | **10 GB per database, and this cannot be raised.** 30 s per query (and per batch). 1,000 queries per invocation (a batch counts as one). 100 bound params. 100 KB per statement. 2 MB per row. One thread per database (about 1,000 qps at 1 ms per query). | [pricing](https://developers.cloudflare.com/d1/platform/pricing/), [limits](https://developers.cloudflare.com/d1/platform/limits/), [use indexes](https://developers.cloudflare.com/d1/best-practices/use-indexes/) |
| D1 Time Travel | No extra cost. 30 days of history on Paid. Restoring overwrites the database in place. | 10 restores per 10 minutes. | [time travel](https://developers.cloudflare.com/d1/reference/time-travel/) |
| Workflows | Requests and CPU are billed as Workers. 500k steps a month included, then $0.80 per 100k (step billing starts 2026-08-10). 1 GB-month of state included, then $0.20/GB-month. State is kept 30 days by default, and that includes completed instances. | 10k steps per instance by default. 1 MiB per step result. Creation rate 100/s per Workflow. | [pricing](https://developers.cloudflare.com/workflows/reference/pricing/), [limits](https://developers.cloudflare.com/workflows/reference/limits/) |
| Queues | 1M operations included, then $0.40/M. A message is 3 operations (write, read, delete) per 64 KB. Each retry adds a read. | 128 KB per message. Batches of 100. | [pricing](https://developers.cloudflare.com/queues/platform/pricing/), [limits](https://developers.cloudflare.com/queues/platform/limits/) |
| KV | Reads: 10M included, then $0.50/M. **Writes, deletes and lists: 1M included, then $5/M.** | 1 write per second per key. | [pricing](https://developers.cloudflare.com/kv/platform/pricing/), [limits](https://developers.cloudflare.com/kv/platform/limits/) |
| R2 | $0.015/GB-month. Class A $4.50/M, Class B $0.36/M. Egress free. | – | [pricing](https://developers.cloudflare.com/r2/pricing/) |
| Vectorize | 50M queried dimensions included, then $0.01/M. 10M stored dimensions included, then $0.05 per 100M. | – | [pricing](https://developers.cloudflare.com/vectorize/platform/pricing/) |
| Workers AI | $0.011 per 1k neurons, 10k neurons/day free. Per M tokens (in/out): llama-3.1-8b-fast 4,119/34,868 neurons; llama-3.3-70b-fast 26,668/204,805; gpt-oss-120b 31,818/68,182; bge-m3 1,075; bge-base 6,058. | – | [pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) |
| AI Gateway | Analytics, caching and rate limiting are free. Cached entries live up to 1 month. Accounts with legacy logs get 10M logs per gateway (Paid). Newer accounts follow Workers Logs terms. | 25 MB per cacheable request. | [pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/), [limits](https://developers.cloudflare.com/ai-gateway/reference/limits/) |
| Rate Limiting binding | Price not stated on the binding page. | 10 s or 60 s period. Counts are per location and eventually consistent ("approximate"). Use a DO for a strict global limit. | [rate limit binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) |
| Workers Logs | 20M events/month included, then $0.60/M. Kept 7 days. `head_sampling_rate` defaults to 1. Moves to "Cloudflare Observability pricing" on 2026-12-01 (not yet published). | 256 KB per log. | [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) |
| Logpush / Analytics Engine | Logpush: 10M included, then $0.05/M. Analytics Engine: 10M data points included, then $0.25/M, and not yet billed. | – | [logpush](https://developers.cloudflare.com/workers/observability/logs/logpush/), [AE pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/) |
| Cron triggers | Billed as ordinary requests and CPU. | 250 per account. | [limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Workers Builds | 6,000 build minutes included, then $0.005/min. | 6 concurrent builds. | [builds](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/) |
| Email Service | Inbound routing unlimited. Outbound: 3,000 emails/month, then $0.35 per 1k. Mail to verified addresses is free. | – | [email pricing](https://developers.cloudflare.com/email-service/platform/pricing/) |
| Browser Rendering, Containers, Hyperdrive, Images | Each has its own meter, billed from first use. | – | [browser](https://developers.cloudflare.com/browser-rendering/pricing/), [containers](https://developers.cloudflare.com/containers/pricing/), [hyperdrive](https://developers.cloudflare.com/hyperdrive/platform/pricing/), [images](https://developers.cloudflare.com/images/pricing/) |

**Not documented anywhere I looked:**

- the price of the Rate Limiting binding;
- Dynamic Worker cold-start latency;
- whether D1 bills trigger or view work differently (the measurements below show that triggers' row writes are counted and that views are scanned like any other query);
- AI Gateway log retention.

## 2. What the code uses today

| Worker | Bindings |
| --- | --- |
| `ros-app` | D1 `DB`, KV `OAUTH_KV`, service binding `RUNNER`, daily cron `17 3 * * *`, `observability.enabled` (no sampling), static assets (TanStack Start / Vite plugin, no `run_worker_first`) |
| `ros-runner` | D1 `DB`, `LOADER` (Worker Loader), the `ExtensionWorkspace` DO (SQLite), the `ros-hello` Workflow (stage 0 smoke test) |
| vendored `ros-gatekeeper-google` and `ros-gatekeeper-mcp` | DO classes through `ctx.exports`, `ai` (Drive PDF to Markdown only), observability with `invocation_logs: false`. Not bound to the runner yet. |

Nothing binds or calls Queues, R2, Vectorize, Analytics Engine, Logpush, Containers, Hyperdrive, Images, Browser Rendering or `send_email`. `codemode:ai` uses `env.AI` if a deployer adds it. No AI calls happen per record or per event today.

## 3. Measurements

**Method:** `meta.rows_read` per operation, through the real pipeline in workerd, on a seed of 20k people, 5k organisations, 5k activities and 2k tasks.

**How to repeat it:** `packages/core/test/rows-read.test.ts` holds the budgets. For a fuller picture, wrap `env.DB` the same way and log each statement. To check plans, run `EXPLAIN QUERY PLAN` against a SQLite file built from `packages/db/migrations` and `generateSeed()`.

| Operation (50-row page) | Before (rows read) | After (rows read) |
| --- | ---: | ---: |
| `person.list`, default order | 81,790 | 413 |
| `person.list`, sort by `createdAt` or `updatedAt` | 180,002 | 40,512 |
| `organisation.list`, default order | 13,734 | 729 |
| `activity.list` | 10,802 | 853 |
| `task.list` | 4,403 | 454 |
| `search.global` "ada" | 20,501 | 541 |
| `search.global` "jo" (two-letter prefix) | 26,527 | 4,567 |
| `trash.list` | 32,004 | 8 |
| `export.csv` (people) | 164,680 | 80,011 |
| `person.list` filtered by tag | 20,004 | 20,003 (see F11) |
| `approval.list` (sidebar badge), `approval.pendingForRecord` (50 ids), `audit.list`, `person.get` | 4–13 | unchanged |
| `query.sql` `count(*)` over `crm_people` | 60,193 | unchanged (an inherent full scan) |

**Root cause of the big numbers.** Every core table had a plain index on `deleted_at`. D1 databases have no `ANALYZE` statistics, so the planner treated `deleted_at IS NULL` (true for almost every row) as selective. Every `crm_*` view starts with that condition. The planner therefore walked the whole table through the `deleted_at` index, evaluated the views' correlated subqueries for every row, and then sorted the result with a temp B-tree:

- the subqueries cover primary email, the emails array, primary phone, tags and current-people count;
- the name, display-name and occurred-at indexes went unused;
- so did the primary key for `id IN (…)`, which is search hydration.

With `ANALYZE` stats the planner chooses correctly. So does a partial index on `deleted_at IS NOT NULL` (migration 0050), which needs no statistics.

## 4. Findings

**Severity** weighs cost against limit risk at the scenario scale.

| # | Location | Issue | Impact at 10 users / 100k records / 50 automations | Severity | Status |
| --- | --- | --- | --- | --- | --- |
| F1 | `@cloudflare/computer` 0.9.0 `WorkerJavaScriptBackend` (`dist/backends/worker-javascript/index.js:8141`), used by `apps/runner/src/extensions/workspace.ts` | Every execution (tool run, manifest evaluation, and later every automation step and Code Mode call) calls `loader.load()` with no id. Each one is a new billed Dynamic Worker with a cold start. It parses the 500 KB SDK bundle and the extension modules, then disposes them. | Today this is cheap: tool calls are human or MCP driven, and 1,000 loads a month are included. With stage 5 automations, 50 automations × 20 runs/day × 3 steps is about 90k loads a month, about **$180/month**. At 10k steps a day it is about **$600/month**. Keyed `get()` would bring this to roughly $0, at tens of versions a day. | **High** (becomes Critical in stage 5) | **Fixed** ([ADR 0043](../adr/0043-extension-executor-and-stable-loader-ids.md)). Our own executor gets tool and manifest workers from `LOADER.get(stableId)`: extension, commit (or source hash), host modules, SDK/runtime hash, contract and compatibility. Per-run context goes in as RPC arguments, and no globals are patched. One unique Dynamic Worker per extension version per day. Only Code Mode uses `load()`. Tests cover id stability and that no state leaks across runs. |
| F2 | `apps/runner/src/index.ts:27` `getByName("workspace")`, and `workspace.ts` `#serialise` | **One DO serialises every execution in the deployment:** tool runs, evaluations, commits, and later automation steps, Code Mode and type checks. | Each execution takes 0.2–1 s (load, run, D1 calls), so throughput tops out at about 1–5 executions a second. A 20k-row import that triggers one automation queues for hours, and interactive tools wait behind it. Duration cost is small, about 3.8 GB-s per 30 s run. | **High** (throughput) | **Fixed** (ADR 0043). Execution moved to the stateless runner entrypoint, and the DO keeps git, working copies and caches. 20 concurrent tool runs: 1,452 ms (13.8/s) before, 82 ms (244/s) after. Code Mode is limited to one run per user and rate limited per user. |
| F3 | Core migrations 0003/0004: `core_*_deleted_idx` on `deleted_at` | The planner used the `deleted_at` index for live-row reads (see section 3). List pages, search hydration and the Trash scanned whole tables, evaluating the views' subqueries for every row. | At 60k people a default page read about 245k rows. 3k page loads a day comes to about 22B rows a month: inside the included 25B, but it ate D1's single thread at about 100–300 ms per page. Now about 1k rows per page. | **High** (latency and D1 capacity) | **Fixed:** migration 0050 makes the four indexes partial (`WHERE deleted_at IS NOT NULL`). `rows-read.test.ts` holds budgets for these paths. |
| F4 | `packages/core/src/list.ts` `runListQuery` | Any sort other than the indexed default needed a temp B-tree, and SQLite computed every selected view column for every matching row before sorting. That is about 9 rows read per person. | `person.list` sorted by created or updated date on 60k people read about 540k rows a page. | Medium | **Fixed:** non-default sorts now order ids first, then load the page by primary key. That cuts rows read by 4.4×, and the test covers it. A remaining full pass could be removed with `(created_at, id)` indexes: see F12. |
| F5 | `core_task` | `task.list`'s default order (`due_at, id`) had no index. | Small. | Low | **Fixed:** `core_task_due_at_idx` in 0050. |
| F6 | `packages/core/src/pipeline.ts` (`isAudited`) and `core_audit` | Every non-human read writes an audit row: each MCP or extension read, and later each automation and assistant read. `core_audit` has 5 indexes, so each audit row is about 6 rows written plus about 1 KB stored. The table is append-only: triggers refuse DELETE. | 10 users × 1,000 MCP calls a day is about 1.8M rows written a month, inside the 50M included. Storage is about 0.4 GB a year from MCP alone. Stage 5–7 reads (automations, sync matching, the assistant) multiply this. Together with email bodies (U1) it threatens the **10 GB cap within about a year**. | **High** (limit) | **Decision D3** |
| F7 | `apps/app/src/server/mcp/handler.ts` `consumeRateLimit` | Each MCP HTTP request upserts `core_rate_limit` in D1, and each write upserts again. That is a write on the D1 primary per request: 1 row plus the `window_start` index. | Dollars are negligible (about 1M rows a month). It adds a primary write's round trip to every MCP request, and writes contend on D1's one thread. | Low–Medium | **Decision D4.** The Workers Rate Limiting binding is approximate (per location) and its limits are static in wrangler config. |
| F8 | `apps/app/src/server/mcp/tools.ts` `toolInputSchema` | /mcp builds a new MCP server per request (stateless transport). That re-ran `z.toJSONSchema` over every curated operation on every request, including `tools/call`. | Pure CPU per request, a few ms each. Billable CPU at scale. | Low | **Fixed:** cached per operation object in a `WeakMap`, with a test. |
| F9 | `apps/app/src/server/operations.ts` `ensureShippedExtensions` → `ExtensionWorkspace.commitShipped` | Each new ros-app isolate's first request awaited a runner RPC. That rewrote every shipped file into the DO filesystem and ran `git add` and `status` in the singleton DO, in the user's request path. | Isolates start on every deploy and in every colo. Each start cost a DO request, about 20–50 SQLite rows written and tens of ms of latency on someone's request. | Low–Medium | **Fixed:** the DO stores a content hash of the bundled source with its commit, and returns at once while the hash matches and HEAD is still that commit. A test proves no files are written. |
| F10 | `apps/runner/src/extensions/workspace.ts` `#runTool` | After every run, `core_extensions` was updated (failure count, last good commit, `updated_at`) even when nothing changed. | 1 row plus its index writes per tool run and automation step. | Low | **Fixed:** the write is skipped when nothing changed. A test checks `updated_at` is untouched. |
| F11 | `packages/core/src/filter.ts` (tag, `primary_email`, `job_title` filters) and the `crm_*` views | Filters on view columns computed by subqueries or joins can't use an index. A tag filter is an `EXISTS` per person, and a job-title filter walks people in display-name order until it finds 50 matches. | Up to 1 row read per person per filtered page: 60k rows at scenario scale. That's cheap, but it is a full pass. | Low | Recommendation: drive tag filters from `core_record_tags` (indexed on `tag_id`), e.g. `id IN (SELECT record_id … WHERE tag_id IN (…))`. |
| F12 | `core_person`, `core_organisation` | No index on `created_at` or `updated_at`, so "recently added" sorts still make one pass over the table (F4). | 60k rows per page. | Low | Recommendation: add `(created_at, id)` if the UI exposes this sort prominently. Each index costs one more row written per insert. Don't index `updated_at`, which changes on every write. |
| F13 | `packages/core/src/extensions/schema.ts` `refreshSchemaRegistry` | Each invocation runs `count(*)` and `max(updated_at)` over `core_extension_fields` and `core_extension_objects`, which is a full scan of both. | Rows read per operation equal the number of extension fields plus objects (tens to hundreds). Negligible dollars. | Low | Recommendation: keep a schema stamp row in `core_meta`, bumped by triggers or by the reconciler, so the check reads 1 row. |
| F14 | `packages/core/src/settings.ts` `loadApprovalPolicy`, `resolveActingUser`, and the Better Auth session lookup (no `cookieCache`) | A few primary-key reads per request. | 2–5 rows read per request. Fine. | Info | Recommendation (optional): Better Auth `session.cookieCache` (e.g. 5 min) saves a D1 read per UI request, at the cost of a revocation delay. |
| F15 | `apps/app/src/components/approvals/hooks.ts` | The sidebar badge polls `approval.list` every 60 s. | 7 rows read per poll. React Query doesn't poll background tabs, so this is about 5k requests a day for 10 users. | Info | No change needed. |
| F16 | `apps/runner/src/extensions/runs.ts`, `core_extension_runs` | One row per execution, with logs and operations as JSON. There is no retention or purge. | Stage 5 at about 2k runs a day × 2 KB is about 1.4 GB a year, which counts against the 10 GB cap. | Medium | **Decision D3** (retention). Suggestion: purge after 30 days in the daily cron, with an index on `started_at`. |
| F17 | `core_pending_action` | Decided and expired actions keep their full `input`, `preview` and `simulated` JSON forever. A large bulk preview or inline CSV can exceed D1's 2 MB row limit. | Grows with use. A single bulk import queued for review can fail outright. | Medium | **Decision D3.** Cap the stored previews and compact old rows. |
| F18 | `@cloudflare/computer` runtime journal in the workspace DO | Each execution writes rows to `workspace_runtime_executions` and `_events`, which are pruned by retention and a count cap. `/build/<id>/<commit>/` directories are never removed. | A few DO SQLite rows per run. Old build directories accumulate in the DO's 10 GB. | Low | **Fixed** (ADR 0043). Execution no longer goes through the computer runtime, so there is no journal per run. Builds are cached by content hash in DO storage, capped at 200, and the old `/build/` directories are removed once. |
| F19 | `wrangler.jsonc` `observability: { enabled: true }` | 100% head sampling with invocation logs, in both Workers. | About 2 events per request plus `console` lines. 20M a month is included, and the price changes on 2026-12-01. | Low | Recommendation: keep it at this scale. Document `head_sampling_rate` (e.g. 0.1) for large orgs. |
| F20 | `core_audit_changes`, `core_search_docs` + FTS5, `core_activity` | One audit-change row per changed record per bulk write (CSV import of 20k rows = 20k rows, each with 2 index writes). The FTS triggers write `core_search_docs` plus the FTS index on every name, email or body change. | One 20k-row import is about 200–300k rows written, about $0.25 above the 50M included. Storage is the concern (see D3). | Low (cost), Medium (storage) | Recorded. See U1. |
| F21 | `apps/runner/src/extensions/ai.ts` `runModelRole` | No cache, and the 20k-character prompt cap is per call. Extensions decide how often to call it. | 8B-fast costs about 40 neurons per call (6k tokens in, 400 out), about $0.0004. | Low | Recommendation: set AI Gateway caching (`cf-aig-cache-ttl`) for `classify` and `extract`, and require a gateway id for production. |

### Vendored gatekeepers (report only, not edited)

The vendored gatekeepers are in good shape:

- DOs are per account, mailbox or space, with no singletons.
- No timers keep objects awake: every `setTimeout` is bounded.
- Alarms are event-driven, and "KV" means DO SQLite KV, not Workers KV.
- Tokens are cached, and storage growth is bounded.

| # | Location | Issue | Impact | Recommendation (upstream) |
| --- | --- | --- | --- | --- |
| V1 | `gatekeeper-google/src/google-api.ts:3249` (`watch` body has only `topicName`), `gmail-hooks.ts:197-319` | The Gmail watch has no label filter. Every history change (reads, labels, drafts) triggers a sync of 3 Gmail calls, each with a token RPC to `UserAccount`. | 300–1,000 pushes per mailbox per day. Under $1 a month, but 10–50× more work than needed and Gmail quota spent for nothing. | Send `labelIds: ["INBOX"]` with `labelFilterBehavior: "include"`. Skip the second `getProfile` when history is empty. |
| V2 | `gmail-hooks.ts:414`, `chat-hooks.ts:302` | Hook drivers fetch an access token over DO RPC for every Google call, without `AccessTokenCache`. | About 3 extra DO requests per sync. | Wrap them in `AccessTokenCache`, as the facets do. |
| V3 | `mcp-shared/src/connection.ts:149` | MCP servers that return no `Mcp-Session-Id` are re-initialised before every call. | 3 subrequests per tool call instead of 1. | Cache the `initialize` result per account and generation. |
| V4 | `mcp-shared/src/catalog.ts:5` | The tool catalog TTL is 5 min per binding. | Up to 288 `tools/list` calls a day per active binding. | Raise the TTL, or revalidate on `list_changed` or a missing tool. |
| V5 | `gatekeeper-google/src/google.ts:493`, `gatekeeper-kit/src/cache.ts` | Expired `KvTtlCache` entries and `forgotten:` keys are never deleted. | Unbounded but tiny. | Sweep old generations on reconnect. |
| V6 | `gatekeeper-google/src/google.ts:3455` `readPdf` | A Drive PDF is converted again on every read. | CPU and Drive egress for each read. | Cache the converted text by `fileId` plus revision. |

## 5. Decisions needed

### D1. Dynamic Workers per execution (F1)

**Decided and built:** option (b), with the stable-id rule. See [ADR 0043](../adr/0043-extension-executor-and-stable-loader-ids.md).

**Recommendation: run extension code with `env.LOADER.get(id, cb)`, where `id` is a content hash.**

**What goes into the id:** the extension id, the commit, the sorted set of host modules, the SDK bundle hash, the contract version, and the compatibility date and flags. The entry module is a `WorkerEntrypoint` whose `run(request, host)` takes the per-run context and an `RpcTarget` for the host modules as arguments. That way the code stays identical across runs, while actor, user and permissions travel with each call.

**How to get there:** two options.

- (a) **Upstream to `cloudflare/computer`:** a `loaderId` option on `WorkerJavaScriptBackend`, plus a runtime module that is safe to reuse. Today `install()` re-wraps `Date`, `Math.random`, `setTimeout` and `fetch` and captures the already-patched globals, so it is not.
- (b) **Our own small executor for tool and automation runs.** It would not use durable replay, so it needs none of those patches. Keep `@cloudflare/computer` for the filesystem, git and builds.

I recommend (b) now and (a) as a follow-up. Do it before stage 5, so that automations are never built on `load()`.

**Exceptions:** Code Mode (stage 3b) and one-off checks are new code every time, so `load()` is correct for them. Bound them instead with a per-user rate limit and concurrency of 1, and accept about $0.002 per run.

**Isolation caveat:** a warm isolate keeps module state between runs. That is acceptable because every run of one extension version acts as the same principal (`extension:<id>`). Don't share an id across extensions or versions.

### D2. The single workspace DO (F2)

**Decided and built:** execution runs from the stateless entrypoint. Builds are cached by content hash in the DO. See [ADR 0043](../adr/0043-extension-executor-and-stable-loader-ids.md).

**Recommendation:** keep `ExtensionWorkspace` for what needs it: git, source and builds. Move execution out of it:

- Store each built bundle by commit, in R2 or in a DO per extension.
- Have the stateless runner entrypoint (or the Workflow step) call `LOADER.get(...)` itself, so runs execute in parallel across isolates.

If a DO must stay on the execution path, shard it per extension with `getByName(extId)`.

This also removes the stage 3b concerns: Code Mode, type checks and listing all queue behind one lock.

### D3. Storage growth under D1's 10 GB cap (F6, F16, F17, F20; U1)

**Decided and built (2026-11-04):** [ADR 0090](../adr/0090-storage-retention.md). Non-human reads
are counted hourly. Audit retention is an admin setting (default forever; 1, 2 or 7 years). Runs
are purged after 30/90 days, pending actions are capped and compacted after 30 days, and there is
a storage gauge. U1 (email bodies) is still open.

D1 can't grow past 10 GB, and `core_audit` refuses deletes by design (ADR 0017). Decide now, before stages 5–7 multiply the write volume:

- **Read audits:** aggregate non-human reads (per session, operation and hour) or send them to Analytics Engine or Logpush/R2 with retention, rather than one D1 row each. Writes and refusals stay in D1.
- **Audit retention:** allow deletes older than a retention window (e.g. 2 years), or roll monthly partitions out to R2. Amend ADR 0017.
- **Run history:** purge `core_extension_runs` after 30 days.
- **Pending actions:** compact decided or expired ones after 90 days (drop `input`, `preview` and `simulated`, keep the row), and cap previews at a sample.
- Show a storage gauge in Settings, with warnings at 6 and 8 GB.

### D4. MCP rate limiting (F7)

**Decided and built (2026-11-04):** option (b), [ADR 0091](../adr/0091-rate-limiting-binding.md).

Options:

- (a) Keep D1: exact and configurable through env vars, at a primary write per request.
- (b) The Workers Rate Limiting binding: no D1 write and fast, but approximate per location, and the limits move into wrangler config.
- (c) A DO per connected app: exact, and awake only during bursts.

**Recommendation:** (b) for the per-request limit (its job is to stop runaway agents, which an approximate limit does). Keep D1 or (c) only if exact per-minute write limits are a product requirement. Low urgency: dollars are negligible at this scale.

## 6. Upcoming stages (specs 04–08): designs that will be expensive when built

| # | Spec | What will cost or hit a limit | Estimate | Recommendation |
| --- | --- | --- | --- | --- |
| U1 | Stage 6 email and calendar sync, ADR 0052 | **Email bodies are stored about 5 times:** in `core_activity.body`, in `core_search_docs` and the FTS index, in `core_audit.input` (only declared `redact` fields are dropped), and in `core_audit_changes.diff`. A 2-year backfill of 5 mailboxes is about 2.2 GB, and steady state adds about 4.5 GB a year. | Hits the 10 GB cap in about a year, together with F6. | Keep bodies in R2, with a ~2 KB snippet in D1, FTS and embeddings. Redact `body` in audits of sync writes. Audit sync per batch. Default the backfill to 90 days, run as a chunked Workflow. |
| U2 | Stage 6 sync dedupe | `messageId` is only inside the payload JSON, so dedupe is a full scan of `core_activity` per message. | 90k backfill × 500k rows is about 45B rows read, above the monthly 25B included, with D1 blocked for seconds per lookup. | Add a `message_id` column with a unique index, or a `core_email_message` table. Keep a counter table for "emailed at least twice". |
| U3 | Stage 5 automations, ADR 0028 | Cascades fan out (b + b² + b³ runs). Imports and backfills fire one event per record. Each run is a Workflow, about 3 Dynamic Worker loads (F1), D1 writes and a run row. | One 20k-row import with one automation is about 60k loads, about $120 at today's `load()`, and hours behind F2. | Tag events by origin and don't trigger on bulk or backfill by default (or deliver one batched event). Add a fan-out budget per root event. Evaluate declarative conditions before creating a Workflow. Use `createBatch`. Debounce with Queue `delaySeconds`. Rate-limit with the binding or a DO per automation. |
| U4 | Stage 4 dashboards, ADR 0027 ("cached for 60 s") | The cache's home is unspecified. Isolate memory rarely hits across isolates. KV costs $5 per M writes and allows 1 write/s per key. Uncached Home loads take 0.5–1.5M rows and seconds of D1's one thread. D1 can't cancel a query that has passed its deadline. | Dollars small. Morning logins compete with sync and automation writes. | Use the Cache API (free), keyed by SQL hash, params and `schema_version`. Use D1 read replication and the Sessions API for widgets and `query.sql`. Denormalise `last_activity_at`. Run `EXPLAIN QUERY PLAN` when a widget is saved. |
| U5 | ADR 0019 erase (exists today, grows with D3) | Erase sweeps all of `core_audit`, `core_audit_changes` and `core_pending_action` with `instr(lower(...))` inside one batch. | Passes D1's 30 s limit once the audit log reaches several GB, so erasure fails. | Narrow candidates through indexed record links. Do the free-text sweep as a chunked Workflow. |
| U6 | Stage 7 assistant, ADR 0009 | Only `summarise`, `extract` and `classify` are mapped (llama-3.1-8b-fast). The assistant, build and review roles will need a 70B-class or gpt-oss model. | Assistant: one turn is about 20–25k tokens in, about 700 neurons. 5 tasks per user per day comes to about **$130–160/month**, the largest single line item. The rest is under $40. | Ship explicit per-role defaults. Trim the assistant's tool list (curated tools plus `describe_operations`). Compact history. Use prompt caching. Add per-user daily budgets, visible through AI Gateway. |
| U7 | Stage 7 policy adjudicator, ADR 0031 | One model call per pending item, including in shadow mode. Bulk previews can exceed the context window. | About 165 neurons per item (800+ for bulk). | Judge per change set. Cache verdicts by (policy hash, operation, diff shape). Sample shadow mode (e.g. 20%). Send capped previews. |
| U8 | Stage 6 notifications, ADRs 0029/0051 | Email and Slack notifications are `outbound`, so under Balanced each one is an approval, and an unread approval escalates to another outbound item. | About 300 approvals a day plus the adjudicator calls (U7), with a risk of loops. | Exempt fixed-template system notifications to internal users from review. Never escalate an escalation. Keep notifications 90 days. |
| U9 | Stage 7 embeddings, Vectorize | Re-embedding on every `updated` event. Embedding every Cmd-K keystroke. | About 120k neurons a day (about $40/month), mostly for unchanged text. Vectorize itself is about $5/month. | Embed only when a hash of the text changes, batch up to 100 texts, use bge-m3 or 384 dims, embed the query on pause, and delete vectors on erase. |
| U10 | Stage 6 integration host DO, ADR 0050 | One host DO for the org: every gatekeeper call, hook and outbound apply goes through it, and it is always awake. | Throughput again (like F2). | Use one host DO per connection, with a registry DO or the D1 mirror for listing. Prune action journals. |
| U11 | Stage 7 daily digest | "Changes on my records in 24 h" has no time index on `core_audit_changes`. | A daily scan per user of a multi-million-row table. | Drive it from `core_audit.at` (indexed), or keep a per-owner daily rollup. Digest model cost is trivial (about 85 neurons per user). |
| U12 | Stage 8 self-updater, ADRs 0053/0054 | Unauthenticated GitHub API calls are limited to 60/hour per IP, and Workers share IPs. A Time Travel rollback discards mail synced during the update window. | Intermittent 403s, and data loss on rollback. | Check releases on the daily cron with ETags. Download from release-asset URLs. Pause sync and queue consumers during the update. Keep 2–3 bundles in R2 with a lifecycle rule. |
| U13 | Stage 7 assistant transport | A non-hibernating socket per open tab keeps a DO awake. | About 1M GB-s a month for 10 users, about $8. | Use the WebSocket Hibernation API, and connect only while the panel is open. |

> **U6 and U9 addressed, 2026-11-05 (stage 7a, ADRs 0150, 0152, 0154, 0155).** Explicit
> per-role defaults on current Workers AI models (the llama-3.1-8b-fast default had been removed
> from the catalogue), every call tagged with its role in AI Gateway for per-role spend. Embeddings
> are queued in the write's own batch, embedded only when a SHA-256 of the text changes, in batches
> of up to 100, with 384-dimension bge-small; Cmd-K embeds the query only on pause (and caches it);
> similar records reuse stored vectors; erase deletes vectors. The assistant's own costs (prompt
> caching, history compaction, per-user budgets) are stage 7b.

> **U4 resolved, 2026-11-05 (stage 4a, ADR 0057).** The 60 s widget cache is the Workers Cache API,
> keyed by a SHA-256 of the bound SQL, params, row limit and visibility scope, with manual refresh;
> no D1 or KV writes. Overview widgets walk indexes (new live `created_at` indexes on people and
> organisations), with `EXPLAIN QUERY PLAN` and rows-read budgets in
> `packages/core/test/dashboards-rows-read.test.ts`. Not done: read replicas, `EXPLAIN` on save,
> `last_activity_at`.

## 7. What is fine

These were checked and are not a concern:

- Keyset cursor pagination everywhere (no `OFFSET`).
- `approval.pendingForRecord` and the badge count (indexed, under 10 rows).
- `audit.list` and per-record history (indexed).
- The daily cron (one run; the purge pages through the partial index).
- OAuth tokens in KV: a read per MCP request, with writes only on issue, refresh and revoke.
- `touchConnection`, already throttled to once a minute.
- The DO hibernates when idle: no timers, sockets or alarms in our own DO.
- No Containers, Hyperdrive, Images or Browser Rendering bindings.
- Static assets are served without invoking the Worker (no `run_worker_first`).
