// The schema reconciler (ADR 0024): turns an extension's declared objects and fields into an
// ordered DDL plan over x_* tables plus the regenerated crm_* views, which can be dry-run
// (`extension.check`) and is applied atomically in one D1 batch with the state rows.
//
// Rules:
// - Additive changes (new objects, new fields) apply directly.
// - Renames need `renamedFrom`; without it a missing field is a removal.
// - Removals hide the field or object (data kept); dropping it is a separate, explicit call
//   (`planDropHidden`) once it has been hidden for 30 days.
// - Type changes are allowed only where lossless (LOSSLESS_TYPE_CHANGES); others are refused
//   with a suggestion.
// - It never touches core_* tables' schema. (Renaming an object re-points the object type of
//   its tags, links and search entries: data, not schema.)
import type { CoreDatabase } from "@relationship-os/db";
import {
  type ExtensionManifest,
  type FieldManifest,
  type FieldTypeName,
  isLosslessChange,
} from "@relationship-os/sdk";
import { CompiledQuery, type Kysely } from "kysely";
import { FIELD_TYPE_REGISTRY } from "../fields/field-types.ts";
import {
  columnName,
  ident,
  isCoreTarget,
  objectTable,
  registryFieldName,
  sideTable,
  splitObjectName,
} from "./naming.ts";
import {
  buildViews,
  type FieldState,
  loadSchemaState,
  type ObjectState,
  type SchemaState,
} from "./schema.ts";
import { seedStatements } from "./seed.ts";

export const HIDDEN_RETENTION_DAYS = 30;

export type SchemaChangeKind =
  | "create_object"
  | "rename_object"
  | "hide_object"
  | "restore_object"
  | "update_object"
  | "add_field"
  | "rename_field"
  | "hide_field"
  | "restore_field"
  | "update_field"
  | "change_type"
  | "drop_field"
  | "drop_object"
  | "add_index"
  | "drop_index"
  | "seed_records";

export interface SchemaChange {
  kind: SchemaChangeKind;
  object: string;
  field?: string;
  from?: string;
  detail?: string;
}

export interface ReconcileIssue {
  code:
    | "lossy_type_change"
    | "rename_conflict"
    | "hidden_conflict"
    | "unknown_target"
    | "formula"
    | "foreign_object"
    | "seed";
  path: string;
  message: string;
  suggestion?: string;
}

export interface ReconcilePlan {
  extension: string;
  /** The schema DDL, in order (drop views → tables and columns → create views). For display. */
  ddl: string[];
  /** Everything to run in one batch: DDL and state-row writes. */
  statements: CompiledQuery[];
  changes: SchemaChange[];
  /** Refusals. A plan with issues must not be applied. */
  issues: ReconcileIssue[];
  /** The schema state after the plan. */
  next: SchemaState;
}

function clone(state: SchemaState): SchemaState {
  return structuredClone(state);
}

function columnDdl(name: string, type: FieldTypeName): string {
  const storage = FIELD_TYPE_REGISTRY[type].storage;
  if (!storage) throw new Error(`${type} fields have no column`);
  return `${ident(name)} ${storage}`;
}

/** The definition stored for a field (without volatile keys). */
function storedDefinition(field: FieldManifest): FieldManifest {
  const { renamedFrom: _renamed, ...rest } = field;
  return rest;
}

