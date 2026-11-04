// approval.* and changeset.* operations (ADR 0022): reading the approval queue, approving and
// rejecting pending actions (people only), and grouping an MCP session's work into titled change
// sets. Applying re-runs each action through the pipeline as its original actor.
import type { CoreDatabase, PendingActionStatus } from "@crm/db";
import type { Kysely } from "kysely";
import { z } from "zod";
import { ApprovalStateError, objectOfId } from "../approvals/queue.ts";
import { approvalDecidedMessages, emitEvents, eventOriginOf } from "../automations/events.ts";
import type { ApprovalDecidedMessage, EventSink } from "../automations/types.ts";
import {
  ForbiddenError,
  NotFoundError,
  OperationError,
  toOperationError,
  ValidationError,
} from "../errors.ts";
import { isProvisionalId, newId, replaceIds } from "../ids.ts";
import { type OutboundInput, outboundAppliedAudit } from "../integrations/outbound.ts";
import type { IntegrationRuntime } from "../integrations/runtime.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import {
  type ActingUser,
  type Actor,
  type Origin,
  ROLES,
  type Role,
  roleHasPermission,
} from "../principals.ts";
import { jsonList } from "../records/common.ts";

// --- Schemas -----------------------------------------------------------------------------------

const changeSetId = z.string().startsWith("chs_").max(64).describe("Change set id (chs_…)");
const actionId = z.string().startsWith("pac_").max(64).describe("Pending action id (pac_…)");

export const PENDING_ACTION_STATUSES = [
  "pending",
  "applied",
  "failed",
  "skipped",
  "rejected",
  "expired",
] as const;

const previewSchema = z.object({
  object: z.string(),
  id: z.string(),
  action: z.string(),
  diff: z.record(z.string(), z.object({ before: z.unknown(), after: z.unknown() })),
});

export const pendingActionSchema = z.object({
  id: z.string(),
  changeSetId: z.string(),
  operation: z.string(),
  risk: z.string(),
  reason: z.string(),
  actor: z.string(),
  userId: z.string(),
  origin: z.record(z.string(), z.unknown()),
  input: z.unknown(),
  status: z.enum(PENDING_ACTION_STATUSES),
  statusReason: z.string().nullable(),
  error: z.unknown().nullable(),
  /** The diff a reviewer approves: one entry per touched record, ids provisional for creates. */
  preview: z.array(previewSchema),
  /** What the session sees until it is decided. */
  simulatedOutput: z.unknown().nullable(),
  provisionalIds: z.array(z.string()),
  /** Provisional id → real id, once applied. */
  bindings: z.record(z.string(), z.string()).nullable(),
  dependsOn: z.array(z.string()),
  createdAt: z.string(),
  expiresAt: z.string(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
  requestAuditId: z.string().nullable(),
  appliedAuditId: z.string().nullable(),
  /**
   * Set when what was stored was capped at queue time (ADR 0090): preview entries and simulated
   * records left out. Long before/after values in the preview read
   * `{ "$truncated": true, head, length, hash }`.
   */
  truncated: z
    .object({
      previewOmitted: z.number(),
      recordsOmitted: z.number(),
      outputOmitted: z.boolean(),
    })
    .nullable(),
  /**
   * Set 30 days after the decision (or expiry): input, preview and simulated records were
   * dropped, and `summary` says what they held (records touched, by action; input size).
   */
  compactedAt: z.string().nullable(),
  summary: z.record(z.string(), z.unknown()).nullable(),
  /**
   * For risk `outbound` (ADR 0051): the gatekeeper action this item mirrors and the
   * gatekeeper's own description of it (title, Markdown description, literal fields), which is
   * what a reviewer approves. Approval calls the gatekeeper's applyAction, in order per facet.
   */
  outbound: z
    .object({
      vendor: z.string(),
      connectionId: z.string(),
      connectionTitle: z.string(),
      facetKey: z.string(),
      resourceTitle: z.string(),
      action: z.number(),
      title: z.string(),
      description: z.string(),
      fields: z.array(
        z.object({ label: z.string(), value: z.string(), syntax: z.string().optional() }),
      ),
      actionKind: z.object({ tag: z.string(), label: z.string() }).nullable(),
      autoApprovable: z.boolean(),
      implementsRevert: z.boolean(),
    })
    .nullable(),
});
export type PendingActionView = z.infer<typeof pendingActionSchema>;

const countsSchema = z.object({
  pending: z.number(),
  applied: z.number(),
  failed: z.number(),
  skipped: z.number(),
  rejected: z.number(),
  expired: z.number(),
  total: z.number(),
});

export const changeSetSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  sessionId: z.string().nullable(),
  clientId: z.string().nullable(),
  clientName: z.string().nullable(),
  userId: z.string(),
  userName: z.string().nullable(),
  actor: z.string(),
  explicit: z.boolean(),
  /** open: still collecting actions. committed: closed by the agent. closed: a person decided. */
  state: z.enum(["open", "committed", "closed"]),
  /** awaiting_review while any action is pending; else done. */
  status: z.enum(["awaiting_review", "done", "empty"]),
  counts: countsSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  committedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  /** When the earliest still-pending action expires. */
  expiresAt: z.string().nullable(),
});
export type ChangeSetView = z.infer<typeof changeSetSchema>;

