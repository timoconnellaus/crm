# Stage 12: Import and migration

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md),
[`CONTEXT.md`](../../CONTEXT.md), [`docs/jev.md`](../jev.md), ADRs
[0011](../adr/0011-approval-pipeline.md), [0020](../adr/0020-query-sql-validator-and-csv-import.md),
[0022](../adr/0022-approval-queue-and-simulation.md), [0024](../adr/0024-schema-reconciler.md),
[0041](../adr/0041-extension-authoring-and-proposals.md), [0090](../adr/0090-storage-retention.md),
[0100](../adr/0100-stage-behaviour-and-object-contract-additions.md),
[0101](../adr/0101-base-currency.md), [0102](../adr/0102-record-csv-import.md),
[0130](../adr/0130-automation-runtime.md), [0154](../adr/0154-embeddings-queue-and-vectorize.md),
[0211](../adr/0211-plans-and-entitlements.md), [0230](../adr/0230-jev-as-the-typed-judge.md), and
this stage's [0240](../adr/0240-imports-one-job-one-ledger-one-undo.md) and
[0241](../adr/0241-ai-import-mapping-and-custom-fields.md).

Builds on stage 1 (`import.csv.*`, `export.csv`, merge), stage 3 (extensions, the reconciler and
proposals), stage 4 (Deals, `import.records.*`), stage 5 (Workflows, the event outbox, `includeBulk`)
and 7a (model roles, the embeddings queue). The `import.mapping` placement needs stage 11's judge
seam; without it the importer works and the placement is simply off.

## Goal

Someone leaving HubSpot, Pipedrive, Salesforce or a spreadsheet uploads every file their old system
exported and gets their data in, with its links intact, in one sitting. The AI works out what each
file is, how the files link to each other, and how columns, owners, pipelines, stages, picklists
and currency map. The person checks the plan on one mapping screen and confirms. The import runs in
the background with progress, is recorded as one unit, and can be undone as a whole.

There is one generic importer. No code is written for any particular source system: realistic
sample exports from each system are eval fixtures the generic importer must pass.

## What exists today (from the code)

- `import.csv.preview` / `import.csv.commit` (`packages/core/src/operations/import.ts`): people and
  organisations, CSV text inline in the operation input, up to 20,000 rows and 10 MB, fixed header
  synonyms (`IMPORT_TARGETS`, `suggestMapping`), matching people by email (`core_person_emails`)
  and organisations by domain, then by name. It writes core tables with `json_each` statements in
  the operation's one batch. Custom and extension fields cannot be mapped.
- `import.records.preview` / `import.records.commit` (`import-records.ts`, ADR 0102): extension
  objects such as deals, 100 rows per call through `createRecord`, so stage rules apply. No dedupe.
- No upload route, no XLSX or ZIP reader (the only ZIP code is inside the vendored
  `gatekeeper-microsoft`, which we do not edit), no generic job table, and **no undo of an applied
  write anywhere**. `core_audit_changes` holds before/after diffs.
- An AI caller's import becomes one pending action, but `prepareQueuedAction` refuses inputs over
  `INPUT_MAX_BYTES` (1 MB), so a real file cannot be queued today.
- Custom fields exist only through an extension manifest (side tables `x_<ext>_<object>`, joined
  into `crm_*`), proposed with `extension.propose` and applied after approval.
- `isBulkOperation` already treats `import.*` as bulk, so automations ignore import events unless a
  trigger sets `includeBulk`.

## Scope

### Upload and storage
- An authenticated upload route on ros-app (`/api/imports/:id/files`) streams files into R2
  (`BLOBS`, keys `imports/<importId>/<n>-<name>`). Nothing is sent inline in an operation input.
- Accepted: `.csv`, `.tsv`, `.txt`, `.xlsx` and `.zip` (a ZIP holding any of the others, as
  Salesforce's data export and HubSpot's multi-object export arrive). Limits per import: 50 files,
  200 MB in total, 100,000 data rows across all files (excluding pure link tables, which count
  separately up to 200,000 rows), 300 columns per file, 10,000 characters per cell.
