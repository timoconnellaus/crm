// The invocation pipeline (ADR 0016, ADR 0011, ADR 0017, ADR 0018):
//
//   validate input → actor + role check → gate → handler → timeline activities → audit
//
// The handler's queued writes, the timeline activities and the audit rows commit together in one
// D1 batch (one transaction). Refusals (role, actor, gate) and failures are audited separately.
import type { AuditChangeAction, CrmDb } from "@crm/db";
import { type Compilable, sql } from "kysely";
import { diffRecords, type FieldDiff } from "./diff.ts";
import {
  ForbiddenError,
  GateDeniedError,
  OperationError,
  ReviewNotYetSupportedError,
  toOperationError,
  ValidationError,
} from "./errors.ts";
import { getObject } from "./fields/index.ts";
import { evaluateGate, type GateDecision, type GateFloor, type GateResult } from "./gate.ts";
import { newId } from "./ids.ts";
import {
  type AnyOperation,
  afterCommit,
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
      author_actor: ctx.actor,
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

/**
 * Runs one operation for one caller. Throws typed OperationErrors: ValidationError,
 * ForbiddenError, GateDeniedError, ReviewNotYetSupportedError, NotFoundError, ConflictError.
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
  const audited = isAudited(op, ctx.actor);
  const auditId = newId("audit");
  const base = { id: auditId, op, ctx, input, at: now } as const;

  // Gate first (pure, after one settings read) so refusals record what it would have decided.
  const policy = await loadApprovalPolicy(ctx.db.query);
  const bulkSize = op.bulkSize ? op.bulkSize(input) : 1;
  const gate: GateResult = evaluateGate(
    { actor: ctx.actor, risk: op.risk, bulkSize },
    policy,
    ctx.floor,
  );

  if (op.actors && !op.actors.includes(ctx.actor)) {
    const error = new ForbiddenError(`${op.name} cannot be called by ${ctx.actor} actors`, {
      actor: ctx.actor,
      allowed: op.actors,
    });
    await auditAlone({ ...base, gate: gate.decision, outcome: "forbidden", error });
    throw error;
  }
  if (!roleHasPermission(ctx.user.role, op.permission)) {
    const error = new ForbiddenError(`Your role (${ctx.user.role}) cannot ${op.name}`, {
      role: ctx.user.role,
      permission: op.permission,
    });
    await auditAlone({ ...base, gate: gate.decision, outcome: "forbidden", error });
    throw error;
  }
  if (gate.decision === "deny") {
    const error = new GateDeniedError(`The approval policy does not allow ${op.name}`, gate);
    await auditAlone({ ...base, gate: "deny", outcome: "denied", error });
    throw error;
  }
  if (gate.decision === "review") {
    const error = new ReviewNotYetSupportedError(
      `${op.name} needs review, and the approval queue is not available yet`,
      gate,
    );
    await auditAlone({ ...base, gate: "review", outcome: "review", error });
    throw error;
  }

  const writes: Compilable[] = [];
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
  };

  const fail = async (error: unknown): Promise<never> => {
    const typed = toOperationError(error);
    if (audited) await auditAlone({ ...base, gate: "auto", outcome: "error", error: typed });
    throw typed;
  };

  let result: unknown;
  try {
    result = await op.handler(input, handlerCtx);
  } catch (error) {
    return fail(error);
  }

  if (op.risk === "read" && (writes.length || changes.length || activities.length)) {
    return fail(new OperationError("internal", `${op.name} is a read but queued writes`));
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

  const statements: Compilable[] = [...writes];
  const changeRows: { o: string; r: string; a: string; d: string }[] = [];
  for (const change of changes) {
    const diff = change.diff ?? diffRecords(change.before, change.after);
    const timeline = timelineActivity(op.name, change, diff);
    if (timeline) handlerCtx.postActivity(timeline);
    changeRows.push({ o: change.object, r: change.id, a: change.action, d: JSON.stringify(diff) });
  }
  statements.push(...activities);

  if (audited) {
    const summary =
      op.auditSummary && !deferred
        ? op.auditSummary(output, input)
        : defaultSummary(output, changes);
    statements.push(
      auditInsert(ctx.db, { ...base, gate: "auto", outcome: "ok", result: summary ?? null }),
      ...auditChangeInserts(ctx.db, auditId, now, changeRows),
    );
  }

  if (statements.length) {
    try {
      await ctx.db.batch(statements);
    } catch (error) {
      return fail(error);
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