function sameDefinition(a: FieldManifest, b: FieldManifest): boolean {
  const { resultType: _a, ...left } = a as FieldManifest & { resultType?: string };
  const { resultType: _b, ...right } = b as FieldManifest & { resultType?: string };
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameStorage(a: FieldTypeName, b: FieldTypeName): boolean {
  return FIELD_TYPE_REGISTRY[a].storage === FIELD_TYPE_REGISTRY[b].storage;
}

const raw = (text: string) => CompiledQuery.raw(text);

/**
 * Plans reconciling `manifest` against the current state. Pure apart from reading state; nothing
 * is written. Apply with `applyPlan` (or queue `plan.statements` in an operation's batch).
 */
export async function planReconcile(
  db: Kysely<CoreDatabase>,
  manifest: ExtensionManifest,
  options: { now: string },
): Promise<ReconcilePlan> {
  return planFromState(db, await loadSchemaState(db), manifest, options.now);
}

export function planFromState(
  db: Kysely<CoreDatabase>,
  current: SchemaState,
  manifest: ExtensionManifest,
  now: string,
): ReconcilePlan {
  const ext = manifest.id;
  const next = clone(current);
  const tableDdl: string[] = [];
  const dataStatements: CompiledQuery[] = [];
  const changes: SchemaChange[] = [];
  const issues: ReconcileIssue[] = [];
  const seedWrites: CompiledQuery[] = [];
  const knownTables = new Set([
    ...current.objects.map((o) => o.tableName),
    ...current.fields.map((f) => f.tableName),
  ]);

  // Objects ---------------------------------------------------------------------------------
  const declaredObjects = new Set<string>();
  for (const [local, object] of Object.entries(manifest.objects)) {
    const name = `${ext}.${local}`;
    declaredObjects.add(name);
    const definition = {
      label: object.label,
      plural: object.plural,
      ...(object.icon ? { icon: object.icon } : {}),
      titleField: object.titleField,
      ...(object.description ? { description: object.description } : {}),
      fieldOrder: Object.keys(object.fields),
      ...(object.navigation ? { navigation: object.navigation } : {}),
      ...(object.indexes?.length ? { indexes: object.indexes } : {}),
      ...(object.timelineLinks?.length ? { timelineLinks: object.timelineLinks } : {}),
      ...(object.stages ? { stages: object.stages } : {}),
      ...(object.owner ? { owner: object.owner } : {}),
      ...(object.navigationOrder !== undefined ? { navigationOrder: object.navigationOrder } : {}),
      ...(object.requireOneOf?.length ? { requireOneOf: object.requireOneOf } : {}),
      ...(object.titleDefault ? { titleDefault: object.titleDefault } : {}),
    };
    let existing = next.objects.find((o) => o.name === name);
    if (!existing && object.renamedFrom) {
      const oldName = `${ext}.${object.renamedFrom}`;
      const old = next.objects.find((o) => o.name === oldName);
      if (old) {
        const table = objectTable(ext, local);
        if (knownTables.has(table)) {
          issues.push({
            code: "rename_conflict",
            path: `objects.${local}.renamedFrom`,
            message: `Cannot rename ${oldName} to ${name}: table ${table} already exists`,
          });
          continue;
        }
        tableDdl.push(`ALTER TABLE ${ident(old.tableName)} RENAME TO ${table}`);
        for (const table of [
          "core_activity_links",
          "core_task_links",
          "core_record_tags",
          "core_search_docs",
        ]) {
          dataStatements.push(
            CompiledQuery.raw(`UPDATE ${table} SET object_type = ? WHERE object_type = ?`, [
              name,
              oldName,
            ]),
          );
        }
        for (const field of next.fields) {
          if (field.object === oldName) {
            field.object = name;
            if (field.tableName === old.tableName) field.tableName = table;
            field.updatedAt = now;
          }
        }
        old.name = name;
        old.localName = local;
        old.tableName = table;
        old.updatedAt = now;
        knownTables.add(table);
        changes.push({ kind: "rename_object", object: name, from: oldName });
        existing = old;
      }
    }
    if (existing) {
      if (existing.status === "hidden") {
        existing.status = "active";
        existing.hiddenAt = null;
        changes.push({ kind: "restore_object", object: name });
      }
      if (JSON.stringify(existing.definition) !== JSON.stringify(definition)) {
        changes.push({ kind: "update_object", object: name });
      }
      existing.definition = definition;
      existing.updatedAt = now;
      continue;
    }
    const table = objectTable(ext, local);
    const columns = Object.entries(object.fields)
      .filter(([, field]) => field.type !== "formula")
      .map(([field, spec]) => columnDdl(columnName(field), spec.type));
    tableDdl.push(
      `CREATE TABLE ${table} (id TEXT PRIMARY KEY NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT, updated_by TEXT, deleted_at TEXT, deleted_by TEXT${columns.length ? `, ${columns.join(", ")}` : ""})`,
    );
    knownTables.add(table);
    next.objects.push({
      name,
      extensionId: ext,
      localName: local,
      tableName: table,
      status: "active",
      hiddenAt: null,
      definition,
      createdAt: now,
      updatedAt: now,
    });
    changes.push({ kind: "create_object", object: name });
    // Seed records are inserted once, with the table that holds them (ADR 0100).
    if (object.seed && Object.keys(object.seed).length) {
      const seeded = seedStatements(manifest, local, now);
      for (const issue of seeded.issues) issues.push({ code: "seed", ...issue });
      seedWrites.push(...seeded.statements);
      changes.push({
        kind: "seed_records",
        object: name,
        detail: `${Object.keys(object.seed).length} record(s)`,
      });
    }
    // Its fields are added below with columns already present.
    for (const [field, spec] of Object.entries(object.fields)) {
      next.fields.push({
        extensionId: ext,
        object: name,
        localName: field,
        name: field,
        tableName: table,
        columnName: spec.type === "formula" ? null : columnName(field),
        type: spec.type,
        definition: storedDefinition(spec),
        status: "active",
        hiddenAt: null,
        createdAt: now,
        updatedAt: now,
      });
      changes.push({ kind: "add_field", object: name, field });
    }
  }
  for (const object of next.objects) {
    if (object.extensionId !== ext || object.status !== "active") continue;
    if (!declaredObjects.has(object.name)) {
      object.status = "hidden";
      object.hiddenAt = now;
      object.updatedAt = now;
      changes.push({
        kind: "hide_object",
        object: object.name,
        detail: `Hidden; its records are kept and can be dropped after ${HIDDEN_RETENTION_DAYS} days`,
      });
    }
  }

  // Fields ----------------------------------------------------------------------------------
  const targets: [string, Record<string, FieldManifest>, string][] = [
    ...Object.entries(manifest.objects).map(
      ([local, o]) =>
        [`${ext}.${local}`, o.fields, `objects.${local}.fields`] as [
          string,
          Record<string, FieldManifest>,
          string,
        ],
    ),
    ...Object.entries(manifest.fields).map(
      ([target, fields]) =>
        [target, fields, `fields.${target}`] as [string, Record<string, FieldManifest>, string],
    ),
  ];
  const declaredFields = new Set<string>();
  for (const [target, fields, basePath] of targets) {
    const own = target.startsWith(`${ext}.`);
    if (!own) {
      if (!isCoreTarget(target)) {
        const parts = splitObjectName(target);
        const exists = next.objects.some((o) => o.name === target && o.status === "active");
        if (!parts || !exists) {
          issues.push({
            code: "unknown_target",
            path: basePath,
            message: `Cannot add fields to ${target}: no such object is installed`,
          });
          continue;
        }
      }
    }
    const table = own
      ? (next.objects.find((o) => o.name === target) as ObjectState).tableName
      : sideTable(ext, target);
    for (const [local, spec] of Object.entries(fields)) {
      const name = registryFieldName(ext, target, local);
      const path = `${basePath}.${local}`;
      declaredFields.add(`${target}|${name}`);
      const mine = (f: FieldState) => f.extensionId === ext && f.object === target;
      let existing = next.fields.find((f) => mine(f) && f.localName === local);
      if (existing && existing.createdAt === now && existing.updatedAt === now && own) {
        // Created with its object above.
        if (changes.some((c) => c.kind === "create_object" && c.object === target)) continue;
      }
      if (!existing && spec.renamedFrom) {
        const old = next.fields.find(
          (f) => mine(f) && f.localName === spec.renamedFrom && f.status === "active",
        );
        if (old) {
          if (old.columnName) {
            const column = columnName(local);
            tableDdl.push(
              `ALTER TABLE ${ident(old.tableName)} RENAME COLUMN ${ident(old.columnName)} TO ${column}`,
            );
            old.columnName = column;
          }
          changes.push({ kind: "rename_field", object: target, field: name, from: old.name });
          old.localName = local;
          old.name = name;
          old.updatedAt = now;
          existing = old;
        }
      }
      if (existing) {
        if (existing.status === "hidden") {
          if (
            !sameStorage(existing.type, spec.type) ||
            (existing.type === "formula") !== (spec.type === "formula")
          ) {
            issues.push({
              code: "hidden_conflict",
              path,
              message: `A removed ${existing.type} field named ${local} still holds data on ${target}`,
              suggestion: `Choose another name, or drop the hidden field first (extension.dropHidden)`,
            });
            continue;
          }
          existing.status = "active";
          existing.hiddenAt = null;
          changes.push({ kind: "restore_field", object: target, field: name });
        }
        if (existing.type !== spec.type) {
          const formulaSwap = (existing.type === "formula") !== (spec.type === "formula");
          const manyChange = (existing.definition.many ?? false) !== (spec.many ?? false);
          if (formulaSwap || manyChange || !isLosslessChange(existing.type, spec.type)) {
            issues.push({
              code: "lossy_type_change",
              path: `${path}.type`,
              message: `Changing ${target}.${name} from ${existing.type} to ${spec.type} could lose data`,
              suggestion: `Add a new ${spec.type} field (e.g. ${local}${spec.type[0]?.toUpperCase()}${spec.type.slice(1)}), copy the values with a tool, then remove ${local}`,
            });
            continue;
          }
          changes.push({
            kind: "change_type",
            object: target,
            field: name,
            detail: `${existing.type} → ${spec.type}`,
          });
          existing.type = spec.type;
        } else if ((existing.definition.many ?? false) !== (spec.many ?? false)) {
          issues.push({
            code: "lossy_type_change",
            path: `${path}.many`,
            message: `Changing ${target}.${name} between one and many could lose data`,
            suggestion: "Add a new relation field instead",
          });
          continue;
        } else if (!sameDefinition(existing.definition, storedDefinition(spec))) {
          changes.push({ kind: "update_field", object: target, field: name });
        }
        existing.definition = storedDefinition(spec);
        existing.updatedAt = now;
        continue;
      }
      // A new field.
      const column = spec.type === "formula" ? null : columnName(local);
      if (column) {
        if (!own && !knownTables.has(table)) {
          tableDdl.push(`CREATE TABLE ${table} (id TEXT PRIMARY KEY NOT NULL)`);
          knownTables.add(table);
        }
        if (next.fields.some((f) => f.tableName === table && f.columnName === column)) {
          issues.push({
            code: "rename_conflict",
            path,
            message: `Column ${column} already exists on ${table}`,
            suggestion: "Choose another field name",
          });
          continue;
        }
        tableDdl.push(`ALTER TABLE ${table} ADD COLUMN ${columnDdl(column, spec.type)}`);
      }
      next.fields.push({
        extensionId: ext,
        object: target,
        localName: local,
        name,
        tableName: table,
        columnName: column,
        type: spec.type,
        definition: storedDefinition(spec),
        status: "active",
        hiddenAt: null,
        createdAt: now,
        updatedAt: now,
      });
      changes.push({ kind: "add_field", object: target, field: name });
    }
  }
  for (const field of next.fields) {
    if (field.extensionId !== ext || field.status !== "active") continue;
    if (!declaredFields.has(`${field.object}|${field.name}`)) {
      const objectHidden = next.objects.some(
        (o) => o.name === field.object && o.status === "hidden",
      );
      if (objectHidden) continue;
      field.status = "hidden";
      field.hiddenAt = now;
      field.updatedAt = now;
      changes.push({
        kind: "hide_field",
        object: field.object,
        field: field.name,
        detail: `Hidden; its data is kept and can be dropped after ${HIDDEN_RETENTION_DAYS} days`,
      });
    }
  }

  // Indexes (ADR 0100): the reconciler owns indexes named `<table>__<column>[__<column>…]` on
  // the extension's own tables. Declared ones are created (live rows only), others dropped.
  for (const object of next.objects) {
    if (object.extensionId !== ext || object.status !== "active") continue;
    const wanted = new Map<string, string>();
    for (const fields of object.definition.indexes ?? []) {
      const columns = fields.map((field) => {
        if (field === "createdAt") return "created_at";
        if (field === "updatedAt") return "updated_at";
        const state = next.fields.find(
          (f) => f.object === object.name && f.extensionId === ext && f.localName === field,
        );
        return state?.columnName ?? null;
      });
      if (columns.some((c) => c === null)) continue;
      const name = ident(`${object.tableName}__${columns.join("__")}`);
      wanted.set(
        name,
        `CREATE INDEX IF NOT EXISTS ${name} ON ${ident(object.tableName)} (${columns.join(", ")}) WHERE deleted_at IS NULL`,
      );
    }
    const existing = (current.indexes ?? []).filter(
      (index) => index.table === object.tableName && index.name.startsWith(`${object.tableName}__`),
    );
    for (const index of existing) {
      if (wanted.has(index.name)) continue;
      tableDdl.push(`DROP INDEX IF EXISTS ${ident(index.name)}`);
      changes.push({ kind: "drop_index", object: object.name, detail: index.name });
    }
    for (const [name, ddl] of wanted) {
      if (existing.some((index) => index.name === name)) continue;
      tableDdl.push(ddl);
      changes.push({ kind: "add_index", object: object.name, detail: name });
    }
  }

  return finishPlan(
    db,
    ext,
    current,
    next,
    tableDdl,
    [...dataStatements, ...seedWrites],
    changes,
    issues,
  );
}

function finishPlan(
  db: Kysely<CoreDatabase>,
  ext: string,
  current: SchemaState,
  next: SchemaState,
  tableDdl: string[],
  dataStatements: CompiledQuery[],
  changes: SchemaChange[],
  issues: ReconcileIssue[],
): ReconcilePlan {
  const views = buildViews(next);
  for (const { object, field, error } of views.errors) {
    const f = next.fields.find((x) => x.object === object && x.name === field);
    if (f?.extensionId !== ext) continue;
    issues.push({
      code: "formula",
      path: `${object}.${field}`,
      message: `${object}.${field}: ${error.message}`,
    });
  }
  for (const field of next.fields) {
    const type = views.formulaTypes.get(`${field.object}|${field.name}`);
    if (type) field.definition = { ...field.definition, resultType: type };
  }
  // Views are dropped before table DDL (SQLite checks views when tables are renamed) and
  // re-created after. Stale views of renamed objects are dropped too.
  const staleViews = current.objects
    .filter(
      (o) => !next.objects.some((n) => n.tableName === o.tableName && n.localName === o.localName),
    )
    .map((o) => `DROP VIEW IF EXISTS crm_x_${ident(o.extensionId)}_${ident(o.localName)}`);
  const ddl = [...new Set([...staleViews, ...views.drops]), ...tableDdl, ...views.creates];

  const touched = new Set([
    ext,
    ...next.fields
      .filter((f) => changes.some((c) => c.object === f.object))
      .map((f) => f.extensionId),
  ]);
  const stateWrites: CompiledQuery[] = [];
  for (const extension of touched) {
    stateWrites.push(
      db.deleteFrom("core_extension_fields").where("extension_id", "=", extension).compile(),
      db.deleteFrom("core_extension_objects").where("extension_id", "=", extension).compile(),
    );
    for (const object of next.objects.filter((o) => o.extensionId === extension)) {
      stateWrites.push(
        db
          .insertInto("core_extension_objects")
          .values({
            name: object.name,
            extension_id: object.extensionId,
            local_name: object.localName,
            table_name: object.tableName,
            status: object.status,
            hidden_at: object.hiddenAt,
            definition: JSON.stringify(object.definition),
            created_at: object.createdAt,
            updated_at: object.updatedAt,
          })
          .compile(),
      );
    }
    const rows = next.fields.filter((f) => f.extensionId === extension);
    for (const field of rows) {
      stateWrites.push(
        db
          .insertInto("core_extension_fields")
          .values({
            extension_id: field.extensionId,
            object: field.object,
            local_name: field.localName,
            name: field.name,
            table_name: field.tableName,
            column_name: field.columnName,
            type: field.type,
            definition: JSON.stringify(field.definition),
            status: field.status,
            hidden_at: field.hiddenAt,
            created_at: field.createdAt,
            updated_at: field.updatedAt,
          })
          .compile(),
      );
    }
  }
  return {
    extension: ext,
    ddl,
    statements: [...ddl.map(raw), ...dataStatements, ...stateWrites],
    changes,
    issues,
    next,
  };
}

/**
 * Plans dropping extension `ext`'s hidden fields and objects that have been hidden for at least
 * `minAgeDays` (default 30). This destroys data; it is a separate, `destructive` call.
 */
export async function planDropHidden(
  db: Kysely<CoreDatabase>,
  ext: string,
  options: { now: string; minAgeDays?: number; only?: string[] },
): Promise<ReconcilePlan> {
  const current = await loadSchemaState(db);
  const next = clone(current);
  const cutoff = new Date(
    Date.parse(options.now) - (options.minAgeDays ?? HIDDEN_RETENTION_DAYS) * 86_400_000,
  ).toISOString();
  const due = (hiddenAt: string | null) => hiddenAt !== null && hiddenAt <= cutoff;
  const wanted = (name: string) => !options.only || options.only.includes(name);
  const tableDdl: string[] = [];
  const changes: SchemaChange[] = [];
  const droppedObjects = next.objects.filter(
    (o) => o.extensionId === ext && o.status === "hidden" && due(o.hiddenAt) && wanted(o.name),
  );
  for (const object of droppedObjects) {
    tableDdl.push(`DROP TABLE IF EXISTS ${ident(object.tableName)}`);
    changes.push({ kind: "drop_object", object: object.name });
  }
  next.objects = next.objects.filter((o) => !droppedObjects.includes(o));
  const droppedTables = new Set(droppedObjects.map((o) => o.tableName));
  const droppedFields = next.fields.filter(
    (f) =>
      f.extensionId === ext &&
      (droppedTables.has(f.tableName) ||
        (f.status === "hidden" && due(f.hiddenAt) && wanted(`${f.object}.${f.name}`))),
  );
  for (const field of droppedFields) {
    if (droppedTables.has(field.tableName)) continue;
    if (field.columnName) {
      tableDdl.push(`ALTER TABLE ${ident(field.tableName)} DROP COLUMN ${ident(field.columnName)}`);
    }
    changes.push({ kind: "drop_field", object: field.object, field: field.name });
  }
  next.fields = next.fields.filter((f) => !droppedFields.includes(f));
  // A side table left without columns is dropped with its last field.
  for (const table of new Set(droppedFields.map((f) => f.tableName))) {
    if (droppedTables.has(table)) continue;
    const isObjectTable = next.objects.some((o) => o.tableName === table);
    if (!isObjectTable && !next.fields.some((f) => f.tableName === table)) {
      tableDdl.push(`DROP TABLE IF EXISTS ${ident(table)}`);
    }
  }
  return finishPlan(db, ext, current, next, tableDdl, [], changes, []);
}

/** Applies a plan atomically (one D1 batch). Refuses plans with issues. */
export async function applyPlan(
  batch: (statements: CompiledQuery[]) => Promise<void>,
  plan: ReconcilePlan,
): Promise<void> {
  if (plan.issues.length) {
    throw new Error(
      `Refusing to apply a plan with issues: ${plan.issues.map((i) => i.message).join("; ")}`,
    );
  }
  await batch(plan.statements);
}
