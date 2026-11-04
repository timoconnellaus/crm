# @crm/sdk

The extension contract (ADR 0005, ADR 0023). Shipped extensions (`extensions/<id>/`) and runtime
extensions (written by AI into the extension workspace) are written against it and run the same
way: in a sandboxed Dynamic Worker with only the host modules they declare (ADR 0025).

```ts
import { defineExtension, defineTool, z } from "@crm/sdk";

export default defineExtension({
  id: "example",              // 2–30 lowercase letters/digits, starting with a letter
  version: "1.0.0",           // semver
  contractVersion: 1,         // the host runs the current and previous contract versions
  label: "Example",
  permissions: { read: ["organisation"], write: ["organisation"], modules: ["crm", "log"] },
  objects: {
    project: {
      label: "Project", plural: "Projects", icon: "folder-kanban", titleField: "name",
      fields: {
        name: { type: "text", label: "Name", required: true },
        budget: { type: "currency", label: "Budget", currency: "USD" },
        spent: { type: "currency", label: "Spent" },
        organisation: { type: "relation", label: "Organisation", to: "organisation" },
        remaining: { type: "formula", label: "Remaining", expression: "coalesce(budget, 0) - coalesce(spent, 0)" },
      },
    },
  },
  fields: { organisation: { tier: { type: "select", label: "Tier", options: ["gold", "silver"] } } },
  views: { big: { label: "Big projects", object: "example.project", filter: { field: "budget", op: "gt", value: 10000 } } },
  tools: {
    setTier: defineTool({
      description: "Set an organisation's tier. Writes the organisation.",
      input: z.object({ organisationId: z.string(), tier: z.enum(["gold", "silver"]) }),
      output: z.object({ ok: z.boolean() }),
      risk: "write",
      async handler({ organisationId, tier }, ctx) {
        await ctx.crm.call("record.update", { object: "organisation", id: organisationId, values: { "example.tier": tier } });
        ctx.log.info("tier set", { organisationId, tier });
        return { ok: true };
      },
    }),
  },
});
```

The entry file is `index.ts`; it may import its own files (`./tools.ts`) and `@crm/sdk`, nothing
else (no `node:*`, other packages, `import()` or `require`). It never imports host modules: tools
get them as `ctx`.

## Writing one over MCP (stage 3b)

An MCP client model with the `admin` scope authors runtime extensions with these tools (ADR 0041):

1. `extension_list` shows what is installed, what is in the workspace and the shipped ids;
   `extension_read { id: "deals" }` shows a complete, working extension to copy from.
2. `extension_write { id, files: { "index.ts": "…" } }` writes the **working copy**. Nothing is live.
3. `extension_check { id }` runs every check and returns `{ ok, issues, manifest, plan }`. Each
   issue has a `stage` (`typecheck`, `contract`, `formula`, `reconcile`), a `code`, a `path` (a
   file for source issues, a manifest path such as `objects.project.titleField` otherwise), a
   `message` and often a `suggestion`. Fix them all; check again until `ok` is true.
4. `extension_propose { id, reason }` commits and queues it for a person to approve, with the
   diff and the impact the CRM computes. It returns `pending_approval` (tell the user) or
   `check_failed` with the issues. Bump `version` for every change you propose.

Rules worth knowing before the first check:

- **TypeScript is checked strictly** against this package's types (ES2022, no DOM). `ctx.crm.call`
  returns `unknown` unless you type it: `ctx.crm.call<{ name: string }>("organisation.get", { id })`.
  `catch (error)` binds `unknown`: narrow it (`const e = error as { code?: string }`). There is no
  `fetch`, `Buffer` or Node API.
- **Ids and names**: the extension id is 2–30 lowercase letters or digits (`projects`, not
  `my-projects`); objects lowercase (`project`); fields, tools and views camelCase (`renewalDate`).
- **Fields on people and organisations** go in `fields: { organisation: { renewalDate: { … } } }`,
  not in `objects`. Their registry name is `<ext>.<field>` (`renewals.renewalDate`), which is what
  `record.update`, filters and views use.
- **Permissions**: declaring `read`, `write` or `operations` needs `"crm"` in `modules`. Your own
  objects need no permission. Asking for more than the installed version is shown to the reviewer
  as a widening.
- **Formulas** see only the same record's fields, by name, and must type-check (see below):
  join text with `&`, move dates with `dateAdd`, compare with null via `isBlank`.
- **Shipped extensions** (`deals`) can be extended from your own extension (fields on
  `deals.deal`, views over it, tools that write it with `permissions.write`), but not edited in
  place unless an admin's `extension_eject` hands it over (it then stops receiving upstream
  updates).
- Removing a field hides it (data kept 30 days); renaming needs `renamedFrom`.

## Contract

