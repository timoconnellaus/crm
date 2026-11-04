# @crm/core

The operations registry and everything an operation needs: ids, the field registry, filter JSON,
list pagination, the gate, and the invocation pipeline (validate → gate → role → handler → audit +
timeline, one D1 batch). Decisions: ADR 0003, 0011, 0016, 0017, 0018.

```
src/
  operations/          one file per object; index.ts lists them all
    person.ts          the reference implementation — copy its shape (+ changeJob, merge, *Many, erase)
    organisation.ts    mirrors person; affiliation.ts, user.ts, policy.ts
    trash.ts           trash.list, trash.purge (people, orgs, activities, tasks past 30 days)
    activity.ts        activity.log/get/update/delete/restore/listForRecord/list (typed payloads)
    task.ts            task.create/get/update/complete/reopen/delete/restore/list/listMine
    view.ts            view.create/update/delete/list (saved `table` view specs)
    audit.ts           audit.list (admin), audit.listForRecord (History tab)
    search.ts          search.global (FTS5 over core_search, prefix as-you-type)
    query.ts           query.sql + validateReadOnlySql (ADR 0020)
    import.ts          import.csv.preview/commit (reuses the person and organisation
                       snapshots and domain helpers), CSV parse/format helpers
    export.ts          export.csv (core and extension objects)
    record.ts          record.create/get/update/delete/restore/list + schema.objects (extension
                       objects, and extension fields on core objects)
    extension.ts       extension.list/get/check/install/rollback/disable/enable/dropHidden
    extension-authoring.ts extension.read/write/eject/propose/apply/proposal/approve/reject
                       (stage 3b, ADR 0041: working copy → proposal → approval installs)
    code.ts            code.run, the MCP `code` tool (Code Mode, ADR 0042)
    index.ts           coreOperations = [...personOperations, ...]
  fields/              field registry per object (person, organisation, activity, task), and
                       field-types.ts: storage, zod, filter type, CSV and widget per extension
                       field type
  extensions/          stage 3 (ADR 0040): naming (x_* tables, columns), schema.ts (state,
                       registry refresh, crm_* view generation), reconciler.ts (plans, dry run,
                       apply, hide/drop), install.ts (check + installExtension), tools.ts
                       (x.<ext>.<tool> operations), host.ts (the ExtensionHost port the runner
                       implements), shipped.ts (boot install of shipped extensions),
                       proposal.ts (per-file diff and host-computed impact of a proposal)
  models.ts            model roles → Workers AI defaults (ADR 0009, minimal: summarise,
                       extract, classify and build)
  operation.ts         defineOperation, HandlerContext, RecordChange
  pipeline.ts          invokeOperation (the pipeline)
  invoke.ts            coreRegistry, invoke(name, input, ctx), CoreInput/CoreOutput types
  gate.ts              presets, floor (APPROVAL_FLOOR), evaluateGate
  filter.ts list.ts    filter JSON → SQL; listInputSchema, runListQuery, selectFields
  records/tags.ts      loadTags / queueSetTags (shared by any taggable object)
  records/bulk-tags.ts queueBulkTags (add/remove tags on many records, for *.updateMany)
  records/common.ts    TRASH_RETENTION_DAYS, BATCH_MAX, chunk and jsonList (D1's 100-parameter
                       limit), helpers
  records/links.ts     activity/task links: LINK_TARGETS, assertLinkTargets, loadLinks; moving
                       links (merge); the activities/tasks an erase removes
  records/erase.ts     queueErase: hard delete + audit redaction markers (ADR 0019)
  operations/approval.ts      approval.status/list/get/pendingForRecord/approve/reject,
                       changeset.begin/commit, expirePendingActions (ADR 0022, 0032)
  operations/connected-app.ts connectedApp.list/listAll/revoke/register, and the per-request
                       helpers /mcp uses (loadConnection, touchConnection)
  operations/retention.ts audit.retention/setRetention/purge/readCounts, storage.status/refresh
                       (ADR 0090)
  approvals/queue.ts   prepareQueuedAction: dry run → diff preview, simulated records,
                       provisional ids, dependencies, change set
  approvals/simulation.ts the session overlay: SIMULATED_OBJECTS, overlayRead for get/list/
                       search.global/activity.listForRecord
  purge.ts             runTrashPurge: the scheduled purge, as an automation through invoke()
  retention.ts         the daily cron's storage retention: runAuditPurge, purgeRunHistory,
                       compactPendingActions, measureStorage (ADR 0090)
  approvals/caps.ts    size caps on what a pending action stores (input, preview, simulated)
  rate-limit.ts        rateLimit(binding, key) over the Workers Rate Limiting binding, and
                       memoryRateLimit for tests (ADR 0091)
  ids.ts               newId("person") → per_01J…
  errors.ts            typed errors (NotFoundError, ConflictError, ValidationError, …)
  users.ts             resolveActingUser (Principal → core_user)
```

