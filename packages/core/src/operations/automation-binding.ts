// Automation run-as operations (ADR 0051, ADR 0170): binding an automation's declared connections
// and withdrawing that consent, and deactivating a person (which revokes every binding on the
// connections they own).
//
// - automation.bindConnection: a person binds a declared slot to a connection they own (personal)
//   or, as an admin, to an org connection. The row records who consented and when. Binding the
//   last slot lifts the "Waiting for connections" pause.
// - automation.unbindConnection: the binder, the connection's owner or an admin withdraws it. The
//   automation waits for connections again and the admins are told.
// - user.deactivate / user.reactivate: admins, humans only. Deactivation revokes the bindings on
//   the person's connections and pauses the automations that used them.
import { z } from "zod";
import {
  type AutomationBinding,
  CONNECTION_REVOKED_PREFIX,
  connectionServes,
  declaredConnections,
  loadBindings,
  revokeBindingsPlan,
  unboundSlots,
  WAITING_FOR_CONNECTIONS,
} from "../automations/bindings.ts";
import { parseSpec } from "../automations/registry.ts";
import { automationIdSchema } from "../automations/schemas.ts";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.ts";
import { notifyStatements } from "../notifications/send.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { roleHasPermission } from "../principals.ts";
import { jsonList } from "../records/common.ts";

/** One declared connection of an automation, with its live binding (if any). */
export const automationConnectionViewSchema = z.object({
  slot: z.string(),
  gatekeeper: z.string(),
  purpose: z.string(),
  binding: z
    .object({
      connectionId: z.string(),
      connectionTitle: z.string(),
      scope: z.enum(["personal", "org"]),
      status: z.string(),
      ownerUserId: z.string(),
      ownerName: z.string().nullable(),
      boundBy: z.string(),
      boundByName: z.string().nullable(),
      boundAt: z.string(),
    })
    .nullable(),
  /** The last revoked binding of the slot (shown as "Revoked … because …"), when unbound. */
  revoked: z
    .object({
      connectionTitle: z.string().nullable(),
      revokedAt: z.string(),
      revokedByName: z.string().nullable(),
      reason: z.string().nullable(),
    })
    .nullable(),
});
export type AutomationConnectionView = z.infer<typeof automationConnectionViewSchema>;

const bindingOutput = z.object({
  id: z.string(),
  pausedReason: z.string().nullable(),
  connections: z.array(automationConnectionViewSchema),
});

const slotSchema = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9]{0,39}$/)
  .describe("The connection id the automation declares (`connections[].id`)");

async function loadAutomationRow(ctx: HandlerContext, id: string) {
  const row = await ctx.db
    .selectFrom("core_automations")
    .select(["id", "label", "spec", "paused_reason", "removed_at"])
    .where("id", "=", id)
    .executeTakeFirst();
  const spec = row ? parseSpec(row.spec) : null;
  if (!row || !spec) throw new NotFoundError("automation", id);
  if (row.removed_at) {
    throw new ValidationError(`${id} was removed from its extension`, { id });
  }
  return { row, spec };
}

/** The declared slots of an automation with their bindings, for automation.get and these ops. */
export async function connectionViews(
  ctx: Pick<HandlerContext, "db">,
  automationId: string,
  declared: readonly { id: string; gatekeeper: string; purpose: string }[],
  preloaded?: readonly AutomationBinding[],
): Promise<AutomationConnectionView[]> {
  if (!declared.length) return [];
  const bindings = preloaded ?? (await loadBindings(ctx.db, [automationId]));
  const connectionIds = [...new Set(bindings.map((b) => b.connectionId))];
  const connections = connectionIds.length
    ? await ctx.db
        .selectFrom("core_integration_connection")
        .select(["id", "title", "scope", "status", "owner_user_id"])
        .where("id", "in", jsonList(connectionIds))
        .execute()
    : [];
  const userIds = [
    ...new Set([
      ...bindings.flatMap((b) => [b.boundBy, b.revokedBy].filter((v): v is string => !!v)),
      ...connections.map((c) => c.owner_user_id),
    ]),
  ];
  const users = userIds.length
    ? await ctx.db
        .selectFrom("core_user")
        .select(["id", "name"])
        .where("id", "in", jsonList(userIds))
        .execute()
    : [];
  const name = (id: string | null) => (id ? (users.find((u) => u.id === id)?.name ?? null) : null);
  return declared.map((d) => {
    const live = bindings.find((b) => b.slot === d.id && b.revokedAt === null);
    const last = bindings.find((b) => b.slot === d.id && b.revokedAt !== null);
    const connection = live ? connections.find((c) => c.id === live.connectionId) : undefined;
    return {
      slot: d.id,
      gatekeeper: d.gatekeeper,
      purpose: d.purpose,
      binding:
        live && connection
          ? {
              connectionId: connection.id,
              connectionTitle: connection.title,
              scope: connection.scope,
              status: connection.status,
              ownerUserId: connection.owner_user_id,
              ownerName: name(connection.owner_user_id),
              boundBy: live.boundBy,
              boundByName: name(live.boundBy),
              boundAt: live.boundAt,
            }
          : null,
      revoked:
        !live && last?.revokedAt
          ? {
              connectionTitle: connections.find((c) => c.id === last.connectionId)?.title ?? null,
              revokedAt: last.revokedAt,
              revokedByName: name(last.revokedBy),
              reason: last.revokeReason,
            }
          : null,
    };
  });
}