| Key | What |
| --- | --- |
| `objects` | New record types. Stored in `x_<ext>_<object>`, read through `crm_x_<ext>_<object>`. Registry name `<ext>.<object>`. They get list and record pages, timelines, history, search, saved views, CSV export and Trash. |
| `fields` | Fields on other objects, keyed by target (`person`, `organisation`, `activity`, `task`, `<otherext>.<object>`). Stored in a 1:1 side table `x_<ext>_<target>`, joined into the target's `crm_*` view as `<ext>__<column>`. Registry name `<ext>.<field>`; write them with `record.update`. |
| `views` | `table` saved-view specs (`object`, `filter`, `sort`, `columns`). |
| `tools` | Operations named `x.<ext>.<tool>` (zod input/output, description, risk `read`/`write`/`bulk-write`/`destructive`). They run in the sandbox. |
| `automations` | `{ description, trigger, handler }`: typed and validated now; triggers fire from stage 5. |
| `permissions` | `read` / `write` (objects; write implies read), `operations` (exact names, e.g. `task.create`, `search.global`), `modules` (`crm`, `storage`, `log`, `ai`). Own objects are always allowed. `extension.*`, `policy.*`, `user.*` and `audit.*` can never be granted. Destructive operations must be listed in `operations`. |

### Object behaviour (ADR 0100)

On `objects.<name>`, next to `fields`:

