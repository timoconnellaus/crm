// assignment.* (stage 15, ADR 0246): the rules that give records created without an owner one,
// the fallback owner per object, a test that shows which rule a sample record would match, and
// `assignment.apply`, which re-runs the rules on chosen records ("Assign by rules"). Changing
// rules and fallbacks is for human admins only; MCP sees them read-only.
import { CompiledQuery, sql } from "kysely";
import { z } from "zod";
import {
  ASSIGNMENT_METHODS,
  type AssignmentRule,
  assignmentConditionSchema,
  assignmentSubject,
  assignOwner,
  loadRules,
  requireOwnedObject,
  ruleFromRow,
  ruleMatches,
  validateConditions,
} from "../assignment/index.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import { fieldStorage, objectTableOf } from "../extensions/schema.ts";
import { getObject, listObjects } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { jsonList } from "../records/common.ts";

const objectName = z
  .string()
  .min(1)
  .max(80)
  .describe("An object with an owner field: person, organisation, or e.g. leads.lead");
const ruleId = z.string().startsWith("asr_").max(64);
const userIds = z.array(z.string().min(1).max(64)).min(1).max(50);

const ruleSchema = z.object({
  id: z.string(),
  object: z.string(),
  name: z.string(),
  position: z.number(),
  enabled: z.boolean(),
  conditions: z.array(assignmentConditionSchema),
  method: z.enum(ASSIGNMENT_METHODS),
  userIds: z.array(z.string()),
});

const ruleInput = {
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean(),
  conditions: z
    .array(assignmentConditionSchema)
    .max(20)
    .describe("All must hold. Empty: the rule matches every record."),
  method: z
    .enum(ASSIGNMENT_METHODS)
    .describe("roundRobin: rotate through userIds in order; user: always the one user"),
  userIds: userIds.describe("The users to rotate through, or the one user"),
};

async function assertAssignableUsers(ctx: HandlerContext, ids: readonly string[]) {
  const found = await ctx.db
    .selectFrom("core_user")
    .select("id")
    .where("id", "in", jsonList(ids))
    .where("kind", "=", "human")
    .execute();
  const have = new Set(found.map((u) => u.id));
  const missing = [...new Set(ids)].filter((id) => !have.has(id));
  if (missing.length) {
    throw new ValidationError(`No user with id ${missing.join(", ")}`, { field: "userIds" });
  }
}

function checkMethod(method: AssignmentRule["method"], ids: readonly string[]) {
  if (method === "user" && ids.length !== 1) {
    throw new ValidationError("A rule that assigns one user needs exactly one user", {
      field: "userIds",
    });
  }
  if (new Set(ids).size !== ids.length) {
    throw new ValidationError("A user is listed twice", { field: "userIds" });
  }
}

async function loadRule(ctx: HandlerContext, id: string): Promise<AssignmentRule> {
  const row = await ctx.db
    .selectFrom("core_assignment_rule")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw new NotFoundError("assignment rule", id);
  return ruleFromRow(row);
}

const ADMIN_ONLY = {
  permission: "settings:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
} as const;

const objectRulesSchema = z.object({
  object: z.string(),
  label: z.string(),
  ownerField: z.string(),
  rules: z.array(ruleSchema),
  fallbackUserId: z.string().nullable().describe("Owner when no rule matches; null: no owner"),
});

export const assignmentList = defineOperation({
  name: "assignment.list",
  description:
    "List the assignment rules: for each object with an owner field (person, organisation, " +
    "and extension objects such as leads.lead and deals.deal), its rules in order and its " +
    "fallback owner. When a record is created without an owner, the first enabled rule whose " +
    "conditions all hold assigns it (round-robin among its users, or one user); otherwise the " +
    "fallback owner. Read-only.",
  input: z.object({ object: objectName.optional() }),
  output: z.object({ objects: z.array(objectRulesSchema) }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const objects = input.object
      ? [requireOwnedObject(input.object)]
      : listObjects().filter((o): o is ObjectDefinition & { ownerField: string } =>
          Boolean(o.ownerField),
        );
    const out: z.input<typeof objectRulesSchema>[] = [];
    for (const object of objects) {
      const loaded = await loadRules(ctx.db, object.name);
      out.push({
        object: object.name,
        label: object.plural ?? (object.name === "person" ? "People" : "Organisations"),
        ownerField: object.ownerField,
        rules: loaded.rules,
        fallbackUserId: loaded.fallback ?? null,
      });
    }
    return { objects: out };
  },
});