export const automationBindConnection = defineOperation({
  name: "automation.bindConnection",
  description:
    "Bind one connection an automation declares (its `connections[].id`) to a connection: one " +
    "you own, or an org connection (admins). This is your consent that the automation's steps " +
    "use it as the connection's owner; it is recorded and can be withdrawn. Binding the last " +
    "declared connection lets a waiting automation run. People only.",
  input: z.object({ id: automationIdSchema, slot: slotSchema, connectionId: z.string().max(64) }),
  output: bindingOutput,
  permission: "records:write",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const { row, spec } = await loadAutomationRow(ctx, input.id);
    const declared = declaredConnections(spec);
    const slot = declared.find((c) => c.id === input.slot);
    if (!slot) {
      throw new ValidationError(
        `${input.id} declares no connection “${input.slot}” (it declares ${
          declared.map((c) => c.id).join(", ") || "none"
        })`,
        { field: "slot" },
      );
    }
    const connection = await ctx.db
      .selectFrom("core_integration_connection")
      .select(["id", "vendor", "scope", "owner_user_id", "status", "title"])
      .where("id", "=", input.connectionId)
      .executeTakeFirst();
    if (!connection) throw new NotFoundError("connection", input.connectionId);
    if (connection.scope === "personal" && connection.owner_user_id !== ctx.user.id) {
      throw new ForbiddenError("You can bind only your own personal connections", {
        connectionId: connection.id,
      });
    }
    if (connection.scope === "org" && !roleHasPermission(ctx.user.role, "integrations:manage")) {
      throw new ForbiddenError("Only an admin can bind an org connection to an automation", {
        connectionId: connection.id,
      });
    }
    if (connection.status !== "active") {
      throw new ConflictError(`${connection.title} is ${connection.status}; reconnect it first`, {
        connectionId: connection.id,
      });
    }
    if (!connectionServes(connection.vendor, slot.gatekeeper)) {
      throw new ValidationError(
        `“${slot.id}” needs a ${slot.gatekeeper} connection; ${connection.title} is ${connection.vendor}`,
        { field: "connectionId" },
      );
    }
    const before = await loadBindings(ctx.db, [row.id]);
    const previous = before.find((b) => b.slot === slot.id);
    ctx.write(
      ctx.db
        .insertInto("core_automation_binding")
        .values({
          automation_id: row.id,
          slot: slot.id,
          gatekeeper: slot.gatekeeper,
          purpose: slot.purpose,
          connection_id: connection.id,
          bound_by: ctx.user.id,
          bound_at: ctx.now,
          revoked_at: null,
          revoked_by: null,
          revoke_reason: null,
        })
        .onConflict((oc) =>
          oc.columns(["automation_id", "slot"]).doUpdateSet({
            gatekeeper: slot.gatekeeper,
            purpose: slot.purpose,
            connection_id: connection.id,
            bound_by: ctx.user.id,
            bound_at: ctx.now,
            revoked_at: null,
            revoked_by: null,
            revoke_reason: null,
          }),
        ),
    );
    const after: AutomationBinding = {
      automationId: row.id,
      slot: slot.id,
      gatekeeper: slot.gatekeeper,
      purpose: slot.purpose,
      connectionId: connection.id,
      boundBy: ctx.user.id,
      boundAt: ctx.now,
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
    };
    const bindings = [...before.filter((b) => b.slot !== slot.id), after];
    let pausedReason = row.paused_reason;
    if (pausedReason === WAITING_FOR_CONNECTIONS && !unboundSlots(spec, bindings).length) {
      pausedReason = null;
      ctx.write(
        ctx.db
          .updateTable("core_automations")
          .set({ paused_reason: null, paused_at: null, updated_at: ctx.now })
          .where("id", "=", row.id)
          .where("paused_reason", "=", WAITING_FOR_CONNECTIONS),
      );
    }
    ctx.recordChange({
      object: "automation",
      id: row.id,
      action: "update",
      before: {
        [`connection:${slot.id}`]:
          previous && previous.revokedAt === null ? previous.connectionId : null,
      },
      after: { [`connection:${slot.id}`]: connection.id },
    });
    return {
      id: row.id,
      pausedReason,
      connections: await connectionViews(ctx, row.id, declared, bindings),
    };
  },
});

