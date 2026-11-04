// Recording a pending action (ADR 0022). When the gate says `review`, the pipeline dry-runs the
// handler (its writes are discarded), turns the result into a diff preview and simulated records,
// finds the earlier pending actions it depends on, and queues it in the session's change set.
import type { CrmDb } from "@crm/db";
import type { Compilable } from "kysely";
import { diffRecords, type FieldDiff } from "../diff.ts";
import { ConflictError, NotFoundError, type PendingApproval, ValidationError } from "../errors.ts";
import {
  findIds,
  findProvisionalIds,
  ID_PREFIXES,
  isProvisionalId,
  newId,
  replaceIds,
  toProvisionalId,
} from "../ids.ts";
import type { AnyOperation, RecordChange, SimulatedRecord } from "../operation.ts";
import type { Origin, Permission } from "../principals.ts";
import { capPreview, capSimulated, INPUT_MAX_BYTES } from "./caps.ts";
import { type Overlay, SIMULATED_OBJECTS, titlesFor } from "./simulation.ts";

export const DEFAULT_APPROVAL_EXPIRY_DAYS = 7;

type Rec = Record<string, unknown>;

export interface DryRunResult {
  /** The handler's output, validated, or null when it is read after commit. */
  output: unknown;
  changes: RecordChange[];
}

export interface QueueRequest {
  op: AnyOperation;
  rawInput: unknown;
  input: unknown;
  db: CrmDb;
  actor: string;
  user: { id: string; name: string };
  origin: Origin;
  grantedPermissions?: readonly Permission[] | undefined;
  reason?: string | undefined;
  bulkSize: number;
  now: string;
  expiryDays?: number | undefined;
  overlay: Overlay;
  dryRun: () => Promise<DryRunResult>;
}

export interface QueuedAction {
  statements: Compilable[];
  actionId: string;
  pending: PendingApproval;
}

const OBJECT_BY_PREFIX = new Map<string, string>(
  Object.entries(ID_PREFIXES).map(([kind, prefix]) => [prefix, kind]),
);

/** The object kind of an id from its prefix (`per_…` → person). */
export function objectOfId(id: string): string | undefined {
  return OBJECT_BY_PREFIX.get(id.slice(0, id.indexOf("_")));
}

function isDeletion(change: RecordChange, diff: FieldDiff): boolean {
  if (change.action === "delete" || change.action === "erase") return true;
  const deletedAt = diff.deletedAt?.after ?? (change.after?.deletedAt as unknown);
  return deletedAt !== undefined && deletedAt !== null;
}

/** Applies a diff's `after` values onto a record, for fields the record has. */
function applyDiff(base: Rec, diff: FieldDiff, now: string): Rec {
  const out: Rec = { ...base };
  for (const [field, change] of Object.entries(diff)) {
    if (field === "links") continue; // link keys; handled by the object's own rebuild below
    if (field in out) out[field] = change.after;
  }
  if ("updatedAt" in out) out.updatedAt = now;
  return out;
}

async function linksFromKeys(
  db: CrmDb,
  keys: unknown,
  overlay: Overlay,
): Promise<{ object: string; id: string; title: string | null }[]> {
  if (!Array.isArray(keys)) return [];
  const refs = keys
    .filter((k): k is string => typeof k === "string" && k.includes(":"))
    .map((k) => {
      const at = k.indexOf(":");
      return { object: k.slice(0, at), id: k.slice(at + 1) };
    });
  const titles = await titlesFor(db.query, refs, overlay);
  return refs.map((r) => ({ ...r, title: titles.get(`${r.object}:${r.id}`) ?? null }));
}

async function userName(db: CrmDb, id: unknown): Promise<string | null> {
  if (typeof id !== "string") return null;
  const row = await db.query
    .selectFrom("core_user")
    .select("name")
    .where("id", "=", id)
    .executeTakeFirst();
  return row?.name ?? null;
}

/**
 * The record a create would produce, for handlers that read their output after commit (task,
 * activity). Built from the change's `after` snapshot.
 */
async function buildCreated(
  req: QueueRequest,
  change: RecordChange,
  id: string,
): Promise<Rec | null> {
  const after = (change.after ?? {}) as Rec;
  const base = {
    id,
    createdAt: req.now,
    createdBy: req.user.id,
    updatedAt: req.now,
    deletedAt: null,
  };
  if (change.object === "task") {
    return {
      ...base,
      title: after.title,
      notes: after.notes ?? null,
      dueAt: after.dueAt ?? null,
      status: after.status ?? "open",
      completedAt: null,
      completedBy: null,
      assigneeId: after.assigneeId ?? null,
      assigneeName: await userName(req.db, after.assigneeId),
      links: await linksFromKeys(req.db, after.links, req.overlay),
    };
  }
  if (change.object === "activity") {
    return {
      ...base,
      type: after.type,
      subject: after.subject ?? null,
      body: after.body ?? null,
      payload: after.payload ?? {},
      occurredAt: after.occurredAt ?? req.now,
      authorUserId: req.user.id,
      authorName: req.user.name,
      authorActor: req.actor,
      links: await linksFromKeys(req.db, after.links, req.overlay),
    };
  }
  return null;
}