const changeSetDetailSchema = changeSetSchema.extend({ actions: z.array(pendingActionSchema) });

// --- Reading -----------------------------------------------------------------------------------

type PendingRow = Awaited<ReturnType<typeof pendingRows>>[number];

function pendingRows(db: Kysely<CoreDatabase>) {
  return db.selectFrom("core_pending_action").selectAll().orderBy("id").execute();
}

function parse<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** Pending past its expiry reads as expired, before the sweep marks it. */
export function effectiveStatus(
  row: { status: PendingActionStatus; expires_at: string },
  now: string,
): PendingActionStatus {
  return row.status === "pending" && row.expires_at <= now ? "expired" : row.status;
}

function toActionView(row: PendingRow, now: string): PendingActionView {
  const simulated = parse<{ output?: unknown; truncated?: PendingActionView["truncated"] }>(
    row.simulated,
    {},
  );
  const status = effectiveStatus(row, now);
  return {
    id: row.id,
    changeSetId: row.change_set_id,
    operation: row.operation,
    risk: row.risk,
    reason: row.reason,
    actor: row.actor,
    userId: row.user_id,
    origin: parse(row.origin, {}),
    input: parse(row.input, {}),
    status,
    statusReason:
      status === "expired" && row.status === "pending"
        ? "Not approved before it expired"
        : row.status_reason,
    error: parse(row.error, null),
    preview: parse(row.preview, []),
    simulatedOutput: simulated.output ?? null,
    provisionalIds: parse<{ id: string }[]>(row.provisional, []).map((p) => p.id),
    bindings: parse(row.bindings, null),
    dependsOn: parse(row.depends_on, []),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    requestAuditId: row.request_audit_id,
    appliedAuditId: row.applied_audit_id,
    truncated: simulated.truncated ?? null,
    compactedAt: row.compacted_at,
    summary: parse(row.summary, null),
    outbound: row.connection_id !== null ? outboundView(row) : null,
  };
}

function outboundView(row: PendingRow): PendingActionView["outbound"] {
  const input = parse<Partial<OutboundInput>>(row.input, {});
  return {
    vendor: input.vendor ?? "",
    connectionId: row.connection_id ?? "",
    connectionTitle: input.connectionTitle ?? "",
    facetKey: row.facet_key ?? "",
    resourceTitle: input.resourceTitle ?? "",
    action: row.gk_action ?? 0,
    title: input.title ?? row.operation,
    description: input.description ?? "",
    fields: Array.isArray(input.fields) ? input.fields : [],
    actionKind: input.actionKind ?? null,
    autoApprovable: input.autoApprovable === true,
    implementsRevert: input.implementsRevert === true,
  };
}

async function loadActions(
  db: Kysely<CoreDatabase>,
  where: { changeSetIds?: string[]; ids?: string[] },
): Promise<PendingRow[]> {
  let q = db.selectFrom("core_pending_action").selectAll();
  if (where.changeSetIds) {
    if (!where.changeSetIds.length) return [];
    q = q.where("change_set_id", "in", jsonList(where.changeSetIds));
  }
  if (where.ids) {
    if (!where.ids.length) return [];
    q = q.where("id", "in", jsonList(where.ids));
  }
  return q.orderBy("id").execute();
}

function summarise(
  set: {
    id: string;
    title: string | null;
    session_id: string | null;
    client_id: string | null;
    client_name: string | null;
    user_id: string;
    user_name?: string | null;
    actor: string;
    explicit: number;
    state: "open" | "committed" | "closed";
    created_at: string;
    updated_at: string;
    committed_at: string | null;
    closed_at: string | null;
  },
  actions: PendingActionView[],
): ChangeSetView {
  const counts = {
    pending: 0,
    applied: 0,
    failed: 0,
    skipped: 0,
    rejected: 0,
    expired: 0,
    total: 0,
  };
  let expiresAt: string | null = null;
  for (const a of actions) {
    counts[a.status] += 1;
    counts.total += 1;
    if (a.status === "pending" && (!expiresAt || a.expiresAt < expiresAt)) expiresAt = a.expiresAt;
  }
  return {
    id: set.id,
    title: set.title,
    sessionId: set.session_id,
    clientId: set.client_id,
    clientName: set.client_name,
    userId: set.user_id,
    userName: set.user_name ?? null,
    actor: set.actor,
    explicit: set.explicit === 1,
    state: set.state,
    status: counts.total === 0 ? "empty" : counts.pending ? "awaiting_review" : "done",
    counts,
    createdAt: set.created_at,
    updatedAt: set.updated_at,
    committedAt: set.committed_at,
    closedAt: set.closed_at,
    expiresAt,
  };
}

function changeSetQuery(db: Kysely<CoreDatabase>) {
  return db
    .selectFrom("core_change_set as c")
    .leftJoin("core_user as u", "u.id", "c.user_id")
    .select([
      "c.id",
      "c.title",
      "c.session_id",
      "c.client_id",
      "c.client_name",
      "c.user_id",
      "u.name as user_name",
      "c.actor",
      "c.explicit",
      "c.state",
      "c.created_at",
      "c.updated_at",
      "c.committed_at",
      "c.closed_at",
    ]);
}

