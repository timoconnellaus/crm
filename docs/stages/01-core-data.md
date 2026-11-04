# Stage 1: Core data, operations registry and UI shell

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md),
[`CONTEXT.md`](../../CONTEXT.md), ADRs [0002](../adr/0002-d1-real-tables.md),
[0003](../adr/0003-operations-registry.md), [0011](../adr/0011-approval-pipeline.md),
[0015](../adr/0015-core-data-model.md), [0016](../adr/0016-operation-conventions.md),
[0017](../adr/0017-audit-and-change-tracking.md).

Builds on Stage 0 (monorepo, both Workers, D1 migrations, identity adapters).

## Goal

A usable CRM for humans, built so that every capability is already an operation that stage 2 can
expose to Claude over MCP without rework.

## Scope

### Core data (ADR 0015)
Migrations in `packages/db`. All tables are `core_*`. IDs are prefixed and time-sortable (`per_`,
`org_`, `aff_`, `act_`, `tsk_`, `usr_`, `vw_`).

- **Person**:
  - name (given/family/display)
  - emails (many, one primary, unique across live people)
  - phones (many)
  - location + timezone
  - social profiles
  - avatar (R2)
  - owner (user)
  - tags
  - description (rich text)
  - job title is derived from the primary affiliation
- **Organisation**:
  - name
  - domains (many, unique across live orgs; used for email → org matching)
  - website
  - industry
  - addresses (many)
  - parent organisation
  - owner
  - tags
  - description (rich text)
- **Affiliation** (person ↔ org, many-to-many): title/role, start, end, `current`, and one `primary`
  per person.
- **Activity**:
  - type `note | email | call | meeting | system`, with a typed JSON payload per type
  - occurred-at, author (user or actor)
  - linked to many records through `core_activity_links` (object type + record id). The link is
    polymorphic so extension objects can be linked later.
- **Task**: title, notes, due, status (`open | done`), assignee, linked records (same link pattern).
- **Users and roles**: `admin | member | viewer`. All users see all records. Role permissions are
  enforced per operation.
- **Soft delete**: `deleted_at`. Trash lists deleted records, which can be restored for 30 days. A
  scheduled purge removes them after that. `*.erase` (admin-only) hard-deletes immediately for GDPR.
- **Read views**: `crm.people`, `crm.organisations`, `crm.activities`, `crm.tasks`. They are
  designed so later extension side tables (`x_<ext>_<object>`, 1:1) can be joined in without
  changing core tables. Live rows only.
- **Search**: an FTS5 index over people (names, emails), orgs (name, domains), activity text and task
  titles, kept in sync by triggers or by the operation layer.

### Operations registry (ADR 0003, ADR 0016)
In `packages/core`:
- A `defineOperation({ name, description, input, output, permission, risk, handler })` API. Risk is
  `read | write | bulk-write | destructive | schema | extension | outbound`.
- Naming is `<object>.<verb>`. Minimum set:
  - `person.create/get/update/list/delete/restore/erase/merge/changeJob`
  - `organisation.create/get/update/list/delete/restore/erase/merge`
  - `affiliation.create/update/end`
  - `activity.log/update/delete/listForRecord`
  - `task.create/update/complete/reopen/delete/list`
  - `search.global`
  - `query.sql` (read-only, over `crm.*` views, using the ADR 0010 guards: parser allowlist, bound
    params, row and time limits)
  - `import.csv.preview/commit`
  - `export.csv`
  - `view.create/update/delete/list`
  - `audit.list`
  - `user.list/updateRole`
  - `trash.list`
- Batch variants (`person.updateMany`, `person.deleteMany`, …) carry `bulk-write` or `destructive`
  risk.
- `list` operations take **structured filter JSON**: `{ and | or: [...] }` of
  `{ field, op, value }`, validated against the object's field registry and compiled to
  parameterised SQL. They use cursor pagination, a sort, and field selection.
- Every invocation carries `{ actor, user, origin }` and goes **gate → handler → audit** in one
  transaction where D1 allows.
- An adapter exposes operations as TanStack Start server functions. Design it so the MCP adapter
  (stage 2) and the host-module adapter (stage 3) are thin. Don't build those adapters now.
- Operation descriptions are written for a model: what it does, when to use it, and side effects.

### Gate (ADR 0011)
- An engine that evaluates actor × risk class → `auto | deny | review`, with thresholds (bulk size).
- Presets: Cautious, Balanced (the default) and Autonomous, stored as org settings. The floor comes
  from env and is never loosened.
