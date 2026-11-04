// The invocation pipeline (ADR 0016, ADR 0011, ADR 0017, ADR 0018, ADR 0022):
//
//   validate input → actor + role (+ token scope) check → gate → handler → timeline → audit
//
// The handler's queued writes, the timeline activities and the audit rows commit together in one
// D1 batch (one transaction). Refusals (role, actor, gate) and failures are audited separately.
// A gate `review` dry-runs the handler and queues a pending action instead (approvals/queue.ts);
// reads by an MCP session see its pending actions applied (approvals/simulation.ts).
import type { AuditChangeAction, CrmDb } from "@crm/db";
import { checkGrant } from "@crm/sdk";
import { type Compilable, type CompiledQuery, sql } from "kysely";
import { type DryRunResult, prepareQueuedAction } from "./approvals/queue.ts";
import { isSimulatedRead, loadSessionOverlay, overlayRead } from "./approvals/simulation.ts";
import type { WidgetCache } from "./dashboards/cache.ts";
import { diffRecords, type FieldDiff } from "./diff.ts";
import {
  ConflictError,
  ForbiddenError,
  GateDeniedError,
  OperationError,
  PendingApprovalError,
  toOperationError,
  UnknownOperationError,
  ValidationError,
} from "./errors.ts";
import type { ExtensionHost } from "./extensions/host.ts";
import { refreshSchemaRegistry } from "./extensions/schema.ts";
import { getObject, isCoreObject } from "./fields/index.ts";
import { evaluateGate, type GateDecision, type GateFloor, type GateResult } from "./gate.ts";
import { findProvisionalIds, newId } from "./ids.ts";
import type { ModelRunner } from "./models.ts";
import {
  type AnyOperation,
  type ApplyingApproval,
  afterCommit,
  type ExtensionCaller,
  type HandlerContext,
  isAfterCommit,
  type OperationOutput,
  type RecordChange,
  runAfterCommit,
  type SystemActivityInput,
} from "./operation.ts";
import {
  type ActingUser,
  type Actor,
  type Origin,
  originSchema,
  type Permission,
  roleHasPermission,
} from "./principals.ts";
import { loadApprovalPolicy } from "./settings.ts";

/** Everything an adapter supplies for one call. */
export interface InvocationContext {
  actor: Actor;
  /** The CRM user the call acts for (see resolveActingUser). */
  user: ActingUser;
  origin: Origin;
  db: CrmDb;
  /** The deploy-time floor, parsed from env APPROVAL_FLOOR by the adapter (parseFloor). */
  floor?: GateFloor;
  /** Clock override for tests. */
  clock?: () => Date;
  /**
   * What the caller's credential allows (an MCP token's scopes, ADR 0021). The call needs its
   * permission in both the user's role and this list. Omitted means the role alone decides.
   */
  grantedPermissions?: readonly Permission[] | undefined;
  /** Why the caller wants this change. Stored on the pending action when it is queued. */
  reason?: string | undefined;
  /** Days before a pending action expires (env APPROVAL_EXPIRY_DAYS). Default 7. */
  approvalExpiryDays?: number | undefined;
  /** Set when this call applies an approved pending action. */
  approval?: ApplyingApproval | undefined;
  /** Looks up other operations by name, for approvals that re-run queued actions. */
  resolveOperation?: ((name: string) => AnyOperation | undefined) | undefined;
  /** The extension runtime (extension.* and x.* operations need it). */
  extensionHost?: ExtensionHost;
  /** Actor `extension` only: the calling extension and its declared permissions (ADR 0025). */
  extension?: ExtensionCaller;
  /** Model roles (ADR 0009); absent when the deployment has no AI binding. */
  models?: ModelRunner;
  /** Widget result cache (ADR 0057); absent means the Workers Cache API. */
  widgetCache?: WidgetCache;
}

/** The installed extension whose principal is `userId`, with its declared permissions. */
async function loadExtensionCaller(db: CrmDb, userId: string): Promise<ExtensionCaller | null> {
  const row = await db.query
    .selectFrom("core_extensions")
    .select(["id", "manifest", "status"])
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (!row || row.status !== "active") return null;
  const manifest = JSON.parse(row.manifest) as { permissions: ExtensionCaller["permissions"] };
  return { id: row.id, permissions: manifest.permissions };
}