async function loadChangeSetDetail(ctx: HandlerContext, id: string) {
  const set = await changeSetQuery(ctx.db).where("c.id", "=", id).executeTakeFirst();
  if (!set) throw new NotFoundError("change set", id);
  assertCanSee(ctx, set.user_id);
  const actions = (await loadActions(ctx.db, { changeSetIds: [id] })).map((r) =>
    toActionView(r, ctx.now),
  );
  return { ...summarise(set, actions), actions };
}

/** People see every change set (they review them); MCP and other actors see only their own. */
function assertCanSee(ctx: HandlerContext, ownerId: string): void {
  if (ctx.actor !== "human" && ownerId !== ctx.user.id) {
    throw new ForbiddenError("That change set belongs to another user");
  }
}

// --- Operations: reading ------------------------------------------------------------------------

export const approvalStatus = defineOperation({
  name: "approval.status",
  description:
    "Check what happened to changes queued for approval. Pass actionId for one pending action, " +
    "changeSetId for a change set, or nothing for this session's change sets. Each action is " +
    "pending (waiting for a person), applied (bindings map provisional ids such as " +
    "per_pending_… to real ids), rejected, failed (error says why, e.g. the record changed or " +
    "was deleted), skipped (something it depended on failed or was rejected) or expired. " +
    "Read-only.",
  input: z.object({
    actionId: actionId.optional(),
    changeSetId: changeSetId.optional(),
  }),
  output: z.object({
    changeSets: z.array(changeSetDetailSchema),
  }),
  permission: "records:read",
  risk: "read",
  mcp: { curated: true, idempotent: true, title: "Approval status" },
  async handler(input, ctx) {
    if (input.actionId) {
      const [row] = await loadActions(ctx.db, { ids: [input.actionId] });
      if (!row) throw new NotFoundError("pending action", input.actionId);
      const detail = await loadChangeSetDetail(ctx, row.change_set_id);
      return {
        changeSets: [{ ...detail, actions: detail.actions.filter((a) => a.id === input.actionId) }],
      };
    }
    if (input.changeSetId) {
      return { changeSets: [await loadChangeSetDetail(ctx, input.changeSetId)] };
    }
    let query = changeSetQuery(ctx.db).where("c.user_id", "=", ctx.user.id);
    query = ctx.origin.sessionId
      ? query.where("c.session_id", "=", ctx.origin.sessionId)
      : query.where("c.session_id", "is", null);
    const sets = await query.orderBy("c.id", "desc").limit(10).execute();
    const actions = await loadActions(ctx.db, { changeSetIds: sets.map((s) => s.id) });
    return {
      changeSets: sets.map((set) => {
        const mine = actions
          .filter((a) => a.change_set_id === set.id)
          .map((a) => toActionView(a, ctx.now));
        return { ...summarise(set, mine), actions: mine };
      }),
    };
  },
});