export const automationUnbindConnection = defineOperation({
  name: "automation.unbindConnection",
  description:
    "Withdraw the consent that lets an automation use a connection (revoke one binding). The " +
    "automation waits for connections until someone binds another, and the admins are told. " +
    "The person who bound it, the connection's owner or an admin. People only.",
  input: z.object({ id: automationIdSchema, slot: slotSchema }),
  output: bindingOutput,
  permission: "records:write",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const { row, spec } = await loadAutomationRow(ctx, input.id);
    const before = await loadBindings(ctx.db, [row.id]);
    const live = before.find((b) => b.slot === input.slot && b.revokedAt === null);
    if (!live) throw new NotFoundError("binding", `${input.id}:${input.slot}`);
    const connection = await ctx.db
      .selectFrom("core_integration_connection")
      .select(["owner_user_id", "title"])
      .where("id", "=", live.connectionId)
      .executeTakeFirst();
    const admin = roleHasPermission(ctx.user.role, "integrations:manage");
    if (live.boundBy !== ctx.user.id && connection?.owner_user_id !== ctx.user.id && !admin) {
      throw new ForbiddenError(
        "Only the person who bound it, the connection's owner or an admin can revoke it",
      );
    }
    const reason = `${ctx.user.name} revoked ${connection?.title ?? "the connection"}`;
    ctx.write(
      ctx.db
        .updateTable("core_automation_binding")
        .set({ revoked_at: ctx.now, revoked_by: ctx.user.id, revoke_reason: reason })
        .where("automation_id", "=", row.id)
        .where("slot", "=", input.slot)
        .where("revoked_at", "is", null),
      ctx.db
        .updateTable("core_automations")
        .set({ paused_reason: WAITING_FOR_CONNECTIONS, paused_at: ctx.now, updated_at: ctx.now })
        .where("id", "=", row.id)
        .where("paused_reason", "is", null),
    );
    const plan = await notifyStatements(
      ctx.db,
      {
        to: [{ role: "admin" }],
        type: "automation.paused",
        title: `“${row.label}” is waiting for a connection`,
        body: `${reason}. Bind another connection on the automation page.`,
        link: { kind: "automation", automationId: row.id },
        dedupeKey: `unbound:${row.id}:${input.slot}:${ctx.now}`,
        source: { actor: "human", userId: ctx.user.id, automationId: row.id },
      },
      ctx.now,
    );
    ctx.write(...plan.statements);
    ctx.recordChange({
      object: "automation",
      id: row.id,
      action: "update",
      before: { [`connection:${input.slot}`]: live.connectionId },
      after: { [`connection:${input.slot}`]: null },
    });
    const bindings = before.map((b) =>
      b.slot === input.slot && b.revokedAt === null
        ? { ...b, revokedAt: ctx.now, revokedBy: ctx.user.id, revokeReason: reason }
        : b,
    );
    return {
      id: row.id,
      pausedReason: row.paused_reason ?? WAITING_FOR_CONNECTIONS,
      connections: await connectionViews(ctx, row.id, declaredConnections(spec), bindings),
    };
  },
});

const deactivateOutput = z.object({
  id: z.string(),
  deactivatedAt: z.string().nullable(),
  /** Automations paused because they used one of the person's connections. */
  pausedAutomations: z.array(z.string()),
});

