// The stage behaviour (ADR 0100): what the record operations do when an object declares `stages`
// (Deals: a deal moves through its pipeline's stages). It runs inside record.create,
// record.update and the record CSV import, so it holds for every actor: people, MCP clients,
// Code Mode scripts and extensions.
//
// For a write it works out the record's stage after the write, then:
//   - defaults the stage (the group's first stage) and the group (the stage's group);
//   - refuses a stage outside the record's group, and refuses entering a stage while one of its
//     required fields (the stage's own list plus `requiredByType`) is empty, with a structured
//     error naming the fields (StageRuleError);
//   - keeps the probability on the stage's default unless it was set by hand (the overridden
//     flag), sets the status from the stage type, and sets or clears the closed date;
//   - records stage history (closes the current row, opens a new one) on the same batch;
//   - names the move for the timeline ("Moved to Proposal").
import { CompiledQuery, sql } from "kysely";
import { ValidationError } from "../errors.ts";
import { FIELD_TYPE_REGISTRY } from "../fields/field-types.ts";
import { getObject } from "../fields/index.ts";
import type { FieldDefinition, ObjectDefinition, StagesDefinition } from "../fields/types.ts";
import { newId } from "../ids.ts";
import type { HandlerContext } from "../operation.ts";
import { viewColumnOf } from "./columns.ts";

export type StageType = "open" | "won" | "lost";

/** A stage record as the behaviour needs it. */
export interface StageInfo {
  id: string;
  title: string;
  type: StageType;
  order: number | null;
  requiredFields: string[];
  probability: number | null;
  group: string | null;
}

/** Details of a refused write: which stage, and which fields it needs. */
export interface StageRuleDetails {
  rule: "stage_required_fields" | "stage_not_in_group" | "no_stage";
  object: string;
  /** The first missing field (what a UI asks for first). */
  field: string;
  fields: string[];
  labels: string[];
  stage: { id: string; title: string; type: StageType } | null;
}

/** A write broke a stage rule. `code` is `invalid_input`; details say what to fix. */
export class StageRuleError extends ValidationError {
  override name = "StageRuleError";
  constructor(message: string, details: StageRuleDetails) {
    super(message, details);
  }
}

/** Caches stage reads for one operation (an import touches the same few stages many times). */
export type StageCache = Map<string, StageInfo | null>;

function column(object: ObjectDefinition, field: string): string | null {
  const definition = object.fields.find((f) => f.name === field);
  return definition ? viewColumnOf(definition) : null;
}

function readValue(field: FieldDefinition | undefined, raw: unknown): unknown {
  if (!field?.fieldType) return raw ?? null;
  const type = field.fieldType as keyof typeof FIELD_TYPE_REGISTRY;
  return FIELD_TYPE_REGISTRY[type]?.fromStorage(raw ?? null) ?? raw ?? null;
}

function stageObjectOf(object: ObjectDefinition, stages: StagesDefinition): ObjectDefinition {
  const to = object.fields.find((f) => f.name === stages.field)?.options?.to;
  const target = to ? getObject(to) : undefined;
  if (!target) throw new ValidationError(`${object.name}: its stage object is not installed`);
  return target;
}

/** Reads stages by id (live records only), through the cache. */
export async function loadStages(
  ctx: Pick<HandlerContext, "db">,
  stageObject: ObjectDefinition,
  stages: StagesDefinition,
  ids: readonly string[],
  cache: StageCache = new Map(),
): Promise<Map<string, StageInfo>> {
  const out = new Map<string, StageInfo>();
  const missing = [...new Set(ids)].filter((id) => {
    const hit = cache.get(id);
    if (hit) out.set(id, hit);
    return !cache.has(id);
  });
  if (missing.length) {
    const fieldOf = (name: string | undefined) =>
      name ? stageObject.fields.find((f) => f.name === name) : undefined;
    const rows = await sql<Record<string, unknown>>`
      SELECT * FROM ${sql.table(stageObject.source)}
      WHERE id IN (SELECT value FROM json_each(${JSON.stringify(missing)}))
    `.execute(ctx.db);
    const titleColumn = stageObject.titleField ? column(stageObject, stageObject.titleField) : null;
    const get = (row: Record<string, unknown>, name: string | undefined) => {
      const field = fieldOf(name);
      const col = field ? viewColumnOf(field) : null;
      return col ? readValue(field, row[col]) : null;
    };
    for (const row of rows.rows) {
      const type = get(row, stages.stage.type);
      const required = get(row, stages.stage.requiredFields);
      const order = get(row, stages.stage.order);
      const probability = get(row, stages.stage.probability);
      const group = get(row, stages.stage.group);
      const info: StageInfo = {
        id: String(row.id),
        title: titleColumn ? String(row[titleColumn] ?? row.id) : String(row.id),
        type: type === "won" || type === "lost" ? type : "open",
        order: typeof order === "number" ? order : null,
        requiredFields: Array.isArray(required) ? required.map(String) : [],
        probability: typeof probability === "number" ? probability : null,
        group: typeof group === "string" ? group : null,
      };
      cache.set(info.id, info);
      out.set(info.id, info);
    }
    for (const id of missing) if (!out.has(id)) cache.set(id, null);
  }
  return out;
}