## How to add an operation

1. **File.** Put an object's operations in `src/operations/<object>.ts` and export
   `<object>Operations = [...] as const`. Add one import and one `...<object>Operations,` line to
   `src/operations/index.ts`, and `export * from "./operations/<object>.ts"` to `src/index.ts`.
   That is all the registration there is; the UI's `callOp` and the registry test pick it up.

2. **Define it.**

   ```ts
   export const organisationGet = defineOperation({
     name: "organisation.get",                 // <object>.<verb>
     description: "Get one organisation by id … Read-only.", // for a model: what, when, side effects
     input: z.object({ id: z.string().startsWith("org_") }),
     output: organisationSchema,
     permission: "records:read",               // see PERMISSIONS in principals.ts
     risk: "read",                             // read | write | bulk-write | destructive | …
     // actors: ["human"],                     // restrict actor types (policy changes)
     // bulkSize: (input) => input.ids.length, // required for *Many operations
     // mcp: { curated: true, idempotent: true }, // curated = its own MCP tool (ADR 0021)
     // mcp: { expose: false },                // invisible and uncallable from MCP
     // bookkeeping: true,                     // never queued for review (change sets, tokens)
     // alwaysReview: true,                    // always queued, whatever the preset (ADR 0041)
     async handler(input, ctx) { … },
   });
   ```

   Schemas are the contract for the UI, MCP and extension code: describe fields with
   `.describe()`, keep outputs JSON (strings for timestamps), and keep inputs strict.

3. **Handler rules.**
   - Read with `ctx.db` (Kysely over `core_*` tables and `crm_*` views). Throw `NotFoundError`,
     `ValidationError` or `ConflictError` for expected failures.
   - **Queue** writes with `ctx.write(ctx.db.insertInto(…)…)`; never `.execute()` a write. The
     pipeline commits them, the audit row and timeline activities in one D1 batch, so a failure
     rolls everything back. Queued writes are invisible to your later reads.
   - Use `ctx.now` for timestamps, `ctx.user.id` for `created_by`/`deleted_by`, `newId(kind)` for
     ids (add a prefix to `ID_PREFIXES` for a new kind).
   - Return the output, or `return ctx.afterCommit(() => loadThing(ctx.db, id))` to read the
     stored record after commit (see `person.update`).

4. **Diffs.** For every record you change, call

   ```ts
   ctx.recordChange({ object: "organisation", id, action: "update",
                      before: snapshot(before), after: snapshot(after) });
   ```

   Snapshots use **field-registry names** (`name`, `domains`, `ownerId`), not columns. The pipeline
   diffs them (`diffRecords`) into `core_audit_changes`, which the History tab reads. Use
   `action: "create" | "update" | "delete" | "restore" | "erase" | "merge"`, or pass a precomputed
   `diff` (as `person.delete` does).

5. **Timeline.** Flag a field `track: "timeline"` in `src/fields/<object>.ts`; any `update` change
   touching it posts a `system` activity on that record automatically. For events that aren't field
   changes (a job change), call `ctx.postActivity({ subject, payload: { kind: "job_change", … },
   links: [{ object: "person", id }, { object: "organisation", id: orgId }] })`.

   **Batch operations** (`<object>.updateMany`, `.deleteMany`): risk `bulk-write` or
   `destructive`, `bulkSize: (input) => input.ids.length`, at most `BATCH_MAX` ids, and chunk
   write statements over groups of ids with `chunk()` (D1 allows 100 bound parameters per
   statement); for reads prefer `jsonList` (below). One call is one
   batch, so it is atomic; say in the description that larger selections take several calls
   (ADR 0018 amendment).

6. **Lists.** Take `listInputSchema` (filter, sort, cursor, limit, fields), select from the
   object's `crm_*` view and call `runListQuery(query, organisationObject, input)`; return
   `pageSchema(itemSchema.partial().required({ id: true }))` with `selectFields(...)`. Filterable
   and sortable fields come from the field registry; add fields there, not in the handler.