- In stage 1 every actor is `human`, so everything is `auto` unless the floor says otherwise.
  `review` returns a typed "not yet supported" error until stage 2 adds the queue.
- Changing the policy is itself an operation (`policy.update`, admin-only, human actor only).
- Unit tests cover the full matrix, the floor and presets.

### Audit and change tracking (ADR 0017)
- `core_audit` is append-only. Each row records: operation, actor, user, origin (UI, MCP client,
  automation id), input (with secrets redacted), result summary, risk class, gate decision,
  timestamp, and field-level before/after diffs for each record touched.
- Record **History** tab: field changes from the audit log.
- Admin **Audit** page: filter by user, actor, operation, record and date.
- **Timeline-worthy fields**: a per-field `track: "timeline"` flag. Changes to flagged fields post a
  `system` activity on the affected records. Core flags owner (person and org), organisation parent,
  organisation name, and domains. The flag is part of the field registry so extensions can use it in
  stage 3.
- **Job change**: `person.changeJob` ends the current affiliation, starts the new one, and moves
  primary. It posts a "Job change" system activity on the person, the old org and the new org.

### UI shell
shadcn/ui in `packages/ui`, routes in `apps/app`. Responsive down to phone width.
- **Navigation**: sidebar (Home, People, Organisations, Tasks, Activity, Trash, Settings) and Cmd-K
  global search plus a command palette.
- **Lists** (People, Organisations, Tasks):
  - table with sort, filter builder (emits filter JSON), column picker and pagination
  - multi-select bulk actions (calling the batch operations)
  - **Saved views** per user: a minimal view spec `{ object, filter, sort, columns }` stored in
    `core_views`. Make the shape forward-compatible with the stage-4 view-spec system; it is a
    `table`-type view.
- **Record page**: layout **B**, matching the mockup in the interview:
  - header with avatar, name, primary title/org, and actions
  - tabs: Overview, Timeline, Tasks, History
  - main column: activity composer + timeline
  - side panel: details (inline edit), organisations/affiliations (with job history), tasks
  - organisation record page: same layout, with a People tab (current and past affiliations)
- **Tasks**: "My tasks" view with due-date grouping, and quick-add from anywhere.
- **Import/export**:
  - CSV import wizard: upload → column mapping → preview with dedupe by email (people) and domain
    (orgs) → commit
  - export of any list view to CSV
- **Merge**: pick a survivor, choose field values, and move affiliations, activities and tasks onto
  it. The merged-away record goes to Trash with a pointer.
- **Keyboard shortcuts**: Cmd-K, `c` to create in context, `/` to filter, `j`/`k` to move in lists,
  `e` to edit, `?` for the shortcut sheet.
- **Settings**: users and roles (admin), approval policy preset (admin), Audit page (admin).

## Out of scope
MCP and OAuth (stage 2), the approval queue and simulation (stage 2), extensions, the schema
reconciler and side tables (stage 3), dashboards (stage 4), automations, integrations,
email/calendar sync, AI features, record-level visibility.

## Acceptance criteria
1. Every user-facing capability above is an operation in the registry. The UI never touches D1
   directly (enforced by lint rule or test).
2. Operations have zod in/out schemas, model-facing descriptions, permissions and risk classes. A
   test fails if any operation lacks one.
3. Gate matrix, presets and floor are covered by unit tests. Viewers are refused writes. Policy
   changes are admin- and human-only.
4. Every write produces an audit row with field diffs. The History tab and the admin Audit page show
   them.
5. `person.changeJob` posts the Job change activity to the person and both orgs. Changes to flagged
   fields post system activities.
6. Soft delete, restore, the 30-day purge (scheduled) and admin erase all work and are tested.
7. Filter JSON is validated and compiles to parameterised SQL. Injection and invalid-field cases are
   tested.
8. `query.sql` rejects non-SELECT, PRAGMA, ATTACH and multiple statements, and enforces row and time
   limits. Tests cover each.
9. Cmd-K search finds people by name and email, and orgs by name and domain, within 200 ms on a
   10k-record seed.
10. CSV import of 5k people with an org column dedupes correctly. Export round-trips.
11. Merging two people preserves all activities, tasks and affiliations, and the loser is restorable
    from Trash.
12. Saved views persist per user and reload exactly.
13. Playwright covers: create person + org + affiliation; log a note visible on both timelines;
    change job; complete a task; import CSV; merge; saved view; Cmd-K. All pass at desktop and
    phone widths.
14. `pnpm lint typecheck test` passes in CI. ADRs and `CONTEXT.md` are updated for any new decision
    or term.