/** The first stage (by order) of a group, or of all stages when the behaviour has no groups. */
async function firstStage(
  ctx: Pick<HandlerContext, "db">,
  stageObject: ObjectDefinition,
  stages: StagesDefinition,
  group: string | null,
): Promise<string | null> {
  const order = column(stageObject, stages.stage.order);
  const groupColumn = stages.stage.group ? column(stageObject, stages.stage.group) : null;
  if (!order) return null;
  const where = groupColumn ? sql`WHERE ${sql.ref(groupColumn)} = ${group}` : sql``;
  const row = await sql<{ id: string }>`
    SELECT id FROM ${sql.table(stageObject.source)} ${where}
    ORDER BY ${sql.ref(order)} IS NULL, ${sql.ref(order)}, id LIMIT 1
  `.execute(ctx.db);
  return row.rows[0]?.id ?? null;
}

function isEmpty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0)
  );
}

export interface StageOutcome {
  /** Values the behaviour sets on top of the caller's (stage, group, probability, status, …). */
  values: Record<string, unknown>;
  /** Stage history statements for the operation's batch. */
  history: CompiledQuery[];
  /** Set when the record changed stage: the stage it entered. */
  moved: StageInfo | null;
  /** The stage it left, when it moved. */
  left: StageInfo | null;
}

const NO_OUTCOME: StageOutcome = { values: {}, history: [], moved: null, left: null };

/**
 * Applies `object`'s stage behaviour to a write. `before` is the record's values before (null on
 * create); `written` the validated values being written. Throws StageRuleError when the write
 * breaks a rule. Records stage history for record `id`.
 */