export const approvalList = defineOperation({
  name: "approval.list",
  description:
    "List change sets in the approval queue, newest first: who queued them (user, client " +
    "app), title, counts per status and when the earliest pending action expires. status " +
    "'awaiting_review' (default) shows sets with pending actions; 'all' includes decided ones. " +
    "People see every user's sets; MCP clients see only their own user's. Read-only.",
  input: z.object({
    status: z.enum(["awaiting_review", "all"]).default("awaiting_review"),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  output: z.object({ items: z.array(changeSetSchema), pendingCount: z.number() }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    let query = changeSetQuery(ctx.db);
    if (ctx.actor !== "human") query = query.where("c.user_id", "=", ctx.user.id);
    if (input.status === "awaiting_review") {
      query = query.where("c.id", "in", (eb) =>
        eb
          .selectFrom("core_pending_action")
          .select("change_set_id")
          .where("status", "=", "pending")
          .where("expires_at", ">", ctx.now),
      );
    }
    const sets = await query.orderBy("c.id", "desc").limit(input.limit).execute();
    const actions = await loadActions(ctx.db, { changeSetIds: sets.map((s) => s.id) });
    const items = sets.map((set) =>
      summarise(
        set,
        actions.filter((a) => a.change_set_id === set.id).map((a) => toActionView(a, ctx.now)),
      ),
    );
    let pendingQuery = ctx.db
      .selectFrom("core_pending_action")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("status", "=", "pending")
      .where("expires_at", ">", ctx.now);
    if (ctx.actor !== "human") pendingQuery = pendingQuery.where("user_id", "=", ctx.user.id);
    const pending = await pendingQuery.executeTakeFirst();
    return { items, pendingCount: Number(pending?.n ?? 0) };
  },
});

export const approvalGet = defineOperation({
  name: "approval.get",
  description:
    "One change set with every action in it: operation, risk class, the agent's reason, the " +
    "diff preview (before/after per field and record), status, dependencies and, once applied, " +
    "the real ids and audit rows. Read-only.",
  input: z.object({ changeSetId }),
  output: changeSetDetailSchema,
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    return loadChangeSetDetail(ctx, input.changeSetId);
  },
});

export const approvalPendingForRecord = defineOperation({
  name: "approval.pendingForRecord",
  description:
    "Pending (not yet approved) actions that would change a record, for the 'pending changes' " +
    "badge on record pages and list rows. Pass one record, or several ids of one object type " +
    "for a list page. Read-only.",
  input: z.object({
    object: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .max(64),
    ids: z.array(z.string().min(1).max(64)).min(1).max(100),
  }),
  output: z.object({
    items: z.array(
      z.object({
        recordId: z.string(),
        actionId: z.string(),
        changeSetId: z.string(),
        operation: z.string(),
        action: z.string(),
        reason: z.string(),
        clientName: z.string().nullable(),
        createdAt: z.string(),
      }),
    ),
  }),
  permission: "records:read",
  risk: "read",
  mcp: { expose: false },
  async handler(input, ctx) {
    const rows = await ctx.db
      .selectFrom("core_pending_action_records as r")
      .innerJoin("core_pending_action as p", "p.id", "r.action_id")
      .innerJoin("core_change_set as c", "c.id", "p.change_set_id")
      .select([
        "r.record_id",
        "r.action",
        "p.id",
        "p.change_set_id",
        "p.operation",
        "p.reason",
        "p.created_at",
        "c.client_name",
      ])
      .where("r.object_type", "=", input.object)
      .where("r.record_id", "in", jsonList(input.ids))
      .where("p.status", "=", "pending")
      .where("p.expires_at", ">", ctx.now)
      .orderBy("p.id")
      .execute();
    return {
      items: rows.map((r) => ({
        recordId: r.record_id,
        actionId: r.id,
        changeSetId: r.change_set_id,
        operation: r.operation,
        action: r.action,
        reason: r.reason,
        clientName: r.client_name,
        createdAt: r.created_at,
      })),
    };
  },
});

// --- Deciding ----------------------------------------------------------------------------------

const decisionInput = z
  .object({
    changeSetId: changeSetId.optional().describe("Decide every pending action in this set"),
    actionIds: z.array(actionId).min(1).max(100).optional().describe("Or these actions"),
    note: z.string().trim().max(1000).optional().describe("Shown with the decision"),
  })
  .refine((v) => Boolean(v.changeSetId) !== Boolean(v.actionIds), {
    message: "Pass either changeSetId or actionIds",
  });

const decisionResultSchema = z.object({
  results: z.array(
    z.object({
      actionId: z.string(),
      operation: z.string(),
      status: z.enum(PENDING_ACTION_STATUSES),
      statusReason: z.string().nullable(),
      error: z.unknown().nullable(),
      bindings: z.record(z.string(), z.string()).nullable(),
    }),
  ),
  counts: countsSchema,
});

/** The actions a decision targets: pending ones in a set, or the given ids. */
async function decisionTargets(
  ctx: HandlerContext,
  input: { changeSetId?: string | undefined; actionIds?: string[] | undefined },
): Promise<PendingRow[]> {
  if (input.changeSetId) {
    const set = await ctx.db
      .selectFrom("core_change_set")
      .select("id")
      .where("id", "=", input.changeSetId)
      .executeTakeFirst();
    if (!set) throw new NotFoundError("change set", input.changeSetId);
    const rows = await loadActions(ctx.db, { changeSetIds: [input.changeSetId] });
    const pending = rows.filter((r) => effectiveStatus(r, ctx.now) === "pending");
    if (!pending.length) {
      throw new ApprovalStateError("That change set has no pending actions", {
        changeSetId: input.changeSetId,
      });
    }
    return pending;
  }
  const ids = [...new Set(input.actionIds ?? [])];
  const rows = await loadActions(ctx.db, { ids });
  for (const id of ids) {
    const row = rows.find((r) => r.id === id);
    if (!row) throw new NotFoundError("pending action", id);
    const status = effectiveStatus(row, ctx.now);
    if (status !== "pending") {
      throw new ApprovalStateError(`Action ${id} is ${status}, not pending`, { id, status });
    }
  }
  return rows;
}

/** Every pending action that (transitively) depends on one of `roots`. */
async function dependentsOf(
  db: Kysely<CoreDatabase>,
  roots: readonly string[],
  now: string,
): Promise<PendingRow[]> {
  const pending = (
    await db.selectFrom("core_pending_action").selectAll().where("status", "=", "pending").execute()
  ).filter((r) => r.expires_at > now);
  const found = new Set(roots);
  const out: PendingRow[] = [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of pending) {
      if (found.has(row.id)) continue;
      const deps = parse<string[]>(row.depends_on, []);
      if (deps.some((d) => found.has(d))) {
        found.add(row.id);
        out.push(row);
        grew = true;
      }
    }
  }
  return out;
}

type Decision = ApprovalDecidedMessage["decision"];

