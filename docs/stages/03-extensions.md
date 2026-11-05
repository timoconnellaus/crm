# Stage 3: Extension runtime

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md),
[`CONTEXT.md`](../../CONTEXT.md), [`packages/core/README.md`](../../packages/core/README.md), ADRs
[0002](../adr/0002-d1-real-tables.md), [0005](../adr/0005-extensions.md),
[0006](../adr/0006-dynamic-runtime-cloudflare-computer.md), [0011](../adr/0011-approval-pipeline.md),
[0015](../adr/0015-core-data-model.md), [0018](../adr/0018-invocation-pipeline-and-gate.md),
[0022](../adr/0022-approval-queue-and-simulation.md), [0023](../adr/0023-extension-contract.md),
[0024](../adr/0024-schema-reconciler.md), [0025](../adr/0025-extension-authority-and-runtime.md).
See also the spike write-up `docs/spikes/0001-dynamic-runtime.md`.

Builds on Stage 1 (registry, pipeline, field registry, audit) and Stage 2 (MCP, approval queue,
simulation, change sets).

## Goal

Claude can reshape a deployment by writing code. It adds fields to core objects, creates new objects,
and adds tools. A human approves each change from an impact summary, and the change can be rolled
back. Shipped extensions run through the same runtime.

## Scope

### SDK contract (`packages/sdk`, ADR 0023)
- One entry file per extension, whose default export is `defineExtension({ id, version,
  contractVersion, permissions, objects, fields, views, automations, tools })`. It may import other
  files in the extension.
- `objects`: new record types. Each has a name, label, plural, icon, title field, and fields.
  Extension objects get list and record pages, timelines, tasks, search, history, Trash, CSV
  import/export and saved views. They do this through the same generic components as core objects,
  driven by the field registry.
- `fields`: fields added to core objects or other extensions' objects. They are stored in 1:1 side
  tables `x_<ext>_<object>` (ADR 0015) and joined into the `crm_*` views.
- **Field types:** text, long text (rich), number, currency, percent, date, datetime, boolean,
  single select, multi select (with option lists), relation (to core or extension objects; one or
  many), user, email, phone, url, and **formula**. Each type defines:
  - SQLite storage
  - zod validation
  - filter operators
  - a UI display and edit widget
  - a CSV mapping
- **Formula fields:**
  - Use a small, safe expression language over fields of the *same record*: arithmetic,
    comparison, `if`, `coalesce`, string concat/length/lower/upper, date add/diff/today, and
    rounding.
  - Formulas are parsed and type-checked at `check` time, then compiled to a SQLite expression. They
    are computed in the `crm_*` view, or as a virtual generated column where possible, so they can be
    filtered and sorted.
  - No cross-record rollups in stage 3.
  - Document the grammar in the SDK README.
- `track: "timeline"` is available on extension fields (ADR 0017).
- `views`: table-type saved-view specs shipped with the extension. Dashboards come in stage 4.
- `tools`: functions exposed as **operations** named `x.<ext>.<tool>`, with zod input/output,
  description and risk class. They become MCP tools via the registry (not curated by default) and
  run in the dynamic runtime.
- `automations`: the field exists in the contract, typed and validated, but triggers don't fire until
  stage 5.
- `contractVersion`: the host supports the current and previous versions.
- `@relationship-os/sdk/testing`: a harness to unit-test an extension locally with in-memory host modules.

### Extension workspace and runtime (ADR 0006, ADR 0025)
- The **extension workspace** is a `@cloudflare/computer` Workspace in a Durable Object in
  `ros-runner`, with one directory per runtime extension (`/extensions/<id>/`) under git.
- Execution uses the `worker-javascript` backend with `globalOutbound: null`.
- **Shipped extensions** (`extensions/<id>/` in the repo) are bundled as source at build time and
  run through the same backend and permission model. There is no static fast path.
- **Host modules:**
  - `codemode:crm`: call operations as the extension principal, through the gate.
  - `codemode:storage`: key-value storage scoped per extension.
  - `codemode:log`: structured logs shown in the extension's run history.
  - `codemode:ai`: model roles `summarise`, `extract` and `classify`, through the model registry if
    it exists. Otherwise build the minimal role → provider mapping needed (ADR 0009) and use Workers
    AI defaults.
  - No HTTP module: external access waits for gatekeepers (stage 6).
- **Authority:**
  - Each extension runs as principal `extension:<id>`, with the permissions declared in its manifest
    (objects and operations it may read or write). Those permissions are approved like OAuth scopes.
  - Calls go through the gate as actor `extension`. Automations will use actor `automation` in
    stage 5.
  - Widening permissions is a reviewable change.
- **Failures:**
  - Each extension has a failure counter. After 3 consecutive failures it is quarantined: disabled,
    admins are notified in-app, and the last-known-good version is offered for rollback.
  - Every run is recorded in run history, with duration, outcome, logs and the operations called.

