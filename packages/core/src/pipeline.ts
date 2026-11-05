// The invocation pipeline (ADR 0016, ADR 0011, ADR 0017, ADR 0018, ADR 0022):
//
//   validate input → actor + role (+ token scope) check → gate → handler → timeline → audit
//
// The handler's queued writes, the timeline activities and the audit rows commit together in one
// D1 batch (one transaction). Refusals (role, actor, gate) and failures are audited separately.
// A gate `review` dry-runs the handler and queues a pending action instead (approvals/queue.ts);
// reads by an MCP session see its pending actions applied (approvals/simulation.ts).
import type { AuditChangeAction, CrmDb, ReviewSource } from "@relationship-os/db";
import { checkGrant } from "@relationship-os/sdk";
import { type Compilable, type CompiledQuery, sql } from "kysely";
import type { AiAdmin } from "./ai/admin.ts";
import type { AiEnv } from "./ai/client.ts";
import { embeddingQueueStatement, SELF_ENQUEUEING } from "./ai/embedding.ts";
import type { VectorStore } from "./ai/vectors.ts";
import { matchesPreviewValue } from "./approvals/caps.ts";
import { type DryRunResult, prepareQueuedAction } from "./approvals/queue.ts";
import {
  isSimulatedRead,
  loadSessionOverlay,
  overlayRead,
  simulatedTitle,
} from "./approvals/simulation.ts";
import type { AssistantConversationStore } from "./assistant/scrub.ts";
import { eventOriginOf, isBulkOperation, recordEventMessages } from "./automations/events.ts";
import {
  deliverOutbox,
  type OutboxEntry,
  outboxEntries,
  outboxInserts,
} from "./automations/outbox.ts";
import type { TestSimulation } from "./automations/simulate.ts";
import type { AutomationHost, EventSink } from "./automations/types.ts";
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
import type { BlobStore, IntegrationRuntime } from "./integrations/runtime.ts";
import type { Judge } from "./judge/types.ts";
import type { ModelRunner } from "./models.ts";
import { notifyStatements } from "./notifications/send.ts";
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
import { resolveInputFilter } from "./relative.ts";
import { loadApprovalPolicy } from "./settings.ts";
import type { UpdaterRuntime } from "./updates.ts";

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
  /** The integration host (connection.*, integration.*, outbound approvals). */
  integrations?: IntegrationRuntime;
  /** Blob storage (R2) for email bodies. */
  blobs?: BlobStore;
  /** Actor `extension` only: the calling extension and its declared permissions (ADR 0025). */
  extension?: ExtensionCaller;
  /** Model roles (ADR 0009); absent when the deployment has no AI binding. */
  models?: ModelRunner;
  /**
   * The judge (ADR 0230), built by `judgeFor`. Absent, or off without a key: every placement
   * behaves as it did before stage 11. Nested invocations inherit it.
   */
  judge?: Judge;
  /**
   * The person's own words in this conversation, passed by code (the assistant's Durable Object
   * takes them from the person's turns), never by a model. `authoring.intent` checks an
   * automation against them. Not inherited by nested invocations.
   */
  personsWords?: string | undefined;
  /** Widget result cache (ADR 0057); absent means the Workers Cache API. */
  widgetCache?: WidgetCache;
  /** The self-updater (ADR 0164): GitHub Releases and the Cloudflare API. */
  updater?: UpdaterRuntime;
  /**
   * Where committed record changes go as automation events (ADR 0130): ros-app and ros-runner
   * pass a Queue producer. Absent: no events (tests, scripts). Nested invocations inherit it.
   */
  events?: EventSink;
  /** ros-runner's automation host (automation.test, run, retry, replay, cancel). */
  automationHost?: AutomationHost;
  /** The in-app assistant's conversations (ros-app), which an erase scrubs. */
  assistantConversations?: AssistantConversationStore;
  /**
   * Test mode (ADR 0133): the call is simulated against this in-memory overlay. The gate is
   * evaluated and recorded, writes are dry-run, nothing is written and no events are sent.
   */
  simulate?: TestSimulation;
  /** Record embeddings (Vectorize, ADR 0154); absent: semantic search is off. */
  vectors?: VectorStore;
  /**
   * Set where the automation events consumer embeds committed changes (a Vectorize binding on
   * ros-runner, ADR 0154 amendment): with `events`, the pipeline then writes no embedding queue
   * row, so every write is embedded exactly once, from its event.
   */
  embedViaEvents?: boolean;
  /** Cloudflare API access for Settings → AI (keys, usage; ADR 0151, 0152). */
  aiAdmin?: AiAdmin;
  /** The Worker's AI environment, for provider readiness in Settings → AI. */
  aiEnv?: AiEnv;
  /**
   * Called after a successful commit (ADR 0154): the post-commit hook. ros-app uses it to drain
   * the embedding queue in the background when the call queued anything (only without an event
   * sink, and for operations that queue themselves: erase, sync).
   */
  onCommitted?: (event: CommitEvent) => void;
  /**
   * Called after a gate `review` committed a pending action (ADR 0204), with this context. ros-app
   * runs the policy adjudicator on it in the background (`waitUntil`): never awaited, so the
   * caller gets `pending_approval` exactly as before. Not called in test mode.
   */
  onQueued?: (event: QueuedEvent, ctx: InvocationContext) => void;
}