/** The approval messages for decided actions (ADR 0130): automations and waiting runs. */
function decisionMessages(
  rows: readonly {
    id: string;
    change_set_id: string;
    operation: string;
    origin: string;
    preview: string;
  }[],
  decisionOf: (id: string) => Decision | null,
  by: { actor: Actor; userId: string | null; origin: Origin; operation: string },
  now: string,
  bindings?: ReadonlyMap<string, Record<string, string>>,
): ApprovalDecidedMessage[] {
  const origin = eventOriginOf({
    actor: by.actor,
    userId: by.userId ?? "system",
    origin: by.origin,
    operation: by.operation,
    auditId: newId("audit"),
    bulk: false,
  });
  return approvalDecidedMessages(
    now,
    origin,
    rows.flatMap((row) => {
      const decision = decisionOf(row.id);
      if (!decision) return [];
      // Provisional ids become the real ones an applied action bound; ones never created drop.
      const bound = bindings?.get(row.id) ?? {};
      const records = parse<{ object: string; id: string }[]>(row.preview, [])
        .map((p) => ({ object: p.object, id: bound[p.id] ?? p.id }))
        .filter((r) => !isProvisionalId(r.id));
      return [
        {
          actionId: row.id,
          changeSetId: row.change_set_id,
          operation: row.operation,
          decision,
          decidedBy: by.userId,
          records,
          actionOrigin: parse<Origin>(row.origin, { surface: "system" }),
        },
      ];
    }),
  );
}

async function emitDecisions(
  ctx: HandlerContext,
  rows: readonly PendingRow[],
  decisionOf: (id: string) => Decision | null,
  bindings?: ReadonlyMap<string, Record<string, string>>,
): Promise<void> {
  if (!ctx.events) return;
  await emitEvents(
    ctx.events,
    decisionMessages(
      rows,
      decisionOf,
      { actor: "human", userId: ctx.user.id, origin: ctx.origin, operation: ctx.operation },
      ctx.now,
      bindings,
    ),
  );
}

function closeSets(ctx: HandlerContext, ids: Iterable<string>) {
  const list = [...new Set(ids)];
  if (!list.length) return;
  ctx.write(
    ctx.db
      .updateTable("core_change_set")
      .set({ state: "closed", closed_at: ctx.now, updated_at: ctx.now })
      .where("id", "in", jsonList(list))
      .where("state", "<>", "closed"),
  );
}