- XLSX: one row stream per sheet, each sheet a file. We write our own small reader (shared strings,
  inline strings, numbers, dates by number format, booleans) over a maintained unzip library
  (`fflate`), with an inflation budget. Formulas import their cached value. Encrypted workbooks,
  Zip64 beyond the limits and macro formats are refused with a clear message.
- `core_import` (one row per import: status, files, counts, plan, options, owner, change set,
  timestamps) and `core_import_file` (role, row count, header, sample). Files in R2 are deleted when
  the import finishes or is cancelled, and by the retention cron after 7 days in any case.

### Profiling and the AI plan (ADR 0241)
- After upload, `import.profile` (a step of the import Workflow) reads each file once: header,
  row count, the first 50 rows as a sample, and for each column up to 200 distinct values with
  counts (for picklists, stages, owners and currencies). Only the profile, never the full file,
  goes to a model.
- `import.plan` asks the `extract` model role for a plan, validated by a zod schema and then by
  code. The plan holds:
  - **File roles:** which object each file holds (person, organisation, an extension object such
    as `deals.deal`, activities, notes), a link table (for example HubSpot's association exports or
    Salesforce's `OpportunityContactRole`), users, a lookup list (for example pipeline or stage
    definitions), or ignored.
  - **Columns:** for each column, an existing field (core, custom, or extension), "new custom
    field" (name, label, type), the source record id, a link to another file's id column, an owner,
    or skip.
  - **Links between files by their own ids:** for example Salesforce `Contact.AccountId` to
    `Account.Id`, Pipedrive `Organization - ID`, HubSpot `Associated Company IDs` (a list column).
  - **Owners by email:** source owner values (an email, or a name or id resolved through a users
    file) to CRM users by email. Unmatched owners go to a fallback the person chooses (themselves,
    another user, or none).
  - **Pipelines and stages:** each source pipeline to an existing pipeline or a new one; each source
    stage to an existing stage, or a new stage with its type (`open | won | lost`). Stage rules
    (ADR 0100) apply on import, so a lost deal without a lost reason gets the configured default
    reason the person picks on the mapping screen, or is listed as invalid.
  - **Picklists:** source values to the target select field's options, or "add as a new option".
  - **Currency:** amounts are read in the deployment's base currency (ADR 0101). Where the export
    has a currency column with other currencies, those rows are listed on the mapping screen and the
    person chooses: import the amount as it is, or skip those rows. There is no FX.
- Code checks the plan before anyone sees it: every target exists, every sample value parses with
  the field type's CSV rules, every link column resolves on the sample, no field is mapped twice in
  one file, required fields are covered.
- **Without AI** (no `AI` binding, or the role unavailable) the importer still works: one file at a
  time, with today's header synonyms extended to every field by name and label, and the person maps
  the rest by hand. The screen says the AI plan is unavailable.