export async function applyStageBehaviour(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  before: Record<string, unknown> | null,
  written: Record<string, unknown>,
  cache: StageCache = new Map(),
): Promise<StageOutcome> {
  const stages = object.stages;
  if (!stages) return NO_OUTCOME;
  const stageObject = stageObjectOf(object, stages);
  const has = (field: string) => Object.hasOwn(written, field);
  /** Written with a value other than the one stored (UIs may send unchanged fields). */
  const changed = (field: string) =>
    has(field) &&
    JSON.stringify(written[field] ?? null) !== JSON.stringify(before?.[field] ?? null);
  const after: Record<string, unknown> = { ...(before ?? {}), ...written };
  const values: Record<string, unknown> = {};
  const set = (field: string | undefined, value: unknown) => {
    if (!field) return;
    values[field] = value;
    after[field] = value;
  };
  const labelOf = (field: string) => object.fields.find((f) => f.name === field)?.label ?? field;

  const beforeStage = (before?.[stages.field] as string | null | undefined) ?? null;
  let stageId = (after[stages.field] as string | null | undefined) ?? null;
  const group = stages.group;
  const groupChanged = Boolean(group && has(group) && written[group] !== (before?.[group] ?? null));
  const stageWritten = has(stages.field);

  // Default the stage: a new record, or one moved to another group without naming a stage, starts
  // in the group's first stage.
  if ((!stageWritten && (before === null || groupChanged)) || (stageWritten && stageId === null)) {
    if (stageWritten && stageId === null && before !== null) {
      throw new StageRuleError(`${object.label} must be in a stage`, {
        rule: "no_stage",
        object: object.name,
        field: stages.field,
        fields: [stages.field],
        labels: [labelOf(stages.field)],
        stage: null,
      });
    }
    const groupId = group ? ((after[group] as string | null | undefined) ?? null) : null;
    if (!group || groupId) {
      stageId = await firstStage(ctx, stageObject, stages, groupId);
      if (stageId) set(stages.field, stageId);
    }
  }
  if (!stageId) {
    if (before === null && !group) return NO_OUTCOME;
    throw new StageRuleError(
      group
        ? `Choose a ${labelOf(group).toLowerCase()} with at least one stage, or a stage`
        : `${object.label} needs a stage`,
      {
        rule: "no_stage",
        object: object.name,
        field: group ?? stages.field,
        fields: [group ?? stages.field],
        labels: [labelOf(group ?? stages.field)],
        stage: null,
      },
    );
  }

  const loaded = await loadStages(
    ctx,
    stageObject,
    stages,
    beforeStage ? [stageId, beforeStage] : [stageId],
    cache,
  );
  const stage = loaded.get(stageId);
  if (!stage) {
    throw new ValidationError(`${labelOf(stages.field)}: no live stage with id ${stageId}`, {
      field: stages.field,
    });
  }

  // The stage must belong to the record's group; a record without one takes the stage's.
  if (group && stage.group) {
    const groupId = (after[group] as string | null | undefined) ?? null;
    if (groupId === null) set(group, stage.group);
    else if (groupId !== stage.group) {
      throw new StageRuleError(
        `${stage.title} is not a stage of this ${labelOf(group).toLowerCase()}`,
        {
          rule: "stage_not_in_group",
          object: object.name,
          field: stages.field,
          fields: [stages.field],
          labels: [labelOf(stages.field)],
          stage: { id: stage.id, title: stage.title, type: stage.type },
        },
      );
    }
  }

  const moved = stage.id !== beforeStage;
  if (stages.status && (moved || after[stages.status] !== stage.type)) {
    set(stages.status, stage.type);
  }
  if (stages.closedDate && moved) {
    const field = object.fields.find((f) => f.name === stages.closedDate);
    const now = field?.fieldType === "datetime" ? ctx.now : ctx.now.slice(0, 10);
    set(stages.closedDate, stage.type === "open" ? null : now);
  }
  if (stages.probability) {
    const { field, overridden } = stages.probability;
    let isOverridden = before?.[overridden] === true;
    if (changed(overridden) && written[overridden] !== true) isOverridden = false;
    else if (changed(field)) isOverridden = written[field] !== null && written[field] !== undefined;
    else if (changed(overridden)) isOverridden = true;
    if (after[overridden] !== isOverridden) set(overridden, isOverridden);
    if (!isOverridden && after[field] !== stage.probability) set(field, stage.probability);
  }

  // Required fields: everything the stage needs when entering it (or creating in it); afterwards
  // only fields this write changes (so an edit cannot empty them).
  const required = [
    ...new Set([...stage.requiredFields, ...(stages.requiredByType?.[stage.type] ?? [])]),
  ].filter((field) => object.fields.some((f) => f.name === field));
  const checked = moved || before === null ? required : required.filter(changed);
  const missing = checked.filter((field) => isEmpty(after[field]));
  if (missing.length) {
    const labels = missing.map(labelOf);
    throw new StageRuleError(`${stage.title} needs ${labels.join(", ")}`, {
      rule: "stage_required_fields",
      object: object.name,
      field: missing[0] as string,
      fields: missing,
      labels,
      stage: { id: stage.id, title: stage.title, type: stage.type },
    });
  }

  const history: CompiledQuery[] = [];
  if (moved) {
    if (before !== null) {
      history.push(
        CompiledQuery.raw(
          "UPDATE core_stage_history SET left_at = ? WHERE object_type = ? AND record_id = ? AND left_at IS NULL",
          [ctx.now, object.name, id],
        ),
      );
    }
    const groupId = group ? ((after[group] as string | null | undefined) ?? null) : stage.group;
    history.push(
      CompiledQuery.raw(
        "INSERT INTO core_stage_history (id, object_type, record_id, stage_id, group_id, stage_type, entered_at, left_at, entered_by) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)",
        [
          newId("stageHistory"),
          object.name,
          id,
          stage.id,
          groupId,
          stage.type,
          ctx.now,
          ctx.user.id,
        ],
      ),
    );
  }
  return {
    values,
    history,
    moved: moved ? stage : null,
    left: moved && beforeStage ? (loaded.get(beforeStage) ?? null) : null,
  };
}