/** The object an operation reads or writes, for extension permission checks. */
export function operationObject(op: AnyOperation, input: unknown): string | null {
  if (op.name.startsWith("record.")) {
    const object = (input as { object?: unknown } | null)?.object;
    return typeof object === "string" ? object : null;
  }
  const prefix = op.name.split(".")[0] ?? "";
  return isCoreObject(prefix) ? prefix : null;
}

type AuditOutcome = "ok" | "forbidden" | "denied" | "review" | "error";

const SECRET_KEY = /pass(word)?|secret|token|api[-_]?key|authori[sz]ation|cookie/i;
const REDACTED = "[redacted]";

/** Deep-copies `value` with secret-looking keys (and `extra` keys) replaced by "[redacted]". */
export function redactInput(value: unknown, extra: readonly string[] = []): unknown {
  if (Array.isArray(value)) return value.map((item) => redactInput(item, extra));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, v]) => [
        key,
        SECRET_KEY.test(key) || extra.includes(key) ? REDACTED : redactInput(v, extra),
      ]),
    );
  }
  return value;
}

/** Reads by humans are not audited; every write, refusal and non-human call is. */
function isAudited(op: AnyOperation, actor: Actor): boolean {
  return op.risk !== "read" || actor !== "human";
}

function defaultSummary(output: unknown, changes: RecordChange[]): unknown {
  if (changes.length) {
    return {
      count: changes.length,
      records: changes.slice(0, 50).map(({ object, id, action }) => ({ object, id, action })),
    };
  }
  if (output && typeof output === "object") {
    const o = output as Record<string, unknown>;
    if (typeof o.id === "string") return { id: o.id };
    if (Array.isArray(o.items)) return { count: o.items.length };
  }
  return null;
}

interface AuditRow {
  id: string;
  op: AnyOperation;
  ctx: InvocationContext;
  input: unknown;
  at: string;
  gate: GateDecision;
  outcome: AuditOutcome;
  result?: unknown;
  error?: OperationError;
  pendingActionId?: string | null;
}

function auditInsert(db: CrmDb, row: AuditRow): Compilable {
  return db.query.insertInto("core_audit").values({
    id: row.id,
    at: row.at,
    operation: row.op.name,
    risk: row.op.risk,
    actor: row.ctx.actor,
    user_id: row.ctx.user.id,
    origin: JSON.stringify(originSchema.parse(row.ctx.origin)),
    input: JSON.stringify(redactInput(row.input, row.op.redact) ?? null),
    result: row.result === undefined ? null : JSON.stringify(row.result),
    gate_decision: row.gate,
    outcome: row.outcome,
    error: row.error ? JSON.stringify(row.error.toJSON()) : null,
    pending_action_id: row.pendingActionId ?? null,
  });
}

/** Bytes of JSON per audit-changes statement; D1 caps one bound value at 2 MB. */
const CHANGES_CHUNK_BYTES = 500_000;

/**
 * core_audit_changes rows as few statements as possible: each inserts a chunk from one JSON
 * parameter via json_each, so bulk operations touching thousands of records stay within D1's
 * statements-per-invocation and bound-parameter limits. Rows keep their order.
 */
function auditChangeInserts(
  db: CrmDb,
  auditId: string,
  at: string,
  rows: { o: string; r: string; a: string; d: string }[],
): Compilable[] {
  const statements: Compilable[] = [];
  let chunk: typeof rows = [];
  let bytes = 0;
  const flush = () => {
    if (!chunk.length) return;
    const json = JSON.stringify(chunk);
    statements.push(
      db.query
        .insertInto("core_audit_changes")
        .columns(["audit_id", "object_type", "record_id", "action", "diff", "at"])
        .expression(
          db.query
            .selectFrom(sql<{ value: string }>`json_each(${json})`.as("j"))
            .select([
              sql<string>`${auditId}`.as("audit_id"),
              sql<string>`json_extract(j.value, '$.o')`.as("object_type"),
              sql<string>`json_extract(j.value, '$.r')`.as("record_id"),
              sql<AuditChangeAction>`json_extract(j.value, '$.a')`.as("action"),
              sql<string>`json_extract(j.value, '$.d')`.as("diff"),
              sql<string>`${at}`.as("at"),
            ])
            .orderBy(sql`j.key`),
        ),
    );
    chunk = [];
    bytes = 0;
  };
  for (const row of rows) {
    const size = row.d.length + row.r.length + 64;
    if (bytes + size > CHANGES_CHUNK_BYTES) flush();
    chunk.push(row);
    bytes += size;
  }
  flush();
  return statements;
}

