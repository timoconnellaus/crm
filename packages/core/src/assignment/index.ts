// Assignment rules (stage 15, ADR 0246): who owns a record created without an owner. Rules are
// per object (person, organisation, and any extension object declaring `owner`), ordered; the
// first enabled rule whose conditions all hold picks the owner, by round-robin among chosen users
// (deactivated users skipped) or one user; otherwise the object's fallback owner, or none.
//
// Every create path calls `assignOwner` inside its own handler, so the owner is in the record's
// insert and no unowned record is ever readable. Per invocation it reads the object's rules and
// fallback once (one query), the rules' users once, each round-robin rule's state once, and each
// related record a condition names once (by id). Round-robin owners come from the state read,
// and the state is advanced in the invocation's batch by one guarded statement per rule: if
// another create advanced it meanwhile the guard writes -1, the CHECK fails the batch, and the
// pipeline runs the call again (`isAssignmentConflict`). So assignment is exact in sequence,
// one statement per rule per call (an import chunk adds one state read and one write).
import { type Compilable, CompiledQuery, sql } from "kysely";
import { z } from "zod";
import { ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import type { FieldDefinition, ObjectDefinition } from "../fields/types.ts";
import { compileFilter, OPS_BY_TYPE } from "../filter.ts";
import type { HandlerContext } from "../operation.ts";
import { jsonList } from "../records/common.ts";

export const ASSIGNMENT_OPS = ["eq", "in", "between", "is_null", "is_not_null"] as const;
export type AssignmentOp = (typeof ASSIGNMENT_OPS)[number];

export const assignmentConditionSchema = z.object({
  field: z.string().min(1).max(80).describe("A field of the object (or of the `via` record)"),
  op: z
    .enum(ASSIGNMENT_OPS)
    .describe("eq (equals), in (is one of), between [low, high], is_null, is_not_null"),
  value: z.unknown().optional(),
  via: z
    .string()
    .min(1)
    .max(40)
    .optional()
    .describe("A relation field (e.g. `organisation`): test the related record's field instead"),
});
export type AssignmentCondition = z.infer<typeof assignmentConditionSchema>;

export const ASSIGNMENT_METHODS = ["roundRobin", "user"] as const;
export type AssignmentMethod = (typeof ASSIGNMENT_METHODS)[number];

export interface AssignmentRule {
  id: string;
  object: string;
  name: string;
  position: number;
  enabled: boolean;
  conditions: AssignmentCondition[];
  method: AssignmentMethod;
  userIds: string[];
}

/** What assignment decided for one record. */
export interface Assignment {
  ownerId: string | null;
  /** The rule that matched; null when the fallback owner (or no owner) applied. */
  ruleId: string | null;
  ruleName: string | null;
  /** The owner's name, for the timeline. */
  ownerName: string | null;
}

/** The objects assignment rules apply to: those with an owner field. */
export function requireOwnedObject(name: string): ObjectDefinition & { ownerField: string } {
  const object = getObject(name);
  if (!object?.ownerField) {
    throw new ValidationError(`${name} has no owner field, so assignment rules do not apply`, {
      field: "object",
    });
  }
  return object as ObjectDefinition & { ownerField: string };
}

/** The object a condition's `via` relation points at, or the object itself. */
function conditionTarget(object: ObjectDefinition, condition: AssignmentCondition) {
  if (!condition.via) return object;
  const relation = object.fields.find((f) => f.name === condition.via);
  const to = relation?.options?.to;
  if (relation?.fieldType !== "relation" || relation.options?.many || !to) {
    throw new ValidationError(
      `${object.name}.${condition.via} is not a relation to one record, so it cannot be used as via`,
      { field: "conditions", via: condition.via },
    );
  }
  const target = getObject(to);
  if (!target) throw new ValidationError(`Unknown object ${to}`, { field: "conditions" });
  return target;
}

/**
 * Checks conditions against the field registry and the filter compiler's value rules: each names
 * a single-valued, filterable field (of the object or, with `via`, of the related record) and an
 * operator its type supports. Throws ValidationError naming the condition.
 */
export function validateConditions(
  object: ObjectDefinition,
  conditions: readonly AssignmentCondition[],
): void {
  conditions.forEach((condition, i) => {
    const target = conditionTarget(object, condition);
    const field = target.fields.find((f) => f.name === condition.field);
    const where = `conditions[${i}]`;
    if (!field?.filterable || !field.column) {
      throw new ValidationError(
        `${where}: ${target.name} has no single-valued field "${condition.field}" to test`,
        { field: "conditions", index: i },
      );
    }
    if (!OPS_BY_TYPE[field.type].includes(condition.op)) {
      throw new ValidationError(`${where}: ${condition.op} does not apply to ${field.label}`, {
        field: "conditions",
        index: i,
      });
    }
    if (condition.op === "between" && field.type !== "number" && !field.type.startsWith("date")) {
      throw new ValidationError(`${where}: between needs a number, currency or date field`, {
        field: "conditions",
        index: i,
      });
    }
    // The filter compiler checks the value against the field's type (and select choices).
    compileFilter(target, { field: field.name, op: condition.op, value: condition.value });
  });
}

// --- Evaluation ------------------------------------------------------------------------------

function isEmpty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0)
  );
}