export const assignmentGet = defineOperation({
  name: "assignment.get",
  description:
    "Get one assignment rule by id: its object, conditions, method and users. Read-only.",
  input: z.object({ id: ruleId }),
  output: ruleSchema,
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    return loadRule(ctx, input.id);
  },
});

export const assignmentCreate = defineOperation({
  name: "assignment.create",
  description:
    "Add an assignment rule for an object, last in its order (human admins only). Conditions " +
    "name fields of the object, or with `via` a relation field, of the related record (a " +
    "lead's organisation's industry): eq, in (a list), between [low, high] for numbers and " +
    "dates, is_null and is_not_null.",
  input: z.object({ object: objectName, ...ruleInput, enabled: ruleInput.enabled.default(true) }),
  output: ruleSchema,
  ...ADMIN_ONLY,
  async handler(input, ctx) {
    const object = requireOwnedObject(input.object);
    validateConditions(object, input.conditions);
    checkMethod(input.method, input.userIds);
    await assertAssignableUsers(ctx, input.userIds);
    const last = await ctx.db
      .selectFrom("core_assignment_rule")
      .select(sql<number>`coalesce(max(position), 0)`.as("position"))
      .where("object_type", "=", object.name)
      .executeTakeFirst();
    const rule: AssignmentRule = {
      id: newId("assignmentRule"),
      object: object.name,
      name: input.name,
      position: (last?.position ?? 0) + 1,
      enabled: input.enabled,
      conditions: input.conditions,
      method: input.method,
      userIds: input.userIds,
    };
    ctx.write(
      ctx.db.insertInto("core_assignment_rule").values({
        id: rule.id,
        object_type: rule.object,
        name: rule.name,
        position: rule.position,
        enabled: rule.enabled ? 1 : 0,
        conditions: JSON.stringify(rule.conditions),
        method: rule.method,
        user_ids: JSON.stringify(rule.userIds),
        created_at: ctx.now,
        created_by: ctx.user.id,
        updated_at: ctx.now,
        updated_by: ctx.user.id,
      }),
    );
    return rule;
  },
});

export const assignmentUpdate = defineOperation({
  name: "assignment.update",
  description:
    "Change an assignment rule's name, conditions, method, users or whether it is on (human " +
    "admins only). Fields left out stay as they are.",
  input: z.object({
    id: ruleId,
    name: ruleInput.name.optional(),
    enabled: ruleInput.enabled.optional(),
    conditions: ruleInput.conditions.optional(),
    method: ruleInput.method.optional(),
    userIds: ruleInput.userIds.optional(),
  }),
  output: ruleSchema,
  ...ADMIN_ONLY,
  async handler(input, ctx) {
    const before = await loadRule(ctx, input.id);
    const object = requireOwnedObject(before.object);
    const rule: AssignmentRule = {
      ...before,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.conditions !== undefined ? { conditions: input.conditions } : {}),
      ...(input.method !== undefined ? { method: input.method } : {}),
      ...(input.userIds !== undefined ? { userIds: input.userIds } : {}),
    };
    validateConditions(object, rule.conditions);
    checkMethod(rule.method, rule.userIds);
    if (input.userIds) await assertAssignableUsers(ctx, input.userIds);
    ctx.write(
      ctx.db
        .updateTable("core_assignment_rule")
        .set({
          name: rule.name,
          enabled: rule.enabled ? 1 : 0,
          conditions: JSON.stringify(rule.conditions),
          method: rule.method,
          user_ids: JSON.stringify(rule.userIds),
          updated_at: ctx.now,
          updated_by: ctx.user.id,
        })
        .where("id", "=", rule.id),
    );
    return rule;
  },
});

export const assignmentDelete = defineOperation({
  name: "assignment.delete",
  description:
    "Delete an assignment rule (human admins only). Records it assigned keep their owners.",
  input: z.object({ id: ruleId }),
  output: z.object({ id: z.string() }),
  ...ADMIN_ONLY,
  async handler(input, ctx) {
    await loadRule(ctx, input.id);
    ctx.write(
      ctx.db.deleteFrom("core_assignment_rule").where("id", "=", input.id),
      ctx.db.deleteFrom("core_assignment_state").where("rule_id", "=", input.id),
    );
    return { id: input.id };
  },
});