async function loadUser(db: Kysely<CoreDatabase>, id: string): Promise<ActingUser | null> {
  const row = await db
    .selectFrom("core_user")
    .select(["id", "email", "name", "role"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) return null;
  const role = (ROLES as readonly string[]).includes(row.role) ? (row.role as Role) : "viewer";
  return { id: row.id, email: row.email, name: row.name, role };
}

function counts(results: { status: PendingActionStatus }[]) {
  const out = { pending: 0, applied: 0, failed: 0, skipped: 0, rejected: 0, expired: 0, total: 0 };
  for (const r of results) {
    out[r.status] += 1;
    out.total += 1;
  }
  return out;
}

export const approvalApprove = defineOperation({
  name: "approval.approve",
  description:
    "Approve pending actions: a whole change set, or chosen actions. Each is applied in queue " +
    "order by re-running it through the pipeline as the agent that asked for it, with " +
    "provisional ids replaced by the real ids of records created earlier. An action whose " +
    "record changed or was deleted meanwhile fails with a reason, and actions depending on it " +
    "are skipped. An action cannot be approved before a pending action it depends on. People " +
    "only.",
  input: decisionInput,
  output: decisionResultSchema,
  permission: "records:write",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  auditSummary: (output) => ({ counts: output.counts }),
  async handler(input, ctx) {
    const targets = await decisionTargets(ctx, input);
    // Installing or upgrading an extension, or changing schema, needs an admin's approval: the
    // approver must hold the permission those operations need (ADR 0041).
    const privileged = targets.find((t) => t.risk === "extension" || t.risk === "schema");
    if (privileged && !roleHasPermission(ctx.user.role, "extensions:manage")) {
      throw new ForbiddenError(
        `Approving ${privileged.operation} needs an admin (extensions:manage)`,
        { actionId: privileged.id, permission: "extensions:manage" },
      );
    }
    const targetIds = new Set(targets.map((t) => t.id));
    // Out-of-order approval is refused: dependencies must be applied or approved together.
    const depIds = [...new Set(targets.flatMap((t) => parse<string[]>(t.depends_on, [])))];
    const deps = await loadActions(ctx.db, { ids: depIds.filter((d) => !targetIds.has(d)) });
    for (const target of targets) {
      for (const dep of parse<string[]>(target.depends_on, [])) {
        if (targetIds.has(dep)) continue;
        const row = deps.find((d) => d.id === dep);
        if (row?.status !== "applied") {
          throw new ApprovalStateError(
            `Action ${target.id} depends on ${dep}, which is ${row ? effectiveStatus(row, ctx.now) : "missing"}. ` +
              "Approve it first, or approve both together.",
            { actionId: target.id, dependsOn: dep },
          );
        }
      }
    }
    // Outbound items apply in action order per facet (the gatekeeper refuses anything else):
    // an earlier action on the same facet must be decided, or approved together with this one.
    const outbound = targets.filter((t) => t.connection_id !== null);
    if (outbound.length && !ctx.integrations) {
      throw new OperationError(
        "config",
        "Outbound actions can only be approved where the integration host is reachable",
      );
    }
    for (const target of outbound) {
      const earlier = await ctx.db
        .selectFrom("core_pending_action")
        .select(["id"])
        .where("connection_id", "=", target.connection_id)
        .where("facet_key", "=", target.facet_key)
        .where("gk_action", "<", target.gk_action)
        .where("status", "=", "pending")
        .where("expires_at", ">", ctx.now)
        .execute();
      const blocking = earlier.find((e) => !targetIds.has(e.id));
      if (blocking) {
        throw new ApprovalStateError(
          `Action ${target.id} comes after ${blocking.id} on the same gatekeeper, which is still ` +
            "pending. Gatekeeper actions apply in order: decide it first, or approve both together.",
          { actionId: target.id, after: blocking.id },
        );
      }
    }
    closeSets(
      ctx,
      targets.map((t) => t.change_set_id),
    );
    const approver = ctx.user.id;
    const integrations = ctx.integrations;
    return ctx.afterCommit(async () => {
      const crm = ctx.pipeline.crm;
      // Real ids for provisional ones, from dependencies applied earlier.
      const bindings = new Map<string, string>();
      for (const dep of deps) {
        for (const [p, r] of Object.entries(parse<Record<string, string>>(dep.bindings, {}))) {
          bindings.set(p, r);
        }
      }
      const failed = new Set<string>();
      const results: z.infer<typeof decisionResultSchema>["results"] = [];
      for (const action of targets) {
        const blockedBy = parse<string[]>(action.depends_on, []).find((d) => failed.has(d));
        if (blockedBy) {
          failed.add(action.id);
          const statusReason = `Skipped: ${blockedBy}, which it depends on, was not applied`;
          await crm.batch([
            ctx.db
              .updateTable("core_pending_action")
              .set({
                status: "skipped",
                status_reason: statusReason,
                decided_by: approver,
                decided_at: ctx.now,
              })
              .where("id", "=", action.id)
              .where("status", "=", "pending"),
          ]);
          results.push({
            actionId: action.id,
            operation: action.operation,
            status: "skipped",
            statusReason,
            error: null,
            bindings: null,
          });
          continue;
        }
        if (action.connection_id !== null && integrations) {
          // ADR 0051: the gatekeeper replays its own journal; nothing re-runs through the pipeline.
          let outcome: { ok: true } | { ok: false; message: string };
          try {
            await integrations.applyOutbound({
              connectionId: action.connection_id,
              facetKey: action.facet_key ?? "",
              action: action.gk_action ?? 0,
            });
            outcome = { ok: true };
          } catch (error) {
            // A gatekeeper error is the provider's reason (not an internal CRM error): keep it.
            const message = error instanceof Error ? error.message : String(error);
            outcome = { ok: false, message: message.slice(0, 1000) };
          }
          const status = outcome.ok ? "applied" : "failed";
          const statusReason = outcome.ok ? null : `Failed: ${outcome.message}`;
          if (!outcome.ok) failed.add(action.id);
          await crm.batch([
            ctx.db
              .updateTable("core_pending_action")
              .set({
                status,
                status_reason: statusReason,
                error: outcome.ok
                  ? null
                  : JSON.stringify({ code: "outbound_failed", message: outcome.message }),
                decided_by: approver,
                decided_at: ctx.now,
              })
              .where("id", "=", action.id)
              .where("status", "=", "pending"),
            outboundAppliedAudit(crm, action, ctx.now, outcome),
          ]);
          results.push({
            actionId: action.id,
            operation: action.operation,
            status,
            statusReason,
            error: outcome.ok ? null : { code: "outbound_failed", message: outcome.message },
            bindings: null,
          });
          continue;
        }
        try {
          const user = await loadUser(ctx.db, action.user_id);
          if (!user) throw new ValidationError(`The user ${action.user_id} no longer exists`);
          const granted = parse<string[] | null>(action.granted_permissions, null);
          await ctx.pipeline.invoke(
            action.operation,
            replaceIds(parse(action.input, {}), bindings),
            {
              actor: action.actor,
              user,
              origin: parse<Origin>(action.origin, { surface: "mcp" }),
              grantedPermissions: granted as never,
              approval: {
                actionId: action.id,
                approvedBy: approver,
                provisional: parse(action.provisional, []),
                preview: replaceIds(parse(action.preview, []), bindings),
              },
            },
          );
          const applied = await ctx.db
            .selectFrom("core_pending_action")
            .select(["bindings", "status"])
            .where("id", "=", action.id)
            .executeTakeFirstOrThrow();
          const own = parse<Record<string, string>>(applied.bindings, {});
          for (const [p, r] of Object.entries(own)) bindings.set(p, r);
          results.push({
            actionId: action.id,
            operation: action.operation,
            status: applied.status,
            statusReason: null,
            error: null,
            bindings: own,
          });
        } catch (error) {
          const typed = toOperationError(error);
          failed.add(action.id);
          const statusReason = `Failed: ${typed.message}`;
          await crm.batch([
            ctx.db
              .updateTable("core_pending_action")
              .set({
                status: "failed",
                status_reason: statusReason,
                error: JSON.stringify(typed.toJSON()),
                decided_by: approver,
                decided_at: ctx.now,
              })
              .where("id", "=", action.id)
              .where("status", "=", "pending"),
          ]);
          results.push({
            actionId: action.id,
            operation: action.operation,
            status: "failed",
            statusReason,
            error: typed.toJSON(),
            bindings: null,
          });
        }
      }
      // Anything else waiting on a failed action can never apply: skip it too.
      const stranded = await dependentsOf(ctx.db, [...failed], ctx.now);
      if (stranded.length) {
        await crm.batch([
          ctx.db
            .updateTable("core_pending_action")
            .set({
              status: "skipped",
              status_reason: "Skipped: an action it depends on failed",
              decided_by: approver,
              decided_at: ctx.now,
            })
            .where("id", "in", jsonList(stranded.map((s) => s.id)))
            .where("status", "=", "pending"),
        ]);
      }
      // Skipped outbound items will never apply: drop them on their facets so later actions on
      // the same gatekeeper are not held behind them.
      const skippedIds = new Set([
        ...results.filter((r) => r.status === "skipped").map((r) => r.actionId),
        ...stranded.map((s) => s.id),
      ]);
      await rejectOnFacets(
        integrations,
        [...targets, ...stranded].filter((r) => skippedIds.has(r.id)),
      );
      const decided = new Map<string, Decision>(
        results.map((r) => [r.actionId, r.status === "applied" ? "approved" : "failed"]),
      );
      for (const s of stranded) decided.set(s.id, "failed");
      const bound = new Map(results.map((r) => [r.actionId, r.bindings ?? {}]));
      await emitDecisions(ctx, [...targets, ...stranded], (id) => decided.get(id) ?? null, bound);
      return { results, counts: counts(results) };
    });
  },
});

/**
 * Tells each outbound item's facet to drop its action (rejected, skipped or expired). Best
 * effort: the CRM's decision is already committed; a facet that cannot be reached keeps the
 * action journalled until its own expiry.
 */
export async function rejectOnFacets(
  integrations: IntegrationRuntime | undefined,
  rows: readonly {
    connection_id: string | null;
    facet_key: string | null;
    gk_action: number | null;
  }[],
): Promise<void> {
  if (!integrations) return;
  for (const row of rows) {
    if (row.connection_id === null) continue;
    try {
      await integrations.rejectOutbound({
        connectionId: row.connection_id,
        facetKey: row.facet_key ?? "",
        action: row.gk_action ?? 0,
      });
    } catch (error) {
      console.error("could not reject an outbound action on its facet", error);
    }
  }
}

export const approvalReject = defineOperation({
  name: "approval.reject",
  description:
    "Reject pending actions: a whole change set, or chosen actions. Nothing is applied. Every " +
    "pending action that depends on a rejected one (e.g. an activity logged on a person whose " +
    "creation is rejected) is rejected with it. People only.",
  input: decisionInput,
  output: decisionResultSchema,
  permission: "records:write",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  auditSummary: (output) => ({ counts: output.counts }),
  async handler(input, ctx) {
    const targets = await decisionTargets(ctx, input);
    const cascaded = (
      await dependentsOf(
        ctx.db,
        targets.map((t) => t.id),
        ctx.now,
      )
    ).filter((d) => !targets.some((t) => t.id === d.id));
    const note = input.note ? `: ${input.note}` : "";
    const results: z.infer<typeof decisionResultSchema>["results"] = [];
    const reject = (row: PendingRow, statusReason: string) => {
      ctx.write(
        ctx.db
          .updateTable("core_pending_action")
          .set({
            status: "rejected",
            status_reason: statusReason,
            decided_by: ctx.user.id,
            decided_at: ctx.now,
          })
          .where("id", "=", row.id)
          .where("status", "=", "pending"),
      );
      results.push({
        actionId: row.id,
        operation: row.operation,
        status: "rejected",
        statusReason,
        error: null,
        bindings: null,
      });
    };
    for (const row of targets) reject(row, `Rejected by ${ctx.user.name}${note}`);
    for (const row of cascaded) {
      reject(row, `Rejected because an action it depends on was rejected${note}`);
    }
    closeSets(
      ctx,
      [...targets, ...cascaded].map((r) => r.change_set_id),
    );
    const outbound = [...targets, ...cascaded].filter((r) => r.connection_id !== null);
    const output = { results, counts: counts(results) };
    if (!outbound.length && !ctx.events) return output;
    const integrations = ctx.integrations;
    return ctx.afterCommit(async () => {
      await rejectOnFacets(integrations, outbound);
      await emitDecisions(ctx, [...targets, ...cascaded], () => "rejected");
      return output;
    });
  },
});

// --- Change sets -------------------------------------------------------------------------------

function sessionFilter(ctx: HandlerContext) {
  return ctx.origin.sessionId ?? null;
}

export const changesetBegin = defineOperation({
  name: "changeset.begin",
  description:
    "Start a titled change set for one task, e.g. 'Import contacts from the Acme offsite'. " +
    "Everything this session queues for approval afterwards goes into it, so a person reviews " +
    "the task as one unit. Call changeset.commit when the task is done. Starting a new one " +
    "commits any change set you had open. Writes that apply immediately are not affected.",
  input: z.object({ title: z.string().trim().min(1).max(200).describe("What the task is") }),
  output: z.object({ changeSetId: z.string(), title: z.string() }),
  permission: "records:write",
  risk: "write",
  bookkeeping: true,
  mcp: { curated: true, title: "Begin change set" },
  async handler(input, ctx) {
    const sessionId = sessionFilter(ctx);
    let open = ctx.db
      .updateTable("core_change_set")
      .set({ state: "committed", committed_at: ctx.now, updated_at: ctx.now })
      .where("user_id", "=", ctx.user.id)
      .where("state", "=", "open");
    open = sessionId
      ? open.where("session_id", "=", sessionId)
      : open.where("session_id", "is", null).where("actor", "=", ctx.actor);
    ctx.write(open);
    const id = newId("changeSet");
    ctx.write(
      ctx.db.insertInto("core_change_set").values({
        id,
        title: input.title,
        session_id: sessionId,
        client_id: ctx.origin.clientId ?? null,
        client_name: ctx.origin.clientName ?? null,
        user_id: ctx.user.id,
        actor: ctx.actor,
        origin: JSON.stringify(ctx.origin),
        explicit: 1,
        state: "open",
        created_at: ctx.now,
        updated_at: ctx.now,
      }),
    );
    return { changeSetId: id, title: input.title };
  },
});

export const changesetCommit = defineOperation({
  name: "changeset.commit",
  description:
    "Finish the change set this session is filling (or the one named) so it is ready for " +
    "review; optionally (re)title it. Later queued actions start a new change set. Nothing is " +
    "applied until a person approves it. Returns the set with its counts.",
  input: z.object({
    changeSetId: changeSetId.optional(),
    title: z.string().trim().min(1).max(200).optional(),
  }),
  output: changeSetSchema,
  permission: "records:write",
  risk: "write",
  bookkeeping: true,
  mcp: { curated: true, title: "Commit change set" },
  async handler(input, ctx) {
    let query = changeSetQuery(ctx.db).where("c.user_id", "=", ctx.user.id);
    if (input.changeSetId) {
      query = query.where("c.id", "=", input.changeSetId);
    } else {
      const sessionId = sessionFilter(ctx);
      query = (
        sessionId
          ? query.where("c.session_id", "=", sessionId)
          : query.where("c.session_id", "is", null).where("c.actor", "=", ctx.actor)
      )
        .where("c.state", "=", "open")
        .orderBy("c.explicit", "desc")
        .orderBy("c.id", "desc");
    }
    const set = await query.executeTakeFirst();
    if (!set) {
      throw input.changeSetId
        ? new NotFoundError("change set", input.changeSetId)
        : new ApprovalStateError("This session has no open change set to commit");
    }
    if (set.state !== "open") {
      throw new ApprovalStateError(`Change set ${set.id} is already ${set.state}`, {
        state: set.state,
      });
    }
    ctx.write(
      ctx.db
        .updateTable("core_change_set")
        .set({
          state: "committed",
          committed_at: ctx.now,
          updated_at: ctx.now,
          ...(input.title ? { title: input.title } : {}),
        })
        .where("id", "=", set.id),
    );
    const actions = (await loadActions(ctx.db, { changeSetIds: [set.id] })).map((r) =>
      toActionView(r, ctx.now),
    );
    return summarise(
      {
        ...set,
        title: input.title ?? set.title,
        state: "committed",
        committed_at: ctx.now,
        updated_at: ctx.now,
      },
      actions,
    );
  },
});

/**
 * Marks pending actions past their expiry as expired. Run by the daily cron (and tests). With
 * `events`, each expiry is sent as an `approval` message (decision `expired`, ADR 0130).
 */
export async function expirePendingActions(
  db: Kysely<CoreDatabase>,
  now: string = new Date().toISOString(),
  integrations?: IntegrationRuntime,
  events?: EventSink,
): Promise<number> {
  // Expired outbound items are dropped on their facets too (see rejectOnFacets).
  const outbound = integrations
    ? await db
        .selectFrom("core_pending_action")
        .select(["connection_id", "facet_key", "gk_action"])
        .where("status", "=", "pending")
        .where("expires_at", "<=", now)
        .where("connection_id", "is not", null)
        .execute()
    : [];
  const rows = await db
    .updateTable("core_pending_action")
    .set({ status: "expired", status_reason: "Not approved before it expired" })
    .where("status", "=", "pending")
    .where("expires_at", "<=", now)
    .returning(["id", "change_set_id", "operation", "origin", "preview"])
    .execute();
  await rejectOnFacets(integrations, outbound);
  if (events && rows.length) {
    await emitEvents(
      events,
      decisionMessages(
        rows,
        () => "expired",
        // The expiry sweep is a system job (an automation in actor terms).
        {
          actor: "automation",
          userId: null,
          origin: { surface: "system", automationId: "approval.expire" },
          operation: "approval.expire",
        },
        now,
      ),
    );
  }
  return rows.length;
}

export { objectOfId };

export const approvalOperations = [
  approvalStatus,
  approvalList,
  approvalGet,
  approvalPendingForRecord,
  approvalApprove,
  approvalReject,
  changesetBegin,
  changesetCommit,
] as const;