/** A value as the filter compiler compares it (text case-insensitively, booleans as 0/1). */
function comparable(field: FieldDefinition, value: unknown): string | number | null {
  if (isEmpty(value)) return null;
  switch (field.type) {
    case "number": {
      const n = typeof value === "number" ? value : Number(value);
      return Number.isFinite(n) ? n : null;
    }
    case "boolean":
      return value === true || value === 1 || value === "1" || value === "true" ? 1 : 0;
    case "text":
      return String(value).toLowerCase();
    default:
      return String(value);
  }
}

/** Whether one condition holds for a field's value (same semantics as compileFilter's SQL). */
export function conditionHolds(
  field: FieldDefinition,
  condition: AssignmentCondition,
  value: unknown,
): boolean {
  const actual = comparable(field, value);
  switch (condition.op) {
    case "is_null":
      return actual === null;
    case "is_not_null":
      return actual !== null;
    case "eq":
      return actual !== null && actual === comparable(field, condition.value);
    case "in":
      return (
        actual !== null &&
        Array.isArray(condition.value) &&
        condition.value.some((v) => comparable(field, v) === actual)
      );
    case "between": {
      if (actual === null || !Array.isArray(condition.value)) return false;
      const [low, high] = condition.value.map((v) => comparable(field, v));
      if (low === null || low === undefined || high === null || high === undefined) return false;
      return actual >= low && actual <= high;
    }
  }
}

/** A record's values, by registry field name, and its related records' rows (by view column). */
export interface RecordValues {
  get(field: string): unknown;
}

/** Whether every condition of `rule` holds for the record (related rows loaded by the caller). */
export function ruleMatches(
  object: ObjectDefinition,
  rule: Pick<AssignmentRule, "conditions">,
  record: RecordValues,
  related: (via: string) => Record<string, unknown> | null,
): boolean {
  return rule.conditions.every((condition) => {
    const target = getObject(
      condition.via
        ? (object.fields.find((f) => f.name === condition.via)?.options?.to ?? "")
        : object.name,
    );
    const field = target?.fields.find((f) => f.name === condition.field);
    if (!target || !field) return false;
    if (!condition.via) return conditionHolds(field, condition, record.get(field.name));
    const row = related(condition.via);
    return conditionHolds(field, condition, row && field.column ? row[field.column] : null);
  });
}

// --- Loading -----------------------------------------------------------------------------------

interface LoadedRules {
  rules: AssignmentRule[];
  /** The fallback owner: undefined when none is set, null for "no owner". */
  fallback: string | null | undefined;
}

export function ruleFromRow(row: {
  id: string;
  object_type: string;
  name: string;
  position: number;
  enabled: number;
  conditions: string;
  method: string;
  user_ids: string;
}): AssignmentRule {
  return {
    id: row.id,
    object: row.object_type,
    name: row.name,
    position: row.position,
    enabled: row.enabled === 1,
    conditions: JSON.parse(row.conditions) as AssignmentCondition[],
    method: row.method as AssignmentMethod,
    userIds: JSON.parse(row.user_ids) as string[],
  };
}