7. **Tests** (`test/<object>.test.ts`, runs in workerd against real D1 with migrations applied):
   call `invoke("organisation.create", input, context(user))` from `test/helpers.ts`, and check the
   result, the audit diffs (`auditChanges(id)`), timeline posts (`timeline("organisation", id)`),
   viewer refusal and conflicts. `test/registry.test.ts` already fails if a definition is
   incomplete or its schemas can't become JSON Schema. Storage is shared within a test file, so use
   `unique()` for emails, domains and names.

## Approval queue and simulation

When the gate says `review` (ADR 0022, 0032), the pipeline does not refuse: it runs the handler
as a **dry run** (writes discarded, `ctx.simulation` set), records a pending action from the
changes it recorded, and throws `PendingApprovalError` whose `pending` is the result MCP returns.
What this asks of a handler:

- Record every change with `ctx.recordChange` and full before/after snapshots in registry field
  names. The diff preview, the simulated record and the "changed since queued" check on approval
  all come from them.
- Return the record (not `afterCommit`) when that is easy; otherwise the simulated output is
  rebuilt from the snapshot (task and activity creates have builders in `approvals/queue.ts`).
- Check link targets with `assertLinkTargets(ctx.db, links, ctx.simulation)` so links to records
  the session created as pending (provisional ids, `per_pending_…`) are accepted.
- A new object that should show up in a session's simulated reads needs an entry in
  `SIMULATED_OBJECTS` (`approvals/simulation.ts`).

On approval, `approval.approve` re-runs each action through the pipeline as its original actor
(`ctx.pipeline.invoke` with `approval` set) and the pending action's status commits in the same
batch as the change. Tests: `test/approvals.test.ts`.

## Patterns worth reusing

- **Long id lists**: D1 allows 100 bound parameters per statement, so never spread a list into
  `IN (?, ?, …)`. Use `where("id", "in", jsonList(ids))` (`records/common.ts`), which binds the list
  as one JSON parameter.
- **Bulk writes**: for hundreds or thousands of rows, insert or update from one JSON parameter per
  chunk with `json_each` (see `queueInsert` / `queueUpdate` in `operations/import.ts`) rather than
  one statement per row. The pipeline does the same for audit diffs, so a bulk operation's whole
  batch stays a few dozen statements.
- **Links**: activities and tasks link to records by `{ object, id }`. Validate with
  `assertLinkTargets` (known object, live record) and read with `loadLinks` (adds titles). Stage 3
  adds extension objects to `LINK_TARGETS`.
- **Merge and erase**: `queueMoveLinks` re-points links onto a survivor; `queueErase`
  (`records/erase.ts`) hard-deletes, removes activities/tasks only the subject owns, and redacts
  audit content through markers (ADR 0019).
- **Snapshots from bulk writers**: build a `PersonSnapshotSource` / `OrganisationSnapshotSource`
  and pass it to `personSnapshot` / `organisationSnapshot` (as `import.csv.commit` does), and
  normalise domains with `normaliseDomains` / `tryNormaliseDomain`, so every writer records the
  same diff shape as the object's own operations.
- **System activities** are posted by the pipeline (`ctx.postActivity`), never by `activity.log`.
- **Timeline / audit cursors**: newest-first lists that are not registry lists encode
  `{ f, d, v, id }` with `encodeCursor` and check them with `decodeCursor`, like `runListQuery`.

## Calling operations

- **UI**: `callOp("person.create", input)` from `apps/app/src/lib/operations.ts` — typed from the
  schemas, runs as actor `human` through one server function. In components, use `useOp` /
  `useOpMutation` from `apps/app/src/lib/query.ts` (TanStack Query keyed by operation name). UI code
  that needs registry values (fields, filter ops, presets) imports `@crm/core/client`, the
  browser-safe entry without handlers or `@crm/db`; type-only imports from `@crm/core` are fine.
- **Server code / tests**: `invoke(name, input, { actor, user, origin, db: createCrmDb(env.DB),
  floor })`. Add `grantedPermissions` (token scopes), `reason` and `approvalExpiryDays` for MCP
  callers. A queued call rejects with `PendingApprovalError` (`code: "pending_approval"`).
- **MCP**: `apps/app/src/server/mcp/tools.ts` (`callForMcp`) — actor `mcp`, origin
  `{ surface: "mcp", clientId, clientName, sessionId }`. Resolve `user` from a Principal with `resolveActingUser(db, principal)`.
- Errors are `OperationError`s with a stable `code`; adapters send `error.toJSON()`.