| Key | What |
| --- | --- |
| `stages` | A stage behaviour, enforced by the host in `record.create`, `record.update` and CSV import for every actor. `field` (a relation to your stage object), `stage: { type, order, requiredFields?, probability?, group? }` (fields of the stage object: a select with `open`/`won`/`lost`, a number, a multiSelect of this object's field names, a number/percent, a relation to the group object), and optionally `group`, `probability: { field, overridden }`, `closedDate` and `status` (read-only fields) and `requiredByType: { lost: ["lostReason"] }`. Entering a stage with a required field empty fails with `invalid_input` and `details: { rule, field, fields, labels, stage }`. Moves are kept in `crm_stage_history` and, with `track: "timeline"` on the stage field, posted as "Moved to <stage>". See `extensions/deals/index.ts`. |
| `timelineLinks` | Relation fields whose records also get this object's timeline posts (`["organisation"]`). |
| `indexes` | `[["stage"], ["owner", "status"]]`: indexes on own single-valued fields (or `createdAt`/`updatedAt`), live rows only. Declare one for each field your lists filter or sort by. |
| `seed` | `{ key: { field: value } }`: records created once when the object is installed; `{ seed: "key" }` points a relation at another seed record. |
| `navigation` | `main` (sidebar, default), `settings` (Settings → set-up) or `none`. |

A field may be `readOnly: true`: set only by the host (a stage behaviour's status or closed date),
refused by record operations.

Names: objects `[a-z][a-z0-9]*` (not `person`, `organisation`, `activity`, `task`, …), fields and
tools camelCase. `id`, `createdAt`, `updatedAt`, `createdBy`, `deletedAt`, `deletedBy` and `tags`
are reserved. Rename with `renamedFrom: "<old name>"`; without it a missing field is removed
(hidden, its data kept 30 days).

## Field types

| Type | Stored as | Value | Filter operators | CSV |
| --- | --- | --- | --- | --- |
| `text` | TEXT | string ≤ 1000 | text ops (eq, contains, starts_with, …) | as is |
| `longText` | TEXT | string (Markdown) | text ops | as is |
| `email`, `phone`, `url` | TEXT | validated string | text ops | as is |
| `number`, `currency`, `percent` | REAL | number | eq … between, in | `1,200.50`, `$5`, `12%` parse |
| `date` | TEXT | `YYYY-MM-DD` | comparisons | `YYYY-MM-DD` |
| `datetime` | TEXT | ISO-8601 with zone | comparisons | any parseable timestamp |
| `boolean` | INTEGER 0/1 | boolean | eq, neq | true/false/yes/no/1/0 |
| `select` | TEXT | one option value | eq, neq, in, not_in | the value |
| `multiSelect` | TEXT (JSON array) | option values | has a value (eq, in, …) | `a; b` |
| `relation` | TEXT id, or JSON array with `many: true` | record id(s) of `to` | id ops / has a value | ids, `; `-separated |
| `user` | TEXT | a user id | eq, neq, in | the id |
| `formula` | none (computed in the view) | its result type | its result type's ops | the value |

Lossless type changes only: `text → longText`, `number ↔ currency/percent`, `date → datetime`,
`select/email/phone/url → text/longText`. Anything else is refused by `check` with a suggestion
(add a new field, copy values with a tool, remove the old one).

## Formula language

A formula is an expression over fields of the **same record** (no cross-record rollups). It is
parsed and type-checked by `extension.check`, compiled to a SQLite expression and computed in the
object's `crm_*` view, so formula fields can be filtered and sorted like any other field. They are
read-only.

```
expr       := or
or         := and ( ("or" | "||") and )*
and        := not ( ("and" | "&&") not )*
not        := ("not" | "!") not | comparison
comparison := concat ( ("=" | "==" | "!=" | "<>" | "<" | "<=" | ">" | ">=") concat )?   -- no chaining
concat     := additive ( "&" additive )*
additive   := term ( ("+" | "-") term )*
term       := unary ( ("*" | "/" | "%") unary )*
unary      := ("-" | "+") unary | primary
primary    := number | string | true | false | null | field | function "(" args? ")" | "(" expr ")"
string     := '…' or "…"   (escapes: \' \" \\ \n)
field      := a field name of the record, case-sensitive (e.g. budget, dueDate, name)
```

Types: `number`, `text`, `boolean`, `date`, `datetime` (and the literal `null`). Fields read as:
text/longText/select/email/phone/url/user/relation (one) → `text`; number/currency/percent →
`number`; boolean → `boolean`; date → `date`; datetime → `datetime`. Other formula fields can be
used (cycles are reported); multiSelect and many-relations cannot. On core objects, core fields can
be read too (e.g. `name`, `currentPeopleCount` on organisation; `displayName`, `jobTitle` on person).

| Function | Result |
| --- | --- |
| `if(condition, then, else)` | type of the branches (must match; `null` fits either) |
| `coalesce(a, b, …)` | first non-null; arguments share a type |
| `isBlank(x)` | boolean; empty or whitespace text counts as blank |
| `concat(a, …)`, `a & b` | text; null joins as empty, numbers without `.0` |
| `length(t)`, `lower(t)`, `upper(t)`, `trim(t)` | number / text |
| `round(n, digits?)` (digits a literal 0–10), `floor(n)`, `ceil(n)`, `abs(n)`, `min(a, b, …)`, `max(a, b, …)` | number |
| `today()`, `now()` | date / datetime (evaluated when read) |
| `dateAdd(date, amount, "day" \| "week" \| "month" \| "year")` | date (or datetime) |
| `dateDiff(start, end, "day" \| "week" \| "month" \| "year")` | number: end − start, whole units |

Rules worth knowing: `+` is for numbers only (join text with `&`); move dates with `dateAdd`, not
`+`; `/` by zero gives null; compare with null using `isBlank(x)`; a date argument may be a literal
like `"2026-03-01"`; units are quoted literals. Examples:

```
coalesce(budget, 0) - coalesce(spent, 0)
if(remaining < 0, "over budget", "ok")
dateDiff(today(), renewalDate, "day")
name & " (" & coalesce(tier, "untiered") & ")"
round(spent / budget * 100, 1)
```

Errors come back from `check` as `{ stage: "formula", code, path, message, span }` with codes
`formula_syntax`, `formula_type`, `formula_unknown_field`, `formula_unknown_function`,
`formula_cycle` and `formula_too_complex`; `span` is the character range in the expression.
Safety: the lexer refuses any character outside the grammar, field names must exist, functions
come from a fixed table, numbers are re-printed and strings are quoted with `''` escaping, so
nothing from a formula reaches SQL verbatim.

## Host modules (`ctx`)

| `ctx.` | Module | |
| --- | --- | --- |
| `crm.call(operation, input)` | `crm` | Any operation the extension's permissions allow, as principal `extension:<id>`, actor `extension`, through the approval gate (like an automation). Failures throw `CrmCallError` with the pipeline's `code`; a call the gate sends to review is queued for approval and throws code `pending_approval` (`details.actionId`). |
| `storage.get/set/delete/list` | `storage` | Per-extension key-value storage (JSON values ≤ 128 KB). |
| `log.info/warn/error(message, data?)` | `log` | Shown in the extension's run history. |
| `ai.summarise/extract/classify` | `ai` | Model roles (ADR 0009); Workers AI by default, through AI Gateway when configured. Fails with a clear error when the deployment has no AI binding. |

There is no network: `fetch` fails (`globalOutbound: null`). External services arrive as
gatekeeper modules in stage 6. A module the extension did not declare is absent from `ctx`.

One version of an extension may serve many runs from the same warm sandbox (ADR 0043), so
module-scope variables can outlive a run. Keep per-call state inside the handler, and persist
anything that must last in `ctx.storage`.

## Testing an extension

`@crm/sdk/testing` runs tools with in-memory host modules and the host's permission rules:

```ts
import { createTestHost } from "@crm/sdk/testing";
import extension from "../index.ts";

const host = createTestHost(extension, {
  records: { organisation: [{ id: "org_1", name: "Acme" }] },
});
expect(host.issues).toEqual([]);                       // contract + formula checks
await host.runTool("setTier", { organisationId: "org_1", tier: "gold" });
expect(host.calls).toContainEqual(expect.objectContaining({ operation: "record.update", allowed: true }));
```

It fakes `record.create/get/update/delete/list` (simple `eq`/`in`/null filters) and
`<core>.get`; pass `operations: { "task.create": (input) => … }` for anything else, and `ai` to
replace the stand-in AI.

## Exports

- `@crm/sdk`: `defineExtension`, `defineTool`, `defineAutomation`, `z`, field types
  (`FIELD_TYPES`, `LOSSLESS_TYPE_CHANGES`), the manifest (`toManifest`, `validateManifest`,
  `manifestSchema`), permissions (`checkGrant`) and the sandbox dispatcher (`runExtension`).
- `@crm/sdk/formula`: `parseFormula`, `compileFormula`, `checkFormula`, `FORMULA_FUNCTIONS`.
- `@crm/sdk/testing`: `createTestHost`.
