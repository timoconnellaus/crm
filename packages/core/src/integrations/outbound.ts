// Outbound actions (ADR 0051): what the integration host's ApprovalQueue does with a gatekeeper's
// `submitAction(n, description)`. The gate decides once, at submit, as risk class `outbound` keyed
// by the action's kind. A `review` decision mirrors the action into the approval queue as an
// `outbound` pending action in the caller's change set; approval later calls the facet's
// `applyAction(n)` (approval.ts), in action order per facet. The gatekeeper journals and replays
// the action itself, so nothing is re-run through the pipeline.
import type { CrmDb } from "@relationship-os/db";
import type { Compilable } from "kysely";
import { addDays, DEFAULT_APPROVAL_EXPIRY_DAYS, targetChangeSet } from "../approvals/queue.ts";
import type { PendingApproval } from "../errors.ts";
import { evaluateGate, type GateDecision, type GateFloor } from "../gate.ts";
import { findIds, findProvisionalIds, newId } from "../ids.ts";
import {
  holdsForReview,
  OUTBOUND_PLACEMENT,
  type OutboundCheck,
} from "../judge/questions/outbound-message.ts";
import type { Judge, JudgeCallUsage } from "../judge/types.ts";
import { judgeUsageStatement } from "../judge/usage.ts";
import { type ActingUser, type Actor, type Origin, originSchema } from "../principals.ts";
import { jsonList } from "../records/common.ts";
import { loadApprovalPolicy } from "../settings.ts";
import { checkOutbound, textFromAi } from "./outbound-check.ts";

/** The parts of a gatekeeper `ActionDescription` the CRM stores and shows. */
export interface OutboundDescription {
  title: string;
  /** Markdown. */
  description: string;
  fields?:
    | {
        label: string;
        /** inline, text and json fields. */
        value?: string;
        /** list fields (`To`, `Cc`): one value per row. */
        items?: string[];
        syntax?: string;
        truncated?: unknown;
      }[]
    | undefined;
  descriptionIsComplete?: boolean | undefined;
  implementsRevert?: boolean | undefined;
  awaitDecision?: boolean | undefined;
  autoApprovable?: boolean | undefined;
  actionKind?: { tag: string; label: string } | undefined;
}

export interface OutboundSubmission {
  connectionId: string;
  connectionTitle: string;
  vendor: string;
  facetKey: string;
  resourceTitle: string;
  action: number;
  description: OutboundDescription;
  actor: Actor;
  user: ActingUser;
  origin: Origin;
  reason?: string | undefined;
  floor?: GateFloor | undefined;
  expiryDays?: number | undefined;
  now?: string | undefined;
  /**
   * The judge, for `outbound.message` (ADR 0238): a message an AI actor wrote is checked before it
   * leaves. Absent or off: decided exactly as before.
   */
  judge?: Judge | undefined;
  /** The person's own words the message was written for, passed by code (never a model). */
  asked?: string | undefined;
}

export type OutboundDecision =
  /**
   * `judgeUsage`: the outbound.message call made for it, counted in the batch that audits it once
   * applied (`auditOutboundApplied`, ADR 0234).
   */
  | { decision: "auto"; judgeUsage?: JudgeCallUsage | undefined }
  | { decision: "review"; pending: PendingApproval }
  | { decision: "deny"; reason: string };

/** The operation name outbound items and their audit rows carry. */
export const OUTBOUND_OPERATION = "integration.outbound";

/** What an outbound pending action stores as its `input` (and shows in the approvals inbox). */
export interface OutboundInput {
  vendor: string;
  connectionId: string;
  connectionTitle: string;
  facetKey: string;
  resourceTitle: string;
  action: number;
  title: string;
  description: string;
  fields: { label: string; value: string; syntax?: string }[];
  actionKind: { tag: string; label: string } | null;
  autoApprovable: boolean;
  implementsRevert: boolean;
  descriptionIsComplete: boolean;
}

