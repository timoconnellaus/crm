# ADR 0058: Record tabs and panels, extension settings and choice requirements

Status: accepted, 2026-11-05 (stage 4a build). Extends ADR 0023 (contract) without a contract
version bump: every addition is optional.

## Decision
- **`recordTabs` / `recordPanels`** in `defineExtension`: `{ label, on, view, order? }`, where
  `view` is an object view spec (ADR 0056) of `view.object` plus `relation`, the field of that
  object holding the shown record's id (a relation, or a core multi-valued link such as a task's
  `linkedRecordId`). `validateManifest` checks the objects, and the relation, groupBy, sumField,
  dateField and imageField against the extension's own objects; the host checks the rest.
- **`view.recordViews { object }`** returns the tabs and panels active extensions declare for a
  record page, each turned into a validated view spec (default table columns: the title field
  and four more). A declaration that no longer validates is returned with `error` and not
  rendered. The UI filters each with `{ relation eq <record id> } AND <its own filter>`
  (`recordViewFilter`) and renders it with the same table, board, calendar and gallery
  components as list pages. Tab values are `x:<extension>.<name>` in the record page's URL.
- **`settings`**: typed settings (`text`, `number` with min/max, `boolean`, `select`), stored per
  extension in `core_extension_settings` (migration 0080), read with `extensionSettings.list`
  (defaults filled in) and changed by admins with `extensionSettings.update`, which checks types.
  Settings → Extensions renders the form. The names avoid the `extension.` prefix so a later
  stage can grant an extension `extensionSettings.list` through `codemode:crm`.
- **Choice requirements.** A select option may declare `requires: ["field", …]`. `record.create`
  and `record.update` refuse a record holding that choice while a required field is empty, with
  `details { field, fields, reason: "required_by_choice", choiceField, choice }`. It is the
  smallest declarative stage rule, enough to prove the board's "ask for the missing field"
  dialog with the example extension (Done needs Spent); Deals' per-stage required fields (stage
  4b) can raise the same error shape from their own rule.

## Why
Extensions ship no UI (ADR 0005); declaring tabs as view specs reuses every view type and its
tests. Settings as typed declarations keep values validated and editable without code.