/** Writes a standalone audit row (refusals and failures). Never throws. */
async function auditAlone(row: AuditRow): Promise<void> {
  try {
    await row.ctx.db.batch([auditInsert(row.ctx.db, row)]);
  } catch (error) {
    console.error("failed to write audit row", row.op.name, error);
  }
}

function activityStatements(
  db: CrmDb,
  ctx: InvocationContext,
  now: string,
  id: string,
  activity: SystemActivityInput,
): Compilable[] {
  const statements: Compilable[] = [
    db.query.insertInto("core_activity").values({
      id,
      type: "system",
      subject: activity.subject,
      body: activity.body ?? null,
      payload: JSON.stringify(activity.payload),
      occurred_at: activity.occurredAt ?? now,
      author_user_id: ctx.user.id,
      // core_activity.author_actor predates the extension actor; extension posts are `system`.
      author_actor: ctx.actor === "extension" ? "system" : ctx.actor,
      created_at: now,
      updated_at: now,
    }),
  ];
  const links = [
    ...new Map(activity.links.map((l) => [`${l.object}:${l.id}`, l] as const)).values(),
  ];
  if (links.length) {
    statements.push(
      db.query
        .insertInto("core_activity_links")
        .values(links.map((l) => ({ activity_id: id, object_type: l.object, record_id: l.id }))),
    );
  }
  return statements;
}

/** Field changes flagged `track: "timeline"` become a system activity on the record. */
function timelineActivity(
  operation: string,
  change: RecordChange,
  diff: FieldDiff,
): SystemActivityInput | null {
  if (change.action !== "update") return null;
  const object = getObject(change.object);
  if (!object) return null;
  const tracked = object.fields.filter((f) => f.track === "timeline" && f.name in diff);
  if (!tracked.length) return null;
  const labels = tracked.map((f) => f.label);
  return {
    subject: `${labels.join(", ")} changed`,
    payload: {
      kind: "field_change",
      operation,
      object: change.object,
      recordId: change.id,
      changes: tracked.map((f) => ({
        field: f.name,
        label: f.label,
        before: diff[f.name]?.before ?? null,
        after: diff[f.name]?.after ?? null,
      })),
    },
    links: [{ object: change.object, id: change.id }],
  };
}