### Schema reconciler (ADR 0024)
- Reconciles declared `objects` and `fields` to `x_*` tables and `crm_*` views on approval.
- **Additive changes** (new objects, new fields) apply on approval.
- **Renames** must be declared with `renamedFrom`. Without it, a missing field is a removal.
- **Removals** hide the field and keep its data for 30 days. Dropping the data needs a separate
  `destructive` approval after that.
- **Type changes** are allowed only where lossless (e.g. text → long text, number → currency).
  Otherwise the change is refused, with a suggestion to add a new field and migrate.
- Each change is planned as an ordered DDL list that can be dry-run (`check`) and is applied
  atomically. Views are regenerated afterwards.
- Core migrations never touch `x_*` tables, and the reconciler never touches `core_*` tables.

### Authoring operations (all also MCP tools)
- `extension.list` and `extension.read` (files).
- `extension.write` (files in the workspace; working copy only).
- `extension.check`: typecheck, contract validation, formula checks, and a dry-run reconcile.
  Returns structured errors Claude can act on.
- `extension.propose`: creates a pending action of risk `extension` (and `schema` if it changes
  schema) holding the git diff and the computed impact.
- `extension.approve`, `extension.reject` and `extension.rollback` (to any previous version).
- `extension.eject`: copies a shipped extension into the workspace and warns that it will stop
  receiving upstream updates.
- `extension.disable` and `extension.enable`.
- Runtime extensions can **extend** shipped extensions' objects (fields, views, tools) but cannot
  modify them. Eject is the escape hatch.

### Approval screen
For an extension change, the approvals inbox shows:
- the git diff
- a **host-computed impact summary**: schema changes, permissions requested or widened, host
  modules used, and triggers registered
- the `check` result
- a **plain-English summary** written by the build model, clearly labelled as AI-written

### Code Mode MCP tool
- A single `code` tool. Claude writes a short ES module that uses `codemode:crm`, which runs in a
  dynamic worker as the connected user's MCP actor (not as an extension).
- It follows the same gate and simulation rules: a script updating 300 people still produces a
  bulk-write review.
- Bounded by the runtime's time and size limits. Returns the script's result plus its logs.

### UI
- **Settings → Extensions**: installed (shipped and runtime) extensions with version, status
  (active, disabled or quarantined), permissions, run history and logs, rollback, and eject.
- **Generic object pages**: list and record pages for extension objects, built from the generic
  components. Extension fields appear on core record pages in the details card, grouped by
  extension.
- Field widgets for every field type, including formula (read-only, with a tooltip showing the
  expression).

## Out of scope
- automation triggers (stage 5)
- dashboards (stage 4)
- gatekeeper modules (stage 6)
- in-app build chat (stage 7)
- cross-record rollup formulas

## Acceptance criteria
1. Reconciler tests cover:
   - adding an object
   - adding fields to a core object
   - renaming with `renamedFrom`
   - hiding, then dropping after a destructive approval
   - a lossless type change accepted; a lossy one refused
   - `crm_*` views regenerated correctly
   - a failed apply rolls back fully
2. Formula fields:
   - the grammar parses
   - type errors are reported by `check`
   - formulas compile to SQL, and they filter and sort in lists
   - injection-like input is rejected
3. Permission tests:
   - an extension cannot call an operation, or touch an object, outside its declared permissions
   - widening permissions creates a review
   - calls are audited as actor `extension`
4. Runtime:
   - code has no network access
   - only the declared host modules can be imported
   - 3 consecutive failures quarantine the extension
   - rollback to last-known-good works
5. Shipped-extension path: a small example extension in `extensions/example/` is bundled, runs
   through the runtime, and is covered by tests. Stage 4 replaces it with Deals.
6. End to end via MCP: a "Projects" object linked to Organisations, with a status select, a budget
   currency field and a formula field, is written, checked, proposed, approved, used (records
   created via MCP and in the UI), extended with a field (v2), then rolled back to v1 with its data
   intact.
7. Approval screen shows the diff, the host-computed impact summary, the check result and the
   labelled AI summary. Covered by Playwright.
8. Code Mode tool: a script that tags 30 people produces one bulk-write pending action in the caller's
   change set, and simulation applies.
9. **AI-authoring eval:** 10 prompts in `evals/extensions/` run through an MCP client model (Workers AI by default), e.g. "add a
   renewal date to organisations", "create a Projects object", "add a formula for days until
   renewal". Each must pass `check` and reach a proposable state. A report is committed, with a target
   of at least 8/10 and failures analysed. This feeds improvements to the SDK docs.
10. `pnpm lint typecheck test` and e2e pass in CI. ADRs, `CONTEXT.md` (Extension principal,
    Quarantine, Formula field, Eject), `docs/architecture.md` and the SDK README are updated.