/** Simulated records for every change, in order, keyed by (remapped) id. */
async function simulateRecords(
  req: QueueRequest,
  changes: RecordChange[],
  output: unknown,
  ids: ReadonlyMap<string, string>,
): Promise<{ object: string; id: string; state: "live" | "deleted"; record: Rec | null }[]> {
  const out = new Map<
    string,
    { object: string; id: string; state: "live" | "deleted"; record: Rec | null }
  >();
  for (const change of changes) {
    const id = ids.get(change.id) ?? change.id;
    const key = `${change.object}:${id}`;
    const diff = change.diff ?? diffRecords(change.before, change.after);
    const objectSim = SIMULATED_OBJECTS[change.object];
    if (isDeletion(change, diff)) {
      out.set(key, { object: change.object, id, state: "deleted", record: null });
      continue;
    }
    let record: Rec | null = null;
    if (change.action === "create") {
      const direct = output as Rec | null;
      record =
        direct && typeof direct === "object" && direct.id === change.id
          ? replaceIds(direct, ids)
          : await buildCreated(req, change, id);
    } else if (objectSim) {
      const prior = out.get(key)?.record ?? req.overlay.record(change.object, id)?.record ?? null;
      const base = prior ?? (isProvisionalId(id) ? null : await objectSim.load(req.db.query, id));
      if (base) {
        record = applyDiff(base, diff, req.now);
        if (change.action === "restore") record.deletedAt = null;
        if ("links" in diff && "links" in record) {
          record.links = await linksFromKeys(req.db, diff.links?.after, req.overlay);
        }
      }
    }
    out.set(key, { object: change.object, id, state: "live", record });
  }
  return [...out.values()];
}

/** Dependencies: the latest earlier pending action (in this session) per touched record. */
function dependencies(
  overlay: Overlay,
  touched: readonly { object: string; id: string }[],
): string[] {
  const deps = new Set<string>();
  for (const t of touched) {
    const sim: SimulatedRecord | undefined = overlay.record(t.object, t.id);
    if (sim) deps.add(sim.actionId);
  }
  return [...deps];
}

/** Finds or creates the change set new actions from this caller go into. */
export async function targetChangeSet(
  req: Pick<QueueRequest, "db" | "origin" | "user" | "actor" | "now">,
): Promise<{ id: string; statements: Compilable[] }> {
  const sessionId = req.origin.sessionId ?? null;
  let query = req.db.query
    .selectFrom("core_change_set")
    .select(["id"])
    .where("state", "=", "open")
    .where("user_id", "=", req.user.id);
  query = sessionId
    ? query.where("session_id", "=", sessionId)
    : query.where("session_id", "is", null).where("actor", "=", req.actor as never);
  // An explicit set (changeset.begin) wins over the session's default set.
  const open = await query.orderBy("explicit", "desc").orderBy("id", "desc").executeTakeFirst();
  if (open) {
    return {
      id: open.id,
      statements: [
        req.db.query
          .updateTable("core_change_set")
          .set({ updated_at: req.now })
          .where("id", "=", open.id),
      ],
    };
  }
  const id = newId("changeSet");
  return {
    id,
    statements: [
      req.db.query.insertInto("core_change_set").values({
        id,
        title: null,
        session_id: sessionId,
        client_id: req.origin.clientId ?? null,
        client_name: req.origin.clientName ?? null,
        user_id: req.user.id,
        actor: req.actor as never,
        origin: JSON.stringify(req.origin),
        explicit: 0,
        state: "open",
        created_at: req.now,
        updated_at: req.now,
      }),
    ],
  };
}

export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

/**
 * Dry-runs the call and prepares the statements that queue it. The pipeline adds the audit row
 * and commits everything in one batch, then throws PendingApprovalError with `pending`.
 */