/** An object's rules in order and its fallback owner: one indexed query. */
export async function loadRules(
  db: HandlerContext["db"],
  object: string,
  options: { enabledOnly?: boolean } = {},
): Promise<LoadedRules> {
  const { rows } = await sql<{
    kind: "rule" | "fallback";
    id: string;
    object_type: string;
    name: string;
    position: number;
    enabled: number;
    conditions: string;
    method: string;
    user_ids: string;
  }>`
    SELECT 'rule' AS kind, id, object_type, name, position, enabled, conditions, method, user_ids
    FROM core_assignment_rule
    WHERE object_type = ${object} ${options.enabledOnly ? sql`AND enabled = 1` : sql``}
    UNION ALL
    SELECT 'fallback', '', object_type, '', 0, 1, '[]', 'user', coalesce(json_array(user_id), '[]')
    FROM core_assignment_fallback WHERE object_type = ${object}
    ORDER BY kind DESC, position
  `.execute(db);
  const fallbackRow = rows.find((r) => r.kind === "fallback");
  const fallbackIds = fallbackRow ? (JSON.parse(fallbackRow.user_ids) as (string | null)[]) : [];
  return {
    rules: rows.filter((r) => r.kind === "rule").map(ruleFromRow),
    fallback: fallbackRow ? (fallbackIds[0] ?? null) : undefined,
  };
}

interface UserInfo {
  name: string;
  active: boolean;
}

/** Per-invocation assignment state: rules, users, round-robin positions and related rows. */
interface InvocationState {
  rules: Map<string, LoadedRules>;
  users: Map<string, UserInfo | null>;
  rotation: Map<string, { base: number; used: number }>;
  related: Map<string, Record<string, unknown> | null>;
}

const states = new WeakMap<object, InvocationState>();

function stateOf(ctx: HandlerContext): InvocationState {
  let state = states.get(ctx);
  if (!state) {
    state = { rules: new Map(), users: new Map(), rotation: new Map(), related: new Map() };
    states.set(ctx, state);
  }
  return state;
}

async function loadUsers(ctx: HandlerContext, state: InvocationState, ids: readonly string[]) {
  const missing = [...new Set(ids)].filter((id) => !state.users.has(id));
  if (!missing.length) return;
  const rows = await ctx.db
    .selectFrom("core_user")
    .select(["id", "name", "deactivated_at"])
    .where("id", "in", jsonList(missing))
    .where("kind", "=", "human")
    .execute();
  for (const id of missing) state.users.set(id, null);
  for (const row of rows) {
    state.users.set(row.id, { name: row.name, active: row.deactivated_at === null });
  }
}

async function loadRelated(
  ctx: HandlerContext,
  state: InvocationState,
  object: ObjectDefinition,
  via: string,
  id: unknown,
): Promise<Record<string, unknown> | null> {
  if (typeof id !== "string" || !id) return null;
  const to = object.fields.find((f) => f.name === via)?.options?.to;
  const target = to ? getObject(to) : undefined;
  if (!target) return null;
  const key = `${target.name}|${id}`;
  if (!state.related.has(key)) {
    const { rows } = await sql<Record<string, unknown>>`
      SELECT * FROM ${sql.table(target.source)} WHERE id = ${id}
    `.execute(ctx.db);
    state.related.set(key, rows[0] ?? null);
  }
  return state.related.get(key) ?? null;
}

/** The guarded state write for a round-robin rule, compiled at commit with the final count. */
function rotationWrite(
  ruleId: string,
  rotation: { base: number; used: number },
  now: string,
): Compilable {
  return {
    compile: () =>
      CompiledQuery.raw(
        "INSERT INTO core_assignment_state (rule_id, next_index, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT (rule_id) DO UPDATE SET next_index = CASE WHEN " +
          "core_assignment_state.next_index = ? THEN excluded.next_index ELSE -1 END, " +
          "updated_at = excluded.updated_at",
        [ruleId, rotation.base + rotation.used, now, rotation.base],
      ),
  };
}