/** Bounds what a gatekeeper can make us store (a description is untrusted input). */
function cap(text: unknown, max: number): string {
  const s = typeof text === "string" ? text : String(text ?? "");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function outboundInput(s: OutboundSubmission): OutboundInput {
  const d = s.description;
  return {
    vendor: s.vendor,
    connectionId: s.connectionId,
    connectionTitle: cap(s.connectionTitle, 200),
    facetKey: s.facetKey,
    resourceTitle: cap(s.resourceTitle, 200),
    action: s.action,
    title: cap(d.title, 300),
    description: cap(d.description, 20_000),
    fields: (d.fields ?? []).slice(0, 50).map((f) => ({
      label: cap(f.label, 200),
      // A list field (`To`) keeps one value per line.
      value: cap(f.value ?? (Array.isArray(f.items) ? f.items.join("\n") : ""), 50_000),
      ...(f.syntax ? { syntax: cap(f.syntax, 20) } : {}),
    })),
    actionKind: d.actionKind
      ? { tag: cap(d.actionKind.tag, 100), label: cap(d.actionKind.label, 200) }
      : null,
    autoApprovable: d.autoApprovable === true,
    implementsRevert: d.implementsRevert === true,
    descriptionIsComplete: d.descriptionIsComplete === true,
  };
}

/** Records a kind the first time it is seen (and widens auto_approvable when the author did). */
function upsertKind(db: CrmDb, input: OutboundInput, now: string): Compilable | null {
  if (!input.actionKind) return null;
  return db.query
    .insertInto("core_outbound_kind")
    .values({
      tag: input.actionKind.tag,
      vendor: input.vendor,
      label: input.actionKind.label,
      auto_approvable: input.autoApprovable ? 1 : 0,
      auto_approve: 0,
      first_seen_at: now,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.column("tag").doUpdateSet((eb) => ({
        auto_approvable: eb.fn("max", [
          eb.ref("core_outbound_kind.auto_approvable"),
          eb.ref("excluded.auto_approvable"),
        ]),
      })),
    );
}

function auditRow(
  db: CrmDb,
  s: OutboundSubmission,
  input: OutboundInput,
  now: string,
  gate: GateDecision,
  outcome: "ok" | "review" | "denied" | "error",
  extra: { pendingActionId?: string; error?: { code: string; message: string } } = {},
): Compilable {
  return db.query.insertInto("core_audit").values({
    id: newId("audit"),
    at: now,
    operation: OUTBOUND_OPERATION,
    risk: "outbound",
    actor: s.actor,
    user_id: s.user.id,
    origin: JSON.stringify(originSchema.parse(s.origin)),
    // The description is what a person reviews; its field values may be long, so the audit row
    // keeps the title, kind and target only.
    input: JSON.stringify({
      vendor: input.vendor,
      connectionId: input.connectionId,
      facetKey: input.facetKey,
      action: input.action,
      actionKind: input.actionKind?.tag ?? null,
      title: input.title,
    }),
    result: null,
    gate_decision: gate,
    outcome,
    error: extra.error ? JSON.stringify(extra.error) : null,
    pending_action_id: extra.pendingActionId ?? null,
  });
}

/** Pending actions that create any of these provisional ids (the outbound item depends on them). */
async function creatorsOf(db: CrmDb, provisional: readonly string[], now: string) {
  if (!provisional.length) return [];
  const rows = await db.query
    .selectFrom("core_pending_action")
    .select(["id", "provisional"])
    .where("status", "=", "pending")
    .where("expires_at", ">", now)
    .execute();
  return rows.filter((r) => provisional.some((id) => r.provisional.includes(id))).map((r) => r.id);
}

/**
 * Decides one submitted gatekeeper action. `auto`: the host applies it now (and audits the
 * outcome with `auditOutboundApplied`). `review`: it is now a pending action in the caller's
 * change set. `deny`: the host rejects it on the facet.
 */
export async function submitOutbound(db: CrmDb, s: OutboundSubmission): Promise<OutboundDecision> {
  const now = s.now ?? new Date().toISOString();
  const input = outboundInput(s);
  const policy = await loadApprovalPolicy(db.query);
  const kind = input.actionKind
    ? await db.query
        .selectFrom("core_outbound_kind")
        .select(["auto_approve", "auto_approvable"])
        .where("tag", "=", input.actionKind.tag)
        .executeTakeFirst()
    : undefined;
  const gate = evaluateGate(
    {
      actor: s.actor,
      risk: "outbound",
      outbound: {
        autoApprovable: input.autoApprovable,
        enabled: kind?.auto_approve === 1 && kind.auto_approvable === 1,
      },
    },
    policy,
    s.floor,
  );
  const kindRow = upsertKind(db, input, now);
  // A description that mentions a record still pending creation can never apply before it.
  const provisional = findProvisionalIds([input.title, input.description, input.fields]);
  let decision = gate.decision;
  if (decision === "auto" && provisional.length) decision = "review";

  // outbound.message (ADR 0238): a message an AI actor wrote is read before it leaves. A finding,
  // or no answer, turns an automatic send into a review; Jev never lets one through.
  let check: OutboundCheck | null = null;
  let judgeUsage: JudgeCallUsage | undefined;
  if (decision !== "deny" && s.judge && textFromAi(s.actor, s.origin)) {
    const checked = await checkOutbound({
      judge: s.judge,
      db: db.query,
      outbound: input,
      asked: s.asked,
      now,
    });
    if (checked.status !== "off") {
      const hold = decision === "auto" && holdsForReview(checked);
      if (hold) decision = "review";
      check = { ...checked.check, turnedToReview: hold };
      judgeUsage = checked.usage;
    }
  }

  if (decision === "deny") {
    await db.batch([
      ...(kindRow ? [kindRow] : []),
      auditRow(db, s, input, now, "deny", "denied", {
        error: { code: "denied", message: "The approval policy does not allow this action" },
      }),
    ]);
    return { decision: "deny", reason: "The approval policy does not allow this action" };
  }
  if (decision === "auto") {
    if (kindRow) await db.batch([kindRow]);
    return { decision: "auto", ...(judgeUsage ? { judgeUsage } : {}) };
  }

  const dependsOn = await creatorsOf(db, provisional, now);
  const changeSet = await targetChangeSet({
    db,
    origin: s.origin,
    user: s.user,
    actor: s.actor,
    now,
  });
  const actionId = newId("pendingAction");
  const expiresAt = addDays(now, s.expiryDays ?? DEFAULT_APPROVAL_EXPIRY_DAYS);
  const referenced = findIds([input.title, input.description, input.fields]).slice(0, 40);
  const statements: Compilable[] = [
    ...(kindRow ? [kindRow] : []),
    ...changeSet.statements,
    db.query.insertInto("core_pending_action").values({
      id: actionId,
      change_set_id: changeSet.id,
      operation: OUTBOUND_OPERATION,
      risk: "outbound",
      input: JSON.stringify(input),
      reason: s.reason?.trim() || "No reason given",
      actor: s.actor,
      user_id: s.user.id,
      origin: JSON.stringify(s.origin),
      granted_permissions: null,
      bulk_size: 1,
      preview: "[]",
      simulated: JSON.stringify({ output: null, records: [] }),
      provisional: "[]",
      depends_on: JSON.stringify(dependsOn),
      status: "pending",
      created_at: now,
      expires_at: expiresAt,
      connection_id: s.connectionId,
      facet_key: s.facetKey,
      gk_action: s.action,
      action_kind: input.actionKind?.tag ?? null,
      outbound_check: check ? JSON.stringify(check) : null,
    }),
    auditRow(db, s, input, now, "review", "review", { pendingActionId: actionId }),
    // The judge's spend (ADR 0234), in the batch that writes the pending action.
    ...(judgeUsage ? [judgeUsageStatement(db.query, OUTBOUND_PLACEMENT, judgeUsage, now)] : []),
  ];
  // Record badges: the CRM records the action mentions.
  for (let i = 0; i < referenced.length; i += 20) {
    statements.push(
      db.query.insertInto("core_pending_action_records").values(
        referenced.slice(i, i + 20).map((id) => ({
          action_id: actionId,
          object_type: objectFromPrefix(id),
          record_id: id,
          action: "reference",
        })),
      ),
    );
  }
  await db.batch(statements);
  return {
    decision: "review",
    pending: {
      status: "pending_approval",
      changeSetId: changeSet.id,
      actionId,
      operation: OUTBOUND_OPERATION,
      provisionalIds: [],
      dependsOn,
      expiresAt,
      simulated: null,
      message:
        `Queued for approval, NOT done yet: "${input.title}" (${input.actionKind?.label ?? input.vendor}) ` +
        `is pending action ${actionId} in change set ${changeSet.id}. A person must approve it in ` +
        `the CRM's Approvals inbox. Until then the ${input.connectionTitle} connection simulates it ` +
        "for its users. Tell the user it is waiting for approval.",
    },
  };
}

const PREFIX_OBJECTS: Record<string, string> = {
  per: "person",
  org: "organisation",
  act: "activity",
  tsk: "task",
  rec: "record",
};

function objectFromPrefix(id: string): string {
  return PREFIX_OBJECTS[id.slice(0, id.indexOf("_"))] ?? "unknown";
}

/** Audits an auto-approved outbound action once the host has applied it (or failed to). */
export async function auditOutboundApplied(
  db: CrmDb,
  s: OutboundSubmission,
  outcome: { ok: true } | { ok: false; message: string },
  /** The outbound.message call `submitOutbound` made for it, counted here (ADR 0234). */
  judgeUsage?: JudgeCallUsage,
): Promise<void> {
  const now = s.now ?? new Date().toISOString();
  const input = outboundInput(s);
  await db.batch([
    ...(judgeUsage ? [judgeUsageStatement(db.query, OUTBOUND_PLACEMENT, judgeUsage, now)] : []),
    auditRow(
      db,
      s,
      input,
      now,
      "auto",
      outcome.ok ? "ok" : "error",
      outcome.ok ? {} : { error: { code: "outbound_failed", message: outcome.message } },
    ),
  ]);
}

/** Audits the application of an approved outbound item (gate `review`, linked to the action). */
export function outboundAppliedAudit(
  db: CrmDb,
  row: { id: string; actor: Actor; user_id: string; origin: string; input: string },
  now: string,
  outcome: { ok: true } | { ok: false; message: string },
): Compilable {
  let parsed: Partial<OutboundInput> = {};
  try {
    parsed = JSON.parse(row.input) as Partial<OutboundInput>;
  } catch {
    parsed = {};
  }
  return db.query.insertInto("core_audit").values({
    id: newId("audit"),
    at: now,
    operation: OUTBOUND_OPERATION,
    risk: "outbound",
    actor: row.actor,
    user_id: row.user_id,
    origin: row.origin,
    input: JSON.stringify({
      vendor: parsed.vendor ?? null,
      connectionId: parsed.connectionId ?? null,
      facetKey: parsed.facetKey ?? null,
      action: parsed.action ?? null,
      actionKind: parsed.actionKind?.tag ?? null,
      title: parsed.title ?? null,
    }),
    result: null,
    gate_decision: "review",
    outcome: outcome.ok ? "ok" : "error",
    error: outcome.ok
      ? null
      : JSON.stringify({ code: "outbound_failed", message: outcome.message }),
    pending_action_id: row.id,
  });
}

/** Outbound pending actions on one facet, still pending, queued before `action`. */
export async function earlierPendingOnFacet(
  db: CrmDb,
  item: { connectionId: string; facetKey: string; action: number },
  now: string,
): Promise<{ id: string; gk_action: number | null }[]> {
  return db.query
    .selectFrom("core_pending_action")
    .select(["id", "gk_action"])
    .where("connection_id", "=", item.connectionId)
    .where("facet_key", "=", item.facetKey)
    .where("gk_action", "<", item.action)
    .where("status", "=", "pending")
    .where("expires_at", ">", now)
    .execute();
}

/** Pending outbound items per connection (the "simulated" badge on org connections). */
export async function pendingOutboundCounts(
  db: CrmDb,
  connectionIds: readonly string[],
  now: string,
): Promise<Map<string, number>> {
  if (!connectionIds.length) return new Map();
  const rows = await db.query
    .selectFrom("core_pending_action")
    .select(["connection_id", (eb) => eb.fn.countAll<number>().as("n")])
    .where("connection_id", "in", jsonList([...connectionIds]))
    .where("status", "=", "pending")
    .where("expires_at", ">", now)
    .groupBy("connection_id")
    .execute();
  return new Map(rows.map((r) => [r.connection_id ?? "", Number(r.n)]));
}
