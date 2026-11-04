# @crm/core

The operations registry and everything an operation needs: ids, the field registry, filter JSON,
list pagination, the gate, and the invocation pipeline (validate → gate → role → handler → audit +
timeline, one D1 batch). Decisions: ADR 0003, 0011, 0016, 0017, 0018.

```
src/
  operations/          one file per object; index.ts lists them all
    person.ts          the reference implementation — copy its shape (+ changeJob, merge, *Many, erase)
    organisation.ts    mirrors person; affiliation.ts, trash.ts (list + purge), user.ts, policy.ts
    index.ts           coreOperations = [...personOperations, ...]
  fields/              field registry per object (person, organisation, activity, task)
  operation.ts         defineOperation, HandlerContext, RecordChange
  pipeline.ts          invokeOperation (the pipeline)
  invoke.ts            coreRegistry, invoke(name, input, ctx), CoreInput/CoreOutput types
  gate.ts              presets, floor (APPROVAL_FLOOR), evaluateGate
  filter.ts list.ts    filter JSON → SQL; listInputSchema, runListQuery, selectFields
  records/tags.ts      loadTags / queueSetTags (shared by any taggable object)
  records/bulk-tags.ts queueBulkTags (add/remove tags on many records, for *.updateMany)
  records/common.ts    TRASH_RETENTION_DAYS, BATCH_MAX, chunk (D1's 100-parameter limit), helpers
  records/links.ts     move activity/task links (merge); activities/tasks an erase removes
  records/erase.ts     queueErase: hard delete + audit redaction markers (ADR 0019)
  purge.ts             runTrashPurge: the scheduled purge, as an automation through invoke()
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
     // mcp: { idempotent: true },             // stage-2 hints
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
   `IN (...)` lists with `chunk()` (D1 allows 100 bound parameters per statement). One call is one
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

## Calling operations

- **UI**: `callOp("person.create", input)` from `apps/app/src/lib/operations.ts` — typed from the
  schemas, runs as actor `human` through one server function.
- **Server code / tests**: `invoke(name, input, { actor, user, origin, db: createCrmDb(env.DB),
  floor })`. Resolve `user` from a Principal with `resolveActingUser(db, principal)`.
- Errors are `OperationError`s with a stable `code`; adapters send `error.toJSON()`.