/**
 * Chooses the owner of a record of `object` being created without one, from the rules. Returns
 * null when the object has no rules and no fallback owner (nothing to record). Round-robin picks
 * are reserved in this invocation's batch.
 */
export async function assignOwner(
  ctx: HandlerContext,
  object: ObjectDefinition,
  record: RecordValues,
): Promise<Assignment | null> {
  if (!object.ownerField) return null;
  const state = stateOf(ctx);
  let loaded = state.rules.get(object.name);
  if (!loaded) {
    loaded = await loadRules(ctx.db, object.name, { enabledOnly: true });
    state.rules.set(object.name, loaded);
  }
  if (!loaded.rules.length && loaded.fallback === undefined) return null;
  await loadUsers(ctx, state, [
    ...loaded.rules.flatMap((r) => r.userIds),
    ...(loaded.fallback ? [loaded.fallback] : []),
  ]);
  const active = (ids: readonly string[]) => ids.filter((id) => state.users.get(id)?.active);

  const vias = [...new Set(loaded.rules.flatMap((r) => r.conditions.flatMap((c) => c.via ?? [])))];
  const related = new Map<string, Record<string, unknown> | null>();
  for (const via of vias) {
    related.set(via, await loadRelated(ctx, state, object, via, record.get(via)));
  }

  for (const rule of loaded.rules) {
    const users = active(rule.userIds);
    if (!users.length) continue;
    if (!ruleMatches(object, rule, record, (via) => related.get(via) ?? null)) continue;
    let ownerId = users[0] as string;
    if (rule.method === "roundRobin") {
      let rotation = state.rotation.get(rule.id);
      if (!rotation) {
        const row = await ctx.db
          .selectFrom("core_assignment_state")
          .select("next_index")
          .where("rule_id", "=", rule.id)
          .executeTakeFirst();
        rotation = { base: row?.next_index ?? 0, used: 0 };
        state.rotation.set(rule.id, rotation);
        ctx.write(rotationWrite(rule.id, rotation, ctx.now));
      }
      ownerId = users[(rotation.base + rotation.used) % users.length] as string;
      rotation.used += 1;
    }
    return {
      ownerId,
      ruleId: rule.id,
      ruleName: rule.name,
      ownerName: state.users.get(ownerId)?.name ?? null,
    };
  }
  const fallback =
    loaded.fallback && state.users.get(loaded.fallback)?.active ? loaded.fallback : null;
  return {
    ownerId: fallback,
    ruleId: null,
    ruleName: null,
    ownerName: fallback ? (state.users.get(fallback)?.name ?? null) : null,
  };
}

/** The timeline subject for an assignment: "Assigned to Sam by rule West coast". */
export function assignmentSubject(assignment: Assignment): string {
  const who = assignment.ownerName ?? "someone";
  return assignment.ruleName
    ? `Assigned to ${who} by rule ${assignment.ruleName}`
    : `Assigned to ${who} (fallback owner)`;
}

/**
 * Records an assignment on a created record: the owner's audit diff entry names the rule
 * (`assignedBy`), and (unless `timeline: false`, for bulk imports) the record's timeline says
 * "Assigned to X by rule Y".
 */
export function recordAssignment(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  assignment: Assignment,
  options: { timeline?: boolean } = {},
): { field: string; rule: string } | undefined {
  if (!assignment.ownerId || !object.ownerField) return undefined;
  if (options.timeline !== false) {
    ctx.postActivity({
      subject: assignmentSubject(assignment),
      payload: {
        kind: "assignment",
        object: object.name,
        recordId: id,
        ownerId: assignment.ownerId,
        ruleId: assignment.ruleId,
        rule: assignment.ruleName,
      },
      links: [{ object: object.name, id }],
    });
  }
  return { field: object.ownerField, rule: assignment.ruleName ?? "Fallback owner" };
}

/** True when a batch failed because a round-robin state moved under it (retry the call). */
export function isAssignmentConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("core_assignment_state_conflict");
}