export const userDeactivate = defineOperation({
  name: "user.deactivate",
  description:
    "Deactivate a person who left: they can no longer sign in or act, and every automation " +
    "bound to one of their connections is paused (its binding revoked) with a notice to the " +
    "admins. Admins only; people only. You cannot deactivate yourself or the last admin.",
  input: z.object({ id: z.string().min(1).max(64).describe("User id (usr_…)") }),
  output: deactivateOutput,
  permission: "users:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const user = await ctx.db
      .selectFrom("core_user")
      .select(["id", "name", "role", "kind", "deactivated_at"])
      .where("id", "=", input.id)
      .executeTakeFirst();
    if (user?.kind !== "human") throw new NotFoundError("user", input.id);
    if (user.id === ctx.user.id) throw new ConflictError("You cannot deactivate yourself");
    if (user.deactivated_at) {
      return { id: user.id, deactivatedAt: user.deactivated_at, pausedAutomations: [] };
    }
    if (user.role === "admin") {
      const other = await ctx.db
        .selectFrom("core_user")
        .select("id")
        .where("role", "=", "admin")
        .where("id", "<>", user.id)
        .where("deactivated_at", "is", null)
        .executeTakeFirst();
      if (!other) throw new ConflictError("The last admin cannot be deactivated");
    }
    ctx.write(
      ctx.db
        .updateTable("core_user")
        .set({ deactivated_at: ctx.now, updated_at: ctx.now })
        .where("id", "=", user.id),
      // Their sessions end now.
      ctx.db.deleteFrom("core_session").where("user_id", "=", user.id),
    );
    const plan = await revokeBindingsPlan(
      ctx.db,
      { ownerUserId: user.id },
      { reason: `${user.name} was deactivated`, by: ctx.user.id, now: ctx.now },
    );
    ctx.write(...plan.statements);
    ctx.recordChange({
      object: "user",
      id: user.id,
      action: "update",
      before: { deactivatedAt: null },
      after: { deactivatedAt: ctx.now },
    });
    return { id: user.id, deactivatedAt: ctx.now, pausedAutomations: plan.automationIds };
  },
});

export const userReactivate = defineOperation({
  name: "user.reactivate",
  description:
    "Let a deactivated person sign in again. Bindings revoked when they were deactivated stay " +
    "revoked: automations need their connections bound again. Admins only; people only.",
  input: z.object({ id: z.string().min(1).max(64) }),
  output: deactivateOutput,
  permission: "users:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const user = await ctx.db
      .selectFrom("core_user")
      .select(["id", "deactivated_at"])
      .where("id", "=", input.id)
      .executeTakeFirst();
    if (!user) throw new NotFoundError("user", input.id);
    if (user.deactivated_at) {
      ctx.write(
        ctx.db
          .updateTable("core_user")
          .set({ deactivated_at: null, updated_at: ctx.now })
          .where("id", "=", user.id),
      );
      ctx.recordChange({
        object: "user",
        id: user.id,
        action: "update",
        before: { deactivatedAt: user.deactivated_at },
        after: { deactivatedAt: null },
      });
    }
    return { id: user.id, deactivatedAt: null, pausedAutomations: [] };
  },
});

/** Pause reasons the UI explains with a "bind a connection" action. */
export function waitsForConnections(pausedReason: string | null): boolean {
  return (
    pausedReason === WAITING_FOR_CONNECTIONS ||
    (pausedReason?.startsWith(CONNECTION_REVOKED_PREFIX) ?? false)
  );
}

/** Used by automation.enable: refuses while a declared connection is unbound. */
export async function assertConnectionsBound(
  ctx: Pick<HandlerContext, "db">,
  automationId: string,
  spec: Parameters<typeof unboundSlots>[0],
): Promise<void> {
  if (!declaredConnections(spec).length) return;
  const missing = unboundSlots(spec, await loadBindings(ctx.db, [automationId]));
  if (missing.length) {
    throw new ConflictError(
      `Bind ${missing.map((m) => `“${m.id}”`).join(", ")} before enabling ${automationId}`,
      { slots: missing.map((m) => m.id) },
    );
  }
}

export const automationBindingOperations = [
  automationBindConnection,
  automationUnbindConnection,
  userDeactivate,
  userReactivate,
] as const;