export async function prepareQueuedAction(req: QueueRequest): Promise<QueuedAction> {
  const inputJson = JSON.stringify(req.rawInput ?? {});
  if (inputJson.length > INPUT_MAX_BYTES) {
    throw new ValidationError(
      `${req.op.name} needs approval, but its input (${inputJson.length} bytes) is too large to ` +
        `queue for review (limit ${INPUT_MAX_BYTES} bytes). Split it into smaller calls, or ask ` +
        "a person to run it in the app.",
      { field: "input", bytes: inputJson.length, limit: INPUT_MAX_BYTES },
    );
  }
  const referenced = findProvisionalIds(req.rawInput);
  for (const id of referenced) {
    const object = objectOfId(id);
    const sim = object ? req.overlay.record(object, id) : undefined;
    if (!sim || sim.state === "deleted") {
      throw new ValidationError(
        `${id} is not a pending record in this session (it may have been approved, rejected or expired). ` +
          "Use approval.status to find its real id.",
        { field: "id", id },
      );
    }
  }

  let dry: DryRunResult;
  try {
    dry = await req.dryRun();
  } catch (error) {
    if (error instanceof NotFoundError && referenced.length) {
      throw new ValidationError(
        `${req.op.name} cannot be queued against a record that is still pending creation ` +
          `(${referenced.join(", ")}). You can link activities and tasks to it; put other ` +
          "values in the create itself, or wait until it is approved.",
        { provisional: referenced },
      );
    }
    throw error;
  }

  const ids = new Map<string, string>();
  const provisional: { object: string; id: string }[] = [];
  for (const change of dry.changes) {
    if (change.action === "create" && !ids.has(change.id)) {
      const pid = toProvisionalId(change.id);
      ids.set(change.id, pid);
      provisional.push({ object: change.object, id: pid });
    }
  }

  const records = await simulateRecords(req, dry.changes, dry.output, ids);
  const first = records[0];
  const simulatedOutput =
    dry.output !== null && dry.output !== undefined
      ? replaceIds(dry.output, ids)
      : first?.state === "live"
        ? first.record
        : null;

  const preview = dry.changes.slice(0, 200).map((change) => ({
    object: change.object,
    id: ids.get(change.id) ?? change.id,
    action: change.action,
    diff: replaceIds(change.diff ?? diffRecords(change.before, change.after), ids),
  }));

  // An action on a record (changing it, or referring to it, e.g. a link) depends on the
  // earlier pending action that created or changed that record.
  const mentioned = findIds(req.rawInput).map((id) => ({
    object: objectOfId(id) ?? "unknown",
    id,
  }));
  const touched = [...records.filter((r) => !provisional.some((p) => p.id === r.id)), ...mentioned];
  const dependsOn = dependencies(req.overlay, touched);

  const changeSet = await targetChangeSet(req);
  const actionId = newId("pendingAction");
  const expiresAt = addDays(req.now, req.expiryDays ?? DEFAULT_APPROVAL_EXPIRY_DAYS);
  const reason = req.reason?.trim() || "No reason given";

  const recordRows = new Map<string, { object_type: string; record_id: string; action: string }>();
  for (const p of preview) {
    recordRows.set(`${p.object}:${p.id}`, {
      object_type: p.object,
      record_id: p.id,
      action: p.action,
    });
  }
  for (const id of referenced) {
    const object = objectOfId(id) ?? "unknown";
    if (!recordRows.has(`${object}:${id}`)) {
      recordRows.set(`${object}:${id}`, {
        object_type: object,
        record_id: id,
        action: "reference",
      });
    }
  }

  // Stored copies are capped so the row stays far below D1's 2 MB limit (ADR 0090).
  const stored = capPreview(preview);
  const storedSim = capSimulated(simulatedOutput ?? null, records);
  const truncated =
    stored.omitted || storedSim.omitted || storedSim.outputOmitted
      ? {
          truncated: {
            previewOmitted: stored.omitted,
            recordsOmitted: storedSim.omitted,
            outputOmitted: storedSim.outputOmitted,
          },
        }
      : {};

  const statements: Compilable[] = [
    ...changeSet.statements,
    req.db.query.insertInto("core_pending_action").values({
      id: actionId,
      change_set_id: changeSet.id,
      operation: req.op.name,
      risk: req.op.risk,
      input: inputJson,
      reason,
      actor: req.actor as never,
      user_id: req.user.id,
      origin: JSON.stringify(req.origin),
      granted_permissions: req.grantedPermissions ? JSON.stringify(req.grantedPermissions) : null,
      bulk_size: req.bulkSize,
      preview: JSON.stringify(stored.preview),
      simulated: JSON.stringify({
        output: storedSim.output,
        records: storedSim.records,
        ...truncated,
      }),
      provisional: JSON.stringify(provisional),
      depends_on: JSON.stringify(dependsOn),
      status: "pending",
      created_at: req.now,
      expires_at: expiresAt,
    }),
  ];
  // D1 allows 100 bound parameters per statement: 4 per row, so 20 rows per insert.
  const rows = [...recordRows.values()];
  for (let i = 0; i < rows.length; i += 20) {
    statements.push(
      req.db.query
        .insertInto("core_pending_action_records")
        .values(rows.slice(i, i + 20).map((r) => ({ action_id: actionId, ...r }))),
    );
  }

  const provisionalIds = provisional.map((p) => p.id);
  const message =
    `Queued for approval, NOT applied yet: ${req.op.name} is pending action ${actionId} in ` +
    `change set ${changeSet.id}. A person must approve it in the CRM's Approvals inbox; until ` +
    `then only your reads in this session show it as if applied. It expires ${expiresAt}.` +
    (provisionalIds.length
      ? ` Use the provisional id ${provisionalIds.join(", ")} for follow-up actions in this session.`
      : "") +
    " Tell the user the change is waiting for approval.";

  return {
    statements,
    actionId,
    pending: {
      status: "pending_approval",
      changeSetId: changeSet.id,
      actionId,
      operation: req.op.name,
      provisionalIds,
      dependsOn,
      expiresAt,
      simulated: simulatedOutput ?? null,
      message,
    },
  };
}

/** A typed error for an action that cannot be approved or rejected in its current state. */
export class ApprovalStateError extends ConflictError {
  override name = "ApprovalStateError";
}