export const assignmentReorder = defineOperation({
  name: "assignment.reorder",
  description:
    "Set the order of an object's assignment rules (human admins only): pass every rule id of " +
    "the object, first first. The first enabled rule that matches wins.",
  input: z.object({ object: objectName, ids: z.array(ruleId).max(200) }),
  output: z.object({ rules: z.array(ruleSchema) }),
  ...ADMIN_ONLY,
  async handler(input, ctx) {
    const object = requireOwnedObject(input.object);
    const { rules } = await loadRules(ctx.db, object.name);
    const have = new Set(rules.map((r) => r.id));
    if (
      input.ids.length !== rules.length ||
      new Set(input.ids).size !== input.ids.length ||
      input.ids.some((id) => !have.has(id))
    ) {
      throw new ValidationError(`Pass every rule of ${object.name} exactly once`, {
        field: "ids",
      });
    }
    const ordered = input.ids.map((id, i) => ({
      ...(rules.find((r) => r.id === id) as AssignmentRule),
      position: i + 1,
    }));
    for (const rule of ordered) {
      ctx.write(
        ctx.db
          .updateTable("core_assignment_rule")
          .set({ position: rule.position, updated_at: ctx.now, updated_by: ctx.user.id })
          .where("id", "=", rule.id),
      );
    }
    return { rules: ordered };
  },
});

export const assignmentSetFallback = defineOperation({
  name: "assignment.setFallback",
  description:
    "Set the owner given to records of an object when no assignment rule matches (human " +
    "admins only). null: such records get no owner.",
  input: z.object({ object: objectName, userId: z.string().min(1).max(64).nullable() }),
  output: z.object({ object: z.string(), userId: z.string().nullable() }),
  ...ADMIN_ONLY,
  async handler(input, ctx) {
    const object = requireOwnedObject(input.object);
    if (input.userId) await assertAssignableUsers(ctx, [input.userId]);
    ctx.write(
      ctx.db
        .insertInto("core_assignment_fallback")
        .values({
          object_type: object.name,
          user_id: input.userId,
          updated_at: ctx.now,
          updated_by: ctx.user.id,
        })
        .onConflict((oc) =>
          oc.column("object_type").doUpdateSet({
            user_id: input.userId,
            updated_at: ctx.now,
            updated_by: ctx.user.id,
          }),
        ),
    );
    return { object: object.name, userId: input.userId };
  },
});

export const assignmentTest = defineOperation({
  name: "assignment.test",
  description:
    "Show which assignment rule a sample record would match and who it would be assigned to, " +
    "without creating anything or moving a round-robin rotation. `values` are field values by " +
    "registry name; for conditions with `via`, give the related record's id as that relation " +
    "field's value (e.g. organisation). Read-only.",
  input: z.object({
    object: objectName,
    values: z.record(z.string().max(80), z.unknown()).default({}),
  }),
  output: z.object({
    ruleId: z.string().nullable(),
    ruleName: z.string().nullable(),
    ownerId: z.string().nullable(),
    ownerName: z.string().nullable(),
    fallback: z.boolean().describe("True when no rule matched and the fallback owner applies"),
  }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const object = requireOwnedObject(input.object);
    const { rules, fallback } = await loadRules(ctx.db, object.name, { enabledOnly: true });
    const ids = [...rules.flatMap((r) => r.userIds), ...(fallback ? [fallback] : [])];
    const users = ids.length
      ? await ctx.db
          .selectFrom("core_user")
          .select(["id", "name", "deactivated_at"])
          .where("id", "in", jsonList(ids))
          .execute()
      : [];
    const active = new Map(users.filter((u) => !u.deactivated_at).map((u) => [u.id, u.name]));
    const related = new Map<string, Record<string, unknown> | null>();
    for (const via of new Set(rules.flatMap((r) => r.conditions.flatMap((c) => c.via ?? [])))) {
      const target = getObject(object.fields.find((f) => f.name === via)?.options?.to ?? "");
      const id = input.values[via];
      if (!target || typeof id !== "string") continue;
      const { rows } = await sql<Record<string, unknown>>`
        SELECT * FROM ${sql.table(target.source)} WHERE id = ${id}
      `.execute(ctx.db);
      related.set(via, rows[0] ?? null);
    }
    const record = { get: (field: string) => input.values[field] ?? null };
    for (const rule of rules) {
      const pool = rule.userIds.filter((id) => active.has(id));
      if (!pool.length || !ruleMatches(object, rule, record, (via) => related.get(via) ?? null)) {
        continue;
      }
      let ownerId = pool[0] as string;
      if (rule.method === "roundRobin") {
        const state = await ctx.db
          .selectFrom("core_assignment_state")
          .select("next_index")
          .where("rule_id", "=", rule.id)
          .executeTakeFirst();
        ownerId = pool[(state?.next_index ?? 0) % pool.length] as string;
      }
      return {
        ruleId: rule.id,
        ruleName: rule.name,
        ownerId,
        ownerName: active.get(ownerId) ?? null,
        fallback: false,
      };
    }
    const owner = fallback && active.has(fallback) ? fallback : null;
    return {
      ruleId: null,
      ruleName: null,
      ownerId: owner,
      ownerName: owner ? (active.get(owner) ?? null) : null,
      fallback: true,
    };
  },
});

