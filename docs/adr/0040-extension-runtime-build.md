# ADR 0040: Extension runtime: how stage 3a built it

Status: accepted, 2026-11-04 (stage 3a build). Refines ADRs 0023, 0024 and 0025.

## Context
Stage 3 was split. 3a builds the SDK contract, the schema reconciler, the runtime and a minimal,
approval-free install path; 3b adds authoring over the approval queue (write, propose, approve,
reject, eject), the approval screen and the Code Mode tool, on top of stage 2. The ADRs leave the
mechanics open, and 3b and stage 2 build on whatever shape they take.

## Decision

**Principal and actor.** Each installed extension has a `core_user` row of kind `extension`
(id `extension:<id>`, role `member`), so `created_by` and owner columns, history and the audit log
can name it. Migration 0020 adds `core_user.kind`; extension rows never sign in
(`resolveActingUser` ignores them), are never the first admin, and `crm_users` lists only humans.
`Actor` gains `extension` (core_audit was rebuilt to allow it). The gate treats it like an
automation (schema and extension risk denied; bulk and destructive work reviewed), and the
pipeline enforces the declared permissions (`checkGrant` in `@crm/sdk`) before the role check, so
refusals are audited as actor `extension`. `core_activity.author_actor` was not widened (a rebuild
would cascade through activity links); extension-authored timeline posts are `system`.

**Registry.** Extension objects and fields live in reconciler state (`core_extension_objects`,
`core_extension_fields`) and join the field registry through `refreshSchemaRegistry`, which the
pipeline calls on every invocation (one stamp query; the state is re-read only when it changed).
`getObject` therefore sees extension schema everywhere: filters, sorts, saved views, CSV export,
search, history and timeline tracking. Extension records use generic `record.*` operations;
`record.update` on a core object writes only its extension fields. `schema.objects` gives the UI the
registry. Tools become operations `x.<ext>.<tool>`, resolved from installed manifests by
`invokeByName` and listed by `listOperations` (the MCP surface in stage 2).

**Views.** Migration 0020 moves the bodies of `crm_people`, `crm_organisations`, `crm_activities`
and `crm_tasks` into `core_base_*` views; the reconciler owns the `crm_*` views and regenerates
them as `SELECT b.*, <side-table columns>, <formulas> FROM core_base_<x> b LEFT JOIN x_<ext>_<x> …`.
Core migrations change `core_base_*`, never those four `crm_*` views. Extension objects read
through `crm_x_<ext>_<object>`. Foreign fields appear as `<ext>__<column>`. Formulas are compiled
into the views (not generated columns, which cannot call `date('now')`).

**Reconciler.** `planReconcile` produces an ordered list: drop owned views → table DDL → create
views, plus state-row writes; `applyPlan` (or the install operation's batch) runs it as one D1
batch, so a failure rolls everything back. The data of removed fields and objects stays hidden for
30 days; `extension.dropHidden` (destructive, human admin) drops it afterwards. Side tables have no
foreign keys to core tables (a core table rebuild would cascade into them).

**Runtime.** One `ExtensionWorkspace` Durable Object in crm-runner holds the
`@cloudflare/computer` Workspace; each extension is its own git repository at `/extensions/<id>/`.
Source is transpiled with sucrase and import-checked (only own files and `@crm/sdk`); the build is
cached per commit under `/build/<id>/<commit>/`. A per-run entry module imports the build, the SDK
bundle (`crm-sdk`) and only the declared `codemode:*` modules, and hands them to tools as `ctx`.
Host modules are configured once on the backend and find the running extension through the DO's
current-run context; executions are serialised so that context is unambiguous. The Dynamic Worker
has `globalOutbound: null` and read-only filesystem access. `codemode:crm` invokes operations in
crm-runner against the shared D1 database (the runner applies the same `APPROVAL_FLOOR`).
`codemode:ai` maps the summarise/extract/classify roles to Workers AI (through AI Gateway when
`AI_GATEWAY_ID` is set) and fails clearly without an `ai` binding.

**Approval queue (stage 2).** A gate `review` on an `extension`-actor call queues a pending action
like any other (migration 0020 also lets `core_change_set` and `core_pending_action` hold actor
`extension`); the tool sees a `CrmCallError` with code `pending_approval` and the action id. When
an admin approves it, the pipeline re-runs the call as the extension principal and loads its
declared permissions from the installed manifest, so the grant check still applies. Extension
tools are listed by MCP's `describe_operations` and `crm://schema` and run through
`call_operation`; a write tool called by an MCP client is gated and queued like any operation.

**Failures.** Every run is a `core_extension_runs` row (duration, outcome, logs, operations called).
Failures other than the caller's (invalid input, unknown tool) count; three in a row quarantine the
extension (status `quarantined`, reason recorded, shown on Settings → Extensions). A successful run
records its commit as `last_good_commit`. Rollback reinstalls any installed commit.

**Install.** `installExtension(ctx, { id, commit, source })` is the one path that makes a commit
live: evaluate in the sandbox → contract and formula check → reconcile plan → queue DDL, state rows
and the principal on the calling operation's batch. `extension.install` (admin, human-only, risk
`extension`) commits files or a shipped extension's bundled source and calls it; so does
`extension.rollback`. Stage 3b's `extension.approve` should call `installExtension` with the
approved commit inside its own operation, so the approval, the DDL and the audit row commit
together.