/** A pending action the pipeline just queued, for the post-queue hook. */
export interface QueuedEvent {
  actionId: string;
  changeSetId: string;
  operation: string;
  reviewSource: ReviewSource;
}

/** What a committed call changed, for post-commit hooks. */
export interface CommitEvent {
  operation: string;
  changes: { object: string; id: string; action: string }[];
  /** The batch queued records in core_embedding_queue for (re-)embedding. */
  embeddingsQueued: boolean;
}

/** The installed extension whose principal is `userId`, with its declared permissions. */
async function loadExtensionCaller(db: CrmDb, userId: string): Promise<ExtensionCaller | null> {
  const row = await db.query
    .selectFrom("core_extensions")
    .select(["id", "manifest", "status"])
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (row?.status !== "active") return null;
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

/**
 * Reads by humans are not audited; every write, refusal and non-human call is. A non-human read
 * that succeeds is counted in core_audit_read_counts instead of getting its own row (ADR 0090);
 * one that fails or is refused still gets a full audit row.
 */
function isAudited(op: AnyOperation, actor: Actor): boolean {
  return op.risk !== "read" || actor !== "human";
}

/** The UTC hour a read is counted in: 'YYYY-MM-DDTHH:00:00.000Z'. */
export function readCountHour(at: string): string {
  return `${at.slice(0, 13)}:00:00.000Z`;
}

/** Who, within the actor, a read is counted against: the connected app, extension or automation. */
function readCaller(ctx: InvocationContext): string {
  const o = ctx.origin;
  return o.sessionId ?? o.extensionId ?? ctx.extension?.id ?? o.automationId ?? o.clientId ?? "";
}

/** Counts one successful non-human read (an upsert of one row). Never throws. */
async function countRead(
  op: AnyOperation,
  ctx: InvocationContext,
  at: string,
  simulated: boolean,
): Promise<void> {
  try {
    await ctx.db.batch([
      ctx.db.query
        .insertInto("core_audit_read_counts")
        .values({
          hour: readCountHour(at),
          actor: ctx.actor,
          user_id: ctx.user.id,
          caller: readCaller(ctx),
          operation: op.name,
          count: 1,
          simulated: simulated ? 1 : 0,
          first_at: at,
          last_at: at,
        })
        .onConflict((oc) =>
          oc.columns(["hour", "actor", "user_id", "caller", "operation"]).doUpdateSet((eb) => ({
            count: eb("core_audit_read_counts.count", "+", 1),
            simulated: eb("core_audit_read_counts.simulated", "+", eb.ref("excluded.simulated")),
            last_at: sql<string>`max(core_audit_read_counts.last_at, excluded.last_at)`,
          })),
        ),
    ]);
  } catch (error) {
    console.error("failed to count read", op.name, error);
  }
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

/** Writes a standalone audit row (refusals and failures). Never throws. Not in test mode. */
async function auditAlone(row: AuditRow): Promise<void> {
  if (row.ctx.simulate) return;
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
  const display = change.timeline?.labels ?? {};
  return {
    subject: change.timeline?.subject ?? `${labels.join(", ")} changed`,
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
        ...(display[f.name]
          ? {
              beforeLabel: display[f.name]?.before ?? null,
              afterLabel: display[f.name]?.after ?? null,
            }
          : {}),
      })),
    },
    links: change.timeline?.links ?? [{ object: change.object, id: change.id }],
  };
}

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
      if (!matchesPreviewValue(change.before[field], values.before)) {
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
  // Relative filter values ({ $relative: "me" }, "startOfMonth", …) resolve per call (ADR 0103).
  const input: unknown = resolveInputFilter(op.name, parsed.data, ctx.user.id, now);
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
  // What routed it to review (ADR 0204): the adjudicator never approves floor or forced reviews.
  const reviewSource: ReviewSource = forced
    ? "always"
    : gate.floorDecision === "review"
      ? "floor"
      : gate.policyDecision === "review"
        ? "policy"
        : "dependency";
  // A write that refers to a record still pending creation can only be queued after it.
  const provisionalRefs = op.risk === "read" ? [] : findProvisionalIds(rawInput);
  // (Test mode reports what the gate decides: its provisional ids stand for real ones.)
  if (decision === "auto" && provisionalRefs.length && !ctx.approval && !ctx.simulate) {
    decision = "review";
  }

  if (op.actors && !op.actors.includes(ctx.actor)) {
    const error = new ForbiddenError(`${op.name} cannot be called by ${ctx.actor} actors`, {
      actor: ctx.actor,
      allowed: op.actors,
    });
    await auditAlone({ ...base, gate: decision, outcome: "forbidden", error });
    throw error;
  }
  if (ctx.actor === "extension" || (ctx.actor === "automation" && ctx.extension)) {
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
    auditId,
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
    ...(ctx.integrations ? { integrations: ctx.integrations } : {}),
    ...(ctx.blobs ? { blobs: ctx.blobs } : {}),
    ...(ctx.extension ? { extension: ctx.extension } : {}),
    ...(ctx.models ? { models: ctx.models } : {}),
    ...(ctx.judge ? { judge: ctx.judge } : {}),
    ...(ctx.personsWords ? { personsWords: ctx.personsWords } : {}),
    ...(ctx.widgetCache ? { widgetCache: ctx.widgetCache } : {}),
    ...(ctx.updater ? { updater: ctx.updater } : {}),
    ...(ctx.vectors ? { vectors: ctx.vectors } : {}),
    ...(ctx.aiAdmin ? { aiAdmin: ctx.aiAdmin } : {}),
    ...(ctx.aiEnv ? { aiEnv: ctx.aiEnv } : {}),
    ...(ctx.events && !ctx.simulate ? { events: ctx.events } : {}),
    ...(ctx.automationHost ? { automationHost: ctx.automationHost } : {}),
    ...(ctx.assistantConversations ? { assistantConversations: ctx.assistantConversations } : {}),
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
          ...(ctx.integrations ? { integrations: ctx.integrations } : {}),
          ...(ctx.blobs ? { blobs: ctx.blobs } : {}),
          ...(ctx.models ? { models: ctx.models } : {}),
          ...(ctx.judge ? { judge: ctx.judge } : {}),
          ...(ctx.widgetCache ? { widgetCache: ctx.widgetCache } : {}),
          ...(ctx.vectors ? { vectors: ctx.vectors } : {}),
          ...(ctx.aiAdmin ? { aiAdmin: ctx.aiAdmin } : {}),
          ...(ctx.aiEnv ? { aiEnv: ctx.aiEnv } : {}),
          ...(ctx.onCommitted ? { onCommitted: ctx.onCommitted } : {}),
          ...(ctx.onQueued ? { onQueued: ctx.onQueued } : {}),
          ...(ctx.embedViaEvents ? { embedViaEvents: true } : {}),
          ...(ctx.events ? { events: ctx.events } : {}),
          ...(ctx.automationHost ? { automationHost: ctx.automationHost } : {}),
          ...(ctx.assistantConversations
            ? { assistantConversations: ctx.assistantConversations }
            : {}),
          ...(ctx.simulate ? { simulate: ctx.simulate } : {}),
        });
      },
    },
  };

  const fail = async (error: unknown, gateDecision: GateDecision = "auto"): Promise<never> => {
    const typed = toOperationError(error);
    if (audited) await auditAlone({ ...base, gate: gateDecision, outcome: "error", error: typed });
    throw typed;
  };

  if (ctx.simulate && op.risk !== "read") {
    return simulateWrite(op, rawInput, input, ctx, handlerCtx, {
      now,
      bulkSize,
      decision,
      reason: gate,
    }) as Promise<OperationOutput<O>>;
  }

  if (decision === "review" && !ctx.approval) {
    let queued: Awaited<ReturnType<typeof prepareQueuedAction>>;
    let notices: Compilable[] = [];
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
        reviewSource,
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
      if (queued.changeSetCreated && ctx.actor !== "human") {
        notices = await pendingApprovalNotice(ctx, queued.pending.changeSetId, now);
      }
    } catch (error) {
      return fail(error, "review");
    }
    try {
      await ctx.db.batch([
        ...queued.statements,
        ...notices,
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
    if (ctx.onQueued) {
      try {
        ctx.onQueued(
          {
            actionId: queued.actionId,
            changeSetId: queued.pending.changeSetId,
            operation: op.name,
            reviewSource,
          },
          ctx,
        );
      } catch (error) {
        console.error("post-queue hook failed", op.name, error);
      }
    }
    throw new PendingApprovalError(queued.pending);
  }

  // Reads by an MCP session see its pending actions applied (ADR 0022); reads in test mode see
  // the run's simulated writes (ADR 0133).
  if (op.risk === "read" && (ctx.origin.sessionId || ctx.simulate) && isSimulatedRead(op.name)) {
    const overlay =
      ctx.simulate?.overlay ?? (await loadSessionOverlay(ctx.db.query, ctx.origin.sessionId, now));
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
      if (audited && !ctx.simulate) await countRead(op, ctx, now, true);
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
  // Records whose text changed must be re-embedded exactly once (ADR 0154 amendment): where the
  // stage 5 events consumer embeds (`embedViaEvents`), it does so from the record events this call
  // emits and no queue row is written; otherwise (no Vectorize, local dev, tests, scripts) they
  // are queued in this batch for the post-commit drain and the cron.
  const embedding =
    op.risk === "read" || (ctx.events && ctx.embedViaEvents && !ctx.simulate)
      ? null
      : embeddingQueueStatement(ctx.db.query, changes, now);
  if (embedding) statements.push(embedding);

  const summary =
    op.auditSummary && !deferred ? op.auditSummary(output, input) : defaultSummary(output, changes);
  if (audited && op.risk === "read") {
    // A successful non-human read: counted, not audited row by row (ADR 0090).
    if (!ctx.simulate) await countRead(op, ctx, now, false);
  } else if (audited) {
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

  // The record changes become automation events (ADR 0130), written to the outbox in this same
  // batch (ADR 0171) and sent after commit: a failed send is retried by ros-runner's cron.
  let outbox: OutboxEntry[] = [];
  if (ctx.events && changes.length) {
    const origin = eventOriginOf({
      actor: ctx.actor,
      userId: ctx.user.id,
      origin: ctx.origin,
      operation: op.name,
      auditId,
      bulk: isBulkOperation(op.name, bulkSize),
    });
    outbox = outboxEntries(recordEventMessages(auditId, now, origin, changes));
    statements.push(...outboxInserts(ctx.db, outbox, now));
  }

  if (statements.length) {
    try {
      await ctx.db.batch(statements);
    } catch (error) {
      return fail(error, decision);
    }
  }

  if (statements.length && ctx.onCommitted) {
    try {
      ctx.onCommitted({
        operation: op.name,
        changes: changes.map(({ object, id, action }) => ({ object, id, action })),
        embeddingsQueued: Boolean(embedding) || SELF_ENQUEUEING.has(op.name),
      });
    } catch (error) {
      console.error("post-commit hook failed", op.name, error);
    }
  }

  // Committed: send the events (one send per outbox row, usually one per operation).
  if (ctx.events && outbox.length) await deliverOutbox(ctx.db, ctx.events, outbox);

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

/** One line on why the gate decided what it did, for test-mode reports. */
function gateReason(gate: GateResult, op: AnyOperation, actor: Actor, bulkSize: number): string {
  const what = `${op.risk}${bulkSize > 1 ? ` of ${bulkSize} records` : ""}`;
  const floor = gate.floorDecision ? `; the deployment floor says ${gate.floorDecision}` : "";
  return `${gate.preset} policy: ${actor} ${what} → ${gate.policyDecision}${floor}`;
}

/** The title a create or change would give its record, from the overlay or the diff. */
function writeTitle(
  object: string,
  record: { object: string; id: string; record: Record<string, unknown> | null } | undefined,
  diff: FieldDiff,
): string | null {
  if (record?.record) {
    const title = simulatedTitle({ ...record, state: "live", actionId: "", changeSetId: "" });
    if (title) return title;
  }
  const titleField = getObject(object)?.titleField;
  const value =
    (titleField ? diff[titleField]?.after : undefined) ??
    diff.title?.after ??
    diff.name?.after ??
    diff.displayName?.after ??
    diff.subject?.after;
  return typeof value === "string" ? value : null;
}

/**
 * Test mode (ADR 0133): records the gate's decision, dry-runs the handler as the approval queue
 * does, adds the simulated records to the run's overlay and returns the simulated output (or
 * throws PendingApprovalError when the gate would queue it). Nothing is written.
 */
async function simulateWrite(
  op: AnyOperation,
  rawInput: unknown,
  input: unknown,
  ctx: InvocationContext,
  handlerCtx: HandlerContext,
  info: { now: string; bulkSize: number; decision: GateDecision; reason: GateResult },
): Promise<unknown> {
  const sim = ctx.simulate as TestSimulation;
  const review = info.decision === "review" && !ctx.approval;
  sim.gates.push({
    operation: op.name,
    gate: info.decision,
    bulkSize: info.bulkSize,
    reason: gateReason(info.reason, op, ctx.actor, info.bulkSize),
  });
  const overlay = sim.overlay;
  const queued = await prepareQueuedAction({
    op,
    rawInput,
    input,
    db: ctx.db,
    actor: ctx.actor,
    user: ctx.user,
    origin: ctx.origin,
    grantedPermissions: ctx.grantedPermissions,
    reason: ctx.reason,
    bulkSize: info.bulkSize,
    now: info.now,
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
  overlay.add(queued.actionId, queued.pending.changeSetId, queued.records);
  for (const p of queued.preview) {
    sim.writes.push({
      object: p.object,
      id: p.id,
      action: p.action,
      title: writeTitle(
        p.object,
        queued.records.find((r) => r.object === p.object && r.id === p.id),
        p.diff,
      ),
      operation: op.name,
    });
  }
  if (op.name === "notification.send") {
    const out = (queued.pending.simulated ?? {}) as { userIds?: unknown };
    const userIds = Array.isArray(out.userIds) ? out.userIds.map(String) : [];
    const names = userIds.length
      ? await ctx.db.query
          .selectFrom("core_user")
          .select(["id", "name"])
          .where("id", "in", userIds)
          .execute()
      : [];
    const sent = input as { title?: string; type?: string };
    sim.notifications.push({
      to: userIds,
      toNames: userIds.map((id) => names.find((n) => n.id === id)?.name ?? id),
      type: sent.type ?? (ctx.actor === "automation" ? "automation.message" : "system.message"),
      title: String(sent.title ?? ""),
    });
  }
  if (review) {
    throw new PendingApprovalError({
      ...queued.pending,
      message: `Test mode: ${op.name} would wait for approval (${gateReason(info.reason, op, ctx.actor, info.bulkSize)}). Nothing was queued.`,
    });
  }
  return queued.pending.simulated;
}

/**
 * The `approval.pending` notice for a change set a non-human actor just opened (ADR 0130): its
 * user for MCP and the assistant, the admins for automations and extensions. Committed with the
 * pending action; a failure to plan it never blocks the queueing.
 */
async function pendingApprovalNotice(
  ctx: InvocationContext,
  changeSetId: string,
  now: string,
): Promise<Compilable[]> {
  const toAdmins = ctx.actor === "automation" || ctx.actor === "extension";
  const who =
    ctx.actor === "automation"
      ? `The automation ${ctx.origin.automationId ?? ""}`.trim()
      : ctx.actor === "extension"
        ? `The extension ${ctx.extension?.id ?? ctx.origin.extensionId ?? ""}`.trim()
        : (ctx.origin.clientName ?? "An AI agent");
  try {
    const plan = await notifyStatements(
      ctx.db.query,
      {
        to: toAdmins ? [{ role: "admin" }] : [{ userId: ctx.user.id }],
        type: "approval.pending",
        title: `${who} is waiting for your approval`,
        body: "Review the changes in the Approvals inbox.",
        link: { kind: "approval", changeSetId },
        dedupeKey: `approval:${changeSetId}`,
        source: {
          actor: ctx.actor,
          userId: ctx.user.id,
          ...(ctx.origin.automationId ? { automationId: ctx.origin.automationId } : {}),
          ...(ctx.origin.runId ? { runId: ctx.origin.runId } : {}),
        },
      },
      now,
    );
    return plan.statements;
  } catch (error) {
    console.error("pending approval notice failed", error);
    return [];
  }
}