export const ASSIGNMENT_APPLY_LIMIT = 200;

/** The row's value of a registry field (by its view column). */
function rowValue(object: ObjectDefinition, row: Record<string, unknown>, field: string): unknown {
  const column = object.fields.find((f) => f.name === field)?.column;
  return column ? (row[column] ?? null) : null;
}

export const assignmentApply = defineOperation({
  name: "assignment.apply",
  description:
    'Re-run the assignment rules on existing records ("Assign by rules" in a list): each ' +
    `record (at most ${ASSIGNMENT_APPLY_LIMIT}) gets the owner the rules give it now, as if it ` +
    "were new; round-robin rules continue their rotation. Records no rule (and no fallback " +
    "owner) assigns keep their owner. Each change is audited with the rule's name and posted on " +
    "the record's timeline.",
  input: z.object({
    object: objectName,
    ids: z.array(z.string().min(1).max(64)).min(1).max(ASSIGNMENT_APPLY_LIMIT),
  }),
  output: z.object({
    items: z.array(
      z.object({
        id: z.string(),
        ownerId: z.string().nullable(),
        ruleName: z.string().nullable(),
        changed: z.boolean(),
      }),
    ),
  }),
  permission: "records:write",
  risk: "bulk-write",
  bulkSize: (input) => input.ids.length,
  async handler(input, ctx) {
    const object = requireOwnedObject(input.object);
    const ownerField = object.ownerField;
    const ids = [...new Set(input.ids)];
    const core = object.name === "person" || object.name === "organisation";
    const { rows } = await sql<Record<string, unknown>>`
      SELECT * FROM ${sql.table(object.source)}
      WHERE id IN ${sql`(SELECT value FROM json_each(${JSON.stringify(ids)}))`}
      ${core ? sql`AND deleted_at IS NULL` : sql``}
    `.execute(ctx.db);
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) throw new NotFoundError(object.name, missing.join(", "));
    const tracked = object.fields.find((f) => f.name === ownerField)?.track === "timeline";
    const items: {
      id: string;
      ownerId: string | null;
      ruleName: string | null;
      changed: boolean;
    }[] = [];
    for (const id of ids) {
      const row = byId.get(id) as Record<string, unknown>;
      const before = rowValue(object, row, ownerField) as string | null;
      const assignment = await assignOwner(ctx, object, {
        get: (field) => rowValue(object, row, field),
      });
      if (!assignment?.ownerId || assignment.ownerId === before) {
        items.push({ id, ownerId: before, ruleName: assignment?.ruleName ?? null, changed: false });
        continue;
      }
      ctx.write(ownerUpdate(object, id, assignment.ownerId, ctx.now, ctx.user.id));
      const subject = assignmentSubject(assignment);
      if (!tracked) {
        ctx.postActivity({
          subject,
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
      ctx.recordChange({
        object: object.name,
        id,
        action: "update",
        before: { [ownerField]: before },
        after: { [ownerField]: assignment.ownerId },
        assignment: { field: ownerField, rule: assignment.ruleName ?? "Fallback owner" },
        ...(tracked ? { timeline: { subject } } : {}),
      });
      items.push({ id, ownerId: assignment.ownerId, ruleName: assignment.ruleName, changed: true });
    }
    return { items };
  },
});

/** The statement that sets a record's owner. */
function ownerUpdate(
  object: ObjectDefinition,
  id: string,
  ownerId: string,
  now: string,
  userId: string,
) {
  if (object.name === "person" || object.name === "organisation") {
    const table = object.name === "person" ? "core_person" : "core_organisation";
    return CompiledQuery.raw(`UPDATE ${table} SET owner_id = ?, updated_at = ? WHERE id = ?`, [
      ownerId,
      now,
      id,
    ]);
  }
  const storage = fieldStorage(object.name, object.ownerField ?? "");
  const table = objectTableOf(object.name);
  if (!storage?.column || !storage.own || !table) {
    throw new ValidationError(`${object.name} cannot be reassigned`);
  }
  return CompiledQuery.raw(
    `UPDATE ${table} SET ${storage.column} = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
    [ownerId, now, userId, id],
  );
}

export const assignmentOperations = [
  assignmentList,
  assignmentGet,
  assignmentCreate,
  assignmentUpdate,
  assignmentDelete,
  assignmentReorder,
  assignmentSetFallback,
  assignmentTest,
  assignmentApply,
] as const;