### The mapping screen
- One screen per import: files with their role, row counts, and their links drawn as a small list
  ("Contacts.AccountId → Accounts"), then each file's columns with sample values, the proposed
  target and the reason ("header matches field label", "AI suggestion", "values match the Stage
  options"). No confidence numbers or scores are shown.
- Owners, pipelines and stages, picklist values and currency each get a mapping table.
- Proposed new custom fields are listed with name, label and type, editable.
- **Matching existing records**, chosen once per import and shown with counts from a dry run:
  - **Skip** matched rows.
  - **Update empty fields only.**
  - **Overwrite** mapped fields.
  - Matching is exact and in code: people by email, organisations by domain, then by exact name
    (case-insensitive) when the row has no domain, as today. Rows matching more than one record are
    listed and skipped. Stage 16 adds its name rules to this preview as flags.
- A dry run over the whole import (in the background, the same job in `dryRun` mode) reports per
  file: to create, to update, skipped and why, invalid and why. The person can download invalid rows
  as CSV.
- Confirming starts the import. Cancelling deletes the files.

### Custom fields through schema approval
- Accepted "new custom field" columns become fields on the deployment's local custom-fields
  extension (`custom`, created on first use as a working copy, ADR 0241), written with
  `extension.write` and proposed with `extension.propose`. They are approved like any extension
  change (risk `extension`, human admin).
- The import waits in `waiting_for_schema` until the proposal is applied. If it is rejected, the
  person chooses to skip those columns or cancel.

### The import job (ADR 0240)
- `import.start` (risk `bulk-write`, `bulkSize` the planned row count, input: import id and the
  confirmed plan and options; well under the 1 MB queue cap because the data is in R2).
  - A human's start applies at once. An AI actor's start (assistant, MCP) is gated as usual: under
    Balanced it becomes **one pending action in one change set**, and approving it starts the job.
- One Cloudflare Workflow instance per import (`ros-import`, in ros-runner), id `import:<id>`.
  Steps run in dependency order: users and lookups, organisations, people, affiliations, pipelines
  and stages, extension records (deals), their link tables (participants), activities.
- Each step processes one chunk (default 500 rows for core objects, 100 for extension objects whose
  stage behaviour adds statements) as **one D1 batch** of `json_each` statements, as
  `import.csv.commit` does today. Reference lookups per chunk are one indexed query per key kind
  (emails, domains, source ids). No per-row query.
- **Source id map:** `core_import_key (import_id, file_id, source_id) → (object, record_id)`,
  primary key on the first three, so links across files resolve by the source's own ids. It is
  deleted when the undo window ends.
- **Ledger:** `core_import_record (import_id, object, record_id, action, before)` written in the
  same batch as each chunk. `action` is `created | updated`; `before` holds only the fields the
  import changed. Matched rows that were skipped write nothing.
- **Audit:** one audit row per chunk (operation `import.chunk`, counts, the import id), not one per
  record. A record's history shows "Imported in <import name>" from the ledger.
- **Progress:** the Workflow updates `core_import` counts once per chunk, inside the chunk's batch.
  The import page polls `import.get` (one primary-key read). The person can leave the page; a
  notification (`system.message`) says when it finished or failed.
- **Errors:** a chunk that fails retries with backoff; a row that is invalid is recorded on the
  import (row number, file, reason, up to 10,000 entries) and skipped. The person can download the
  failed rows as CSV, fix them and import them as a new import.
- **Pause and cancel:** cancelling stops after the current chunk and offers undo of what was
  written.
- **Plan limits:** `assertRecordCapacity` (ADR 0211) is checked on the dry run's create count and
  again per chunk.
- **Side effects:** record events carry `bulk` (automations need `includeBulk`). Embeddings go
  through the existing queue, drained by its cron. The search index is kept by its triggers.

### Activity history
- Notes, calls, emails, meetings and tasks are imported where the export has them (HubSpot
  engagements and notes, Pipedrive activities and notes, Salesforce `Task`, `Event`, `Note` and
  `EmailMessage`).
- Each becomes a `core_activity` (or `core_task`) with its original `occurred_at`, its author
  mapped like owners, and links to the people, organisations and deals it was linked to, resolved
  through the source id map.
- `external_key` is `email:<Message-ID>` when the export has one (so it dedupes with mail sync,
  ADR 0112), otherwise `import:<importId>:<sourceId>`. Re-importing the same export into the same
  CRM with "skip" does not duplicate activities whose keys exist.
- Imported email bodies are stored like synced full-content mail (snippet in D1, body in R2).

### Undo
- `import.undo` (risk `destructive`, human only, `records:write` plus being the import's owner or an
  admin) runs as its own Workflow:
  - created records are moved to Trash, unless they were changed after the import finished; those
    are listed and kept unless the person ticks "undo them anyway";
  - updated fields are restored from `before`, field by field, only where the current value still
    equals what the import wrote;
  - imported activities and tasks are deleted;
  - custom fields the import added are not removed (they are schema; removing them is an extension
    change).
- Undo is available for 30 days (until Trash purge would remove the created records). After that
  the ledger and the source id map are purged by the retention cron.

### Evals (`evals/import`)
Fixtures are synthetic but realistic exports, committed under `evals/import/fixtures/`, with no real
personal data:
1. **Plain CSV:** one contacts spreadsheet with messy headers ("E-mail Address", "Company Name",
   "Mobile #"), a full-name column, mixed date formats and a free-text "Notes" column.
2. **HubSpot:** contacts, companies and deals exports (CSV and XLSX), `Record ID` columns,
   `Associated Company IDs` lists, owners as names with an owners file, deal stages by internal
   label, a lifecycle stage column, custom properties, and engagements (notes, calls, emails).
3. **Pipedrive:** persons, organizations, deals, activities and notes, with `ID` and
   `Organization - ID` columns, two pipelines with overlapping stage names, and a currency column
   with two currencies.
4. **Salesforce:** a data export ZIP: `Account.csv`, `Contact.csv`, `Opportunity.csv`, `User.csv`,
   `OpportunityContactRole.csv`, `Task.csv`, `Event.csv`, 18-character ids, `OwnerId` through
   `User.csv`, `StageName` values and `IsWon`/`IsClosed` flags, and custom `__c` fields.

Each fixture has an expected plan (file roles, column targets, links, owner, stage, picklist and
currency mappings, proposed custom fields). Grading is by code: exact comparison per item. The eval
reports, per fixture and model: file roles correct, links correct, column targets correct, stage and
owner mappings correct, and an end-to-end run of the confirmed expected plan against a seeded D1
comparing record counts and links. Pass bars: every file role and every link correct; at least 95%
of column targets correct; no column mapped to a wrong field of a different type. The eval runs with
record and replay (the recorder stage 11 builds in `evals/judge`, ADR 0231; if 12 is built first,
the same pattern locally), so CI replays and never calls a model.

### Jev placement `import.mapping` (proposed, ADR 0241)
Per [`docs/jev.md`](../jev.md)'s rule: a column's target must come from candidates that already
exist (the object's fields, "new field", "skip"), so code gathers the candidates and Jev chooses (rule
2); a knowledgeable person could decide each in seconds from the header and sample values, with a
closed set of answers (rule 3). So:
- **When:** after the `extract` model's plan, for each column and each stage and picklist value
  mapping, only when the judge is on for this placement.
- **Evidence:** the file name, the column header and up to 20 sample values (or the source value and
  its count); never the model's reasoning.
- **Question:** one Choice over the candidate targets (with `new field` and `skip`), or over the
  target stages or options (with `new`).
- **What follows:** where Jev's choice at or above its threshold differs from the model's, the
  mapping screen flags the row and shows both. Code never changes the plan on its own: the person
  confirms.
- **Fails open** (advice; the person confirms every mapping on screen), and says "Not checked".
- Calibrated from a labelled set drawn from the four fixtures (at least 60 columns and 30 stage or
  picklist values), per ADR 0231.

File roles and links between files are not asked of Jev: links are checked exactly by code (do the
sample values resolve?), and file roles are covered by the eval.

## Out of scope
- Per-system importer code, API-based migration (OAuth into the old CRM) and continuous sync from
  another CRM.
- Multi-currency and FX.
- Importing files, attachments, email attachments, or users (CRM users are invited, stage 14).
- Dedupe of extension records other than by the source id map within one import.
- Undo of schema changes.
- Name-based duplicate flags in the preview (stage 16 adds them).

## Acceptance criteria
1. **Upload:** CSV, TSV, XLSX and ZIP files upload to R2 through the authenticated route, refused
   beyond each limit with the limit named; nothing is sent inline in an operation input; files are
   deleted when the import ends and by the retention cron after 7 days.
2. **XLSX:** strings, shared strings, numbers, dates (by number format), booleans and cached formula
   values read correctly from a fixture workbook with three sheets; an encrypted workbook and a ZIP
   bomb are refused.
3. **Profile and plan:** the profile sends at most 50 rows and 200 distinct values per column to
   the model; the plan is zod-validated; code rejects a plan naming an unknown field, an
   unparseable sample, an unresolved link or a duplicate target, and the screen shows why. With AI
   off the importer maps by header and label and says the plan is unavailable.
4. **Mapping screen:** shows roles, links, columns with samples and reasons (no scores), owners,
   pipelines and stages, picklists and currency, and proposed custom fields; the dry run reports
   create, update, skip and invalid counts per file with reasons, and invalid rows download as CSV.
5. **Matching:** skip, update-empty-only and overwrite each behave as named for people (email) and
   organisations (domain, then exact name); a row matching two records is skipped and listed.
6. **Custom fields:** accepted new fields are proposed on the `custom` extension; the import waits
   until the proposal is applied; rejection offers skip or cancel; the imported values land in the
   side table and read through `crm_*`.
7. **Job:** a 100,000-row import of the Salesforce fixture scaled up (a generator in the test
   helpers) completes in the Workflow in chunks, each one D1 batch; progress updates once per chunk;
   a chunk failure retries; invalid rows are recorded and skipped; cancel stops after a chunk.
8. **Links:** organisations, people, affiliations, deals, participants and activities link exactly
   as in the source across files, by source ids, for all four fixtures.
9. **AI actors:** an MCP or assistant `import.start` under Balanced becomes one pending action in
   one change set; approving it starts the job; rejecting deletes the files.
10. **Undo:** undo trashes created records, restores updated fields that still hold the imported
    value, deletes imported activities, lists records changed since and keeps them unless forced,
    and leaves custom fields; after 30 days undo is refused and the ledger is purged.
11. **Activities:** imported notes, calls, emails and meetings keep their dates, authors and links;
    an email with a Message-ID dedupes with a synced copy; re-importing with skip creates no
    duplicate activities.
12. **Cost:** `rows_read` budget tests per chunk (a fixed number of indexed lookups, independent of
    table size) and per `import.get`; no per-row query; one audit row per chunk; record events are
    `bulk`; `rows_written` per imported person stays within a stated budget (record, emails, ledger,
    key map, FTS).
13. **Plan limits:** a dry run over the plan's record cap says so; the job stops at the cap.
14. **Evals:** `pnpm eval:import` runs the four fixtures in replay in CI and live with a key,
    reports per fixture, and meets the pass bars above with the default `extract` model.
15. **Judge (if stage 11's seam is on `main`):** `import.mapping` flags disagreements, never changes
    the plan, fails open with "Not checked", and is calibrated live from its labelled set with none
    wrong; with the judge off nothing changes.
16. `pnpm lint typecheck test` and e2e (upload, map, dry run, import, undo) pass in CI. ADRs,
    `CONTEXT.md` (Import, Import plan, Import ledger) and `docs/architecture.md` (R2 imports, the
    import Workflow) are updated.

## Dependencies
- Needs stages 1, 3, 4, 5 and 7a (all on `main`). `import.mapping` needs stage 11's seam.
- **Stage 14** changes who may import and who imported records are visible to: importing requires
  the new `records:import` permission (Admins and Managers by default), and the owner fallback
  defaults to the importer. Build 12 after 14a if possible; otherwise 14 adds the permission check.
- **Stage 16** adds name-rule flags to the dry run and reuses `name_key` columns; 12 does not wait
  for it.
- **Stage 15**: once Leads is installed, `leads.lead` is a valid file role like any extension
  object, with no importer change.

## Migrations and numbers
Migrations 0280–0289 (block G in `docs/parallel-work.md`). ADRs 0240 and 0241.

## Suggested build order
1. Upload route, R2 storage, `core_import*` tables, CSV and ZIP reading, the profile step.
2. The import Workflow with chunked batches, the source id map, the ledger and progress, driven by a
   hand-written plan (no AI yet), for people and organisations. Undo.
3. Extension objects, pipelines and stages, link tables, activities.
4. The `extract` plan, its validation, the mapping screen, matching options and the dry run.
5. XLSX.
6. Custom fields through the `custom` extension.
7. The evals and fixtures (start writing fixtures in step 1; they drive everything after).
8. `import.mapping`, once stage 11's seam is on `main`.

## Decided (2026-11-05, user interview)
- **Who may import:** Admins and Managers by default; an admin setting allows Members.
- **Undo window:** 30 days, tied to the Trash purge.
- **Overwrite** of matching records requires an Admin. Skip and update-empty-fields-only stay open to anyone allowed to import.
- **After each import** a duplicate scan runs over the imported records (stage 16).