**Shipped extensions.** `apps/runner/scripts/bundle.mjs` bundles the SDK (with zod) as one module
and every `extensions/<id>/` as source at build time. `installShippedExtensions` runs
`extension.install` for each one whose bundled commit is not installed, as a system call (actor
`human`, user `system`, origin `system`); crm-app runs it once per isolate before the first
operation, and crm-runner exposes it as `installShipped()` for deploy scripts.

## Consequences
- `extension.check` "typecheck" means transpile (syntax) plus import rules plus the zod contract
  check of the evaluated manifest. Full TypeScript type checking in the Worker is deferred to 3b,
  where AI-written source first arrives.
- Executions are serialised in one DO, as the spike predicted; sharding executions is the fix when
  automations need throughput (stage 5).
- Renaming an extension object re-points its tags, links and search entries; past audit rows keep
  the old object name.
- The SDK bundle is about 470 KB per execution; trim it (zod mini, no validation code in the
  sandbox) if cold executions matter.

## Amendment, 2026-11-04 (stage 3b build)
- **Full TypeScript checking.** `extension.check` (and every build) now type-checks extension
  source against `@crm/sdk`'s declarations with the TypeScript compiler API over an in-memory host,
  in the workspace DO (`apps/runner/src/extensions/typecheck.ts`), after the sucrase build and
  import rules pass. Issues are stage `typecheck`, code `type`, path the file and message
  `line:col message (TSnnnn)`. Options: strict, ES2022 libs without DOM, `isolatedModules`, no
  `types`. The declarations (the SDK's emitted `.d.ts`, the zod 4 `.d.cts` files it reaches, the
  ES2022 libs; 448 KiB raw, about 58 KB gzipped) are generated at build time by
  `scripts/bundle.mjs`, as is an ESM bundle of the compiler with `process.browser` set (importing
  `typescript` directly under `nodejs_compat` crashes at load). Measured: the Worker grows from
  767 KiB to 2,036 KiB gzipped (10 MB limit); a check of the example takes ~220 ms cold and
  ~100–150 ms warm in workerd; parsed declarations stay cached (~38 MB live), and a check peaks
  ~40 MB above that, so memory is the tightest limit for very large extensions. The compiler
  module is imported lazily on the first build, so isolates that never build skip its ~130 ms
  start-up. Consequence: strict typing applies to AI-written code, e.g. `ctx.crm.call<T>()`
  results are `unknown` unless typed and `catch (error)` binds `unknown` (the SDK README says
  so).
- **Authoring** (write, propose, approve, reject, eject) and the approval screen are in ADR 0041;
  `installExtension` gained an `eject` option that lets an approved proposal turn a shipped
  extension into a runtime one. Install failures now name the first issue in the error message.
- **Code Mode** runs in the same DO and backend (ADR 0042).