const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * When applying an approved action: fails with ConflictError if a record the human approved a
 * change to has changed meanwhile (a previewed field's current value is not its preview `before`).
 */
function assertUnchangedSincePreview(approval: ApplyingApproval, changes: RecordChange[]): void {
  for (const change of changes) {
    if (change.action === "create" || !change.before) continue;
    const previewed = approval.preview.find(
      (p) => p.object === change.object && p.id === change.id,
    );
    if (!previewed) continue;
    for (const [field, values] of Object.entries(previewed.diff)) {
      if (!(field in change.before)) continue;
      if (!sameJson(change.before[field], values.before)) {
        throw new ConflictError(
          `The ${change.object} ${change.id} changed after this was queued (${field}), so the ` +
            "approved change no longer matches what was reviewed",
          { object: change.object, id: change.id, field },
        );
      }
    }
  }
}

/** Provisional id → real id, matching the action's creates in order. */
function bindProvisional(
  approval: ApplyingApproval,
  changes: RecordChange[],
): Record<string, string> {
  const creates = changes.filter((c) => c.action === "create");
  const used = new Set<RecordChange>();
  const bindings: Record<string, string> = {};
  for (const p of approval.provisional) {
    const match = creates.find((c) => c.object === p.object && !used.has(c));
    if (!match) continue;
    used.add(match);
    bindings[p.id] = match.id;
  }
  return bindings;
}

/**
 * Runs one operation for one caller. Throws typed OperationErrors: ValidationError,
 * ForbiddenError, GateDeniedError, PendingApprovalError (queued for review), NotFoundError,
 * ConflictError.
 */
export async function invokeOperation<O extends AnyOperation>(
  op: O,
  rawInput: unknown,
  ctx: InvocationContext,
): Promise<OperationOutput<O>> {
  const now = (ctx.clock?.() ?? new Date()).toISOString();
  const parsed = op.input.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(`Invalid input for ${op.name}`, { issues: parsed.error.issues });
  }
  const input: unknown = parsed.data;
  // Extension objects and fields join the field registry (ADR 0023); cheap when unchanged.
  await refreshSchemaRegistry(ctx.db.query);
  const audited = isAudited(op, ctx.actor);
  const auditId = newId("audit");
  const pendingActionId = ctx.approval?.actionId ?? null;
  const base = { id: auditId, op, ctx, input, at: now, pendingActionId } as const;

  // Gate first (pure, after one settings read) so refusals record what it would have decided.
  const policy = await loadApprovalPolicy(ctx.db.query);
  const bulkSize = op.bulkSize ? op.bulkSize(input) : 1;
  const gate: GateResult = evaluateGate(
    { actor: ctx.actor, risk: op.risk, bulkSize },
    policy,
    ctx.floor,
  );
  let decision: GateDecision = gate.decision;
  // Bookkeeping (opening a change set, revoking a token) is never queued; deny still applies.
  if (op.bookkeeping && decision === "review") decision = "auto";
  // Some changes always wait for a person (extension installs and upgrades, ADR 0041).
  const forced =
    op.alwaysReview === true ||
    (Array.isArray(op.alwaysReview) && op.alwaysReview.includes(ctx.actor));
  if (forced && decision === "auto" && !ctx.approval) decision = "review";
  // A write that refers to a record still pending creation can only be queued after it.
  const provisionalRefs = op.risk === "read" ? [] : findProvisionalIds(rawInput);
  if (decision === "auto" && provisionalRefs.length && !ctx.approval) decision = "review";

  if (op.actors && !op.actors.includes(ctx.actor)) {
    const error = new ForbiddenError(`${op.name} cannot be called by ${ctx.actor} actors`, {
      actor: ctx.actor,
      allowed: op.actors,
    });
    await auditAlone({ ...base, gate: decision, outcome: "forbidden", error });
    throw error;
  }
  if (ctx.actor === "extension") {
    // The runtime passes the caller; an approved pending action re-run by an admin does not, so
    // it is loaded from the extension principal's installed manifest.
    const caller = ctx.extension ?? (await loadExtensionCaller(ctx.db, ctx.user.id));
    const grant = caller
      ? checkGrant(caller.id, caller.permissions, {
          operation: op.name,
          risk: op.risk,
          object: operationObject(op, input),
        })
      : { ok: false as const, reason: "Extension calls need the calling extension" };
    if (!grant.ok) {
      const error = new ForbiddenError(grant.reason, {
        extension: caller?.id ?? null,
        operation: op.name,
      });
      await auditAlone({ ...base, gate: decision, outcome: "forbidden", error });
      throw error;
    }
  }
  if (!roleHasPermission(ctx.user.role, op.permission)) {
    const error = new ForbiddenError(`Your role (${ctx.user.role}) cannot ${op.name}`, {
      role: ctx.user.role,
      permission: op.permission,
    });
    await auditAlone({ ...base, gate: decision, outcome: "forbidden", error });
    throw error;
  }
  if (ctx.grantedPermissions && !ctx.grantedPermissions.includes(op.permission)) {
    const error = new ForbiddenError(
      `This connection was not granted the scope ${op.name} needs (${op.permission}). ` +
        "Reconnect the app with a wider scope, if your role allows it.",
      { permission: op.permission, granted: ctx.grantedPermissions },
    );
    await auditAlone({ ...base, gate: decision, outcome: "forbidden", error });
    throw error;
  }
  if (decision === "deny") {
    const error = new GateDeniedError(`The approval policy does not allow ${op.name}`, gate);
    await auditAlone({ ...base, gate: "deny", outcome: "denied", error });
    throw error;
  }

  const writes: (Compilable | CompiledQuery)[] = [];
  const changes: RecordChange[] = [];
  const activities: Compilable[] = [];
  const handlerCtx: HandlerContext = {
    operation: op.name,
    actor: ctx.actor,
    user: ctx.user,
    origin: ctx.origin,
    now,
    db: ctx.db.query,
    floor: ctx.floor ?? {},
    grantedPermissions: ctx.grantedPermissions,
    reason: ctx.reason,
    write: (...statements) => {
      writes.push(...statements);
    },
    recordChange: (change) => {
      changes.push(change);
    },
    postActivity: (activity) => {
      const id = newId("activity");
      activities.push(...activityStatements(ctx.db, ctx, now, id, activity));
      return id;
    },
    afterCommit,
    ...(ctx.extensionHost ? { extensionHost: ctx.extensionHost } : {}),
    ...(ctx.extension ? { extension: ctx.extension } : {}),
    ...(ctx.models ? { models: ctx.models } : {}),
    ...(ctx.widgetCache ? { widgetCache: ctx.widgetCache } : {}),
    pipeline: {
      crm: ctx.db,
      invoke: (name, nestedInput, nested) => {
        const target = ctx.resolveOperation?.(name);
        if (!target) throw new UnknownOperationError(name);
        return invokeOperation(target, nestedInput, {
          db: ctx.db,
          ...(ctx.floor ? { floor: ctx.floor } : {}),
          ...(ctx.clock ? { clock: ctx.clock } : {}),
          approvalExpiryDays: ctx.approvalExpiryDays,
          resolveOperation: ctx.resolveOperation,
          actor: nested.actor,
          user: nested.user,
          origin: nested.origin,
          grantedPermissions: nested.grantedPermissions,
          approval: nested.approval,
          reason: nested.reason,
          ...(ctx.extensionHost ? { extensionHost: ctx.extensionHost } : {}),
          ...(ctx.models ? { models: ctx.models } : {}),
          ...(ctx.widgetCache ? { widgetCache: ctx.widgetCache } : {}),
        });
      },
    },
  };

  const fail = async (error: unknown, gateDecision: GateDecision = "auto"): Promise<never> => {
    const typed = toOperationError(error);
    if (audited) await auditAlone({ ...base, gate: gateDecision, outcome: "error", error: typed });
    throw typed;
  };

  if (decision === "review" && !ctx.approval) {
    let queued: Awaited<ReturnType<typeof prepareQueuedAction>>;
    try {
      const overlay = await loadSessionOverlay(ctx.db.query, ctx.origin.sessionId, now);
      queued = await prepareQueuedAction({
        op,
        rawInput,
        input,
        db: ctx.db,
        actor: ctx.actor,
        user: ctx.user,
        origin: ctx.origin,
        grantedPermissions: ctx.grantedPermissions,
        reason: ctx.reason,
        bulkSize,
        now,
        expiryDays: ctx.approvalExpiryDays,
        overlay,
        dryRun: async (): Promise<DryRunResult> => {
          const dryChanges: RecordChange[] = [];
          const dryCtx: HandlerContext = {
            ...handlerCtx,
            write: () => {},
            recordChange: (change) => {
              dryChanges.push(change);
            },
            postActivity: () => newId("activity"),
            simulation: overlay,
          };
          const result = await op.handler(input, dryCtx);
          let output: unknown = null;
          if (!isAfterCommit(result)) {
            const checked = op.output.safeParse(result);
            output = checked.success ? checked.data : null;
          }
          return { output, changes: dryChanges };
        },
      });
    } catch (error) {
      return fail(error, "review");
    }
    try {
      await ctx.db.batch([
        ...queued.statements,
        auditInsert(ctx.db, {
          ...base,
          pendingActionId: queued.actionId,
          gate: "review",
          outcome: "review",
          result: { pendingActionId: queued.actionId, changeSetId: queued.pending.changeSetId },
        }),
      ]);
    } catch (error) {
      return fail(error, "review");
    }
    throw new PendingApprovalError(queued.pending);
  }

  // Reads by an MCP session see its pending actions applied (ADR 0022).
  if (op.risk === "read" && ctx.origin.sessionId && isSimulatedRead(op.name)) {
    const overlay = await loadSessionOverlay(ctx.db.query, ctx.origin.sessionId, now);
    if (!overlay.empty) {
      let output: unknown;
      try {
        output = await overlayRead(op.name, input as Record<string, unknown>, overlay, async () => {
          const checked = op.output.safeParse(await op.handler(input, handlerCtx));
          if (!checked.success) {
            throw new OperationError("invalid_output", `${op.name} returned an invalid result`, {
              issues: checked.error.issues,
            });
          }
          return checked.data;
        });
      } catch (error) {
        return fail(error);
      }
      if (audited) {
        await auditAlone({
          ...base,
          gate: decision,
          outcome: "ok",
          result: { simulated: true, ...((defaultSummary(output, []) as object | null) ?? {}) },
        });
      }
      return output as OperationOutput<O>;
    }
  }

  let result: unknown;
  try {
    result = await op.handler(input, handlerCtx);
  } catch (error) {
    return fail(error, decision);
  }

  if (op.risk === "read" && (writes.length || changes.length || activities.length)) {
    return fail(new OperationError("internal", `${op.name} is a read but queued writes`));
  }

  let bindings: Record<string, string> = {};
  if (ctx.approval) {
    try {
      assertUnchangedSincePreview(ctx.approval, changes);
    } catch (error) {
      return fail(error, decision);
    }
    bindings = bindProvisional(ctx.approval, changes);
  }

  const deferred = isAfterCommit(result) ? result : null;
  let output: unknown;
  if (!deferred) {
    const checked = op.output.safeParse(result);
    if (!checked.success) {
      return fail(
        new OperationError("invalid_output", `${op.name} returned an invalid result`, {
          issues: checked.error.issues,
        }),
      );
    }
    output = checked.data;
  }

  const statements: (Compilable | CompiledQuery)[] = [...writes];
  const changeRows: { o: string; r: string; a: string; d: string }[] = [];
  for (const change of changes) {
    const diff = change.diff ?? diffRecords(change.before, change.after);
    const timeline = timelineActivity(op.name, change, diff);
    if (timeline) handlerCtx.postActivity(timeline);
    changeRows.push({ o: change.object, r: change.id, a: change.action, d: JSON.stringify(diff) });
  }
  statements.push(...activities);

  const summary =
    op.auditSummary && !deferred ? op.auditSummary(output, input) : defaultSummary(output, changes);
  if (audited) {
    statements.push(
      auditInsert(ctx.db, { ...base, gate: decision, outcome: "ok", result: summary ?? null }),
      ...auditChangeInserts(ctx.db, auditId, now, changeRows),
    );
  }
  if (ctx.approval) {
    // Applied: the pending action and its audit row commit with the change itself.
    statements.push(
      ctx.db.query
        .updateTable("core_pending_action")
        .set({
          status: "applied",
          status_reason: null,
          applied_audit_id: audited ? auditId : null,
          bindings: JSON.stringify(bindings),
          result: JSON.stringify(summary ?? null),
          decided_by: ctx.approval.approvedBy,
          decided_at: now,
        })
        .where("id", "=", ctx.approval.actionId)
        .where("status", "=", "pending"),
    );
  }

  if (statements.length) {
    try {
      await ctx.db.batch(statements);
    } catch (error) {
      return fail(error, decision);
    }
  }

  if (deferred) {
    const checked = op.output.safeParse(await runAfterCommit(deferred));
    if (!checked.success) {
      throw new OperationError("invalid_output", `${op.name} returned an invalid result`, {
        issues: checked.error.issues,
      });
    }
    output = checked.data;
  }
  return output as OperationOutput<O>;
}
