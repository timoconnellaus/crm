// Running the policy adjudicator (ADR 0031, ADR 0204): its settings and written policy, judging a
// pending action after the review path queued it (ros-app's post-queue hook, in the background)
// or in the cron's catch-up sweep, recording and auditing each verdict, and, in active mode,
// applying an approved action through the approval machinery as its original actor, attributed
// to the adjudicator.
//
// Cost (cost audit): nothing here runs on the actor's path. With the mode off a run is one
// primary-key settings read and no writes. The sweep's query walks core_pending_action's
// (status, expires_at) index and core_adjudication's unique action index, bounded by `limit`.
import type {
  AdjudicationMode,
  AdjudicationOutcome,
  CoreDatabase,
  CrmDb,
  ReviewSource,
} from "@relationship-os/db";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import type { ModelRunner } from "../ai/client.ts";
import { approvalDecidedMessages, eventOriginOf } from "../automations/events.ts";
import { emitDurably } from "../automations/outbox.ts";
import { toOperationError } from "../errors.ts";
import { resolveExtensionOperation } from "../extensions/tools.ts";
import { isProvisionalId, newId, replaceIds } from "../ids.ts";
import type { AnyOperation } from "../operation.ts";
import { type InvocationContext, invokeOperation } from "../pipeline.ts";
import { type ActingUser, type Origin, ROLES, type Role } from "../principals.ts";
import { jsonList } from "../records/common.ts";
import {
  ADJUDICATOR_PRINCIPAL,
  type AdjudicatorMode,
  decideAction,
  type JudgeResult,
  judgePendingItem,
  VERDICT_OPERATION,
} from "./judge.ts";

// --- Settings and the written policy ----------------------------------------------------------

/** core_settings key. Missing or unreadable means off. */
export const ADJUDICATOR_SETTING = "adjudicator";
/** The audit origin of the adjudicator's own rows. */
export const ADJUDICATOR_ORIGIN: Origin = { surface: "system", automationId: "policy.adjudicator" };
export const DEFAULT_THRESHOLD = 0.8;

export const adjudicatorSettingsSchema = z.object({
  mode: z.enum(["off", "shadow", "active"]),
  threshold: z.number().min(0.5).max(1),
  /** When it was last switched on from off: the sweep looks at actions queued since. */
  enabledAt: z.string().nullable().default(null),
});
export type AdjudicatorSettings = z.infer<typeof adjudicatorSettingsSchema>;

export const ADJUDICATOR_OFF: AdjudicatorSettings = {
  mode: "off",
  threshold: DEFAULT_THRESHOLD,
  enabledAt: null,
};

export async function loadAdjudicatorSettings(
  db: Kysely<CoreDatabase>,
): Promise<AdjudicatorSettings> {
  const row = await db
    .selectFrom("core_settings")
    .select("value")
    .where("key", "=", ADJUDICATOR_SETTING)
    .executeTakeFirst();
  if (!row) return ADJUDICATOR_OFF;
  try {
    const parsed = adjudicatorSettingsSchema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : ADJUDICATOR_OFF;
  } catch {
    return ADJUDICATOR_OFF;
  }
}

export interface WrittenPolicy {
  version: number;
  text: string;
  hash: string;
  createdAt: string;
  createdBy: string;
}

/** The written policy in force (the newest version), or null when none was written. */
export async function loadWrittenPolicy(db: Kysely<CoreDatabase>): Promise<WrittenPolicy | null> {
  const row = await db
    .selectFrom("core_written_policy")
    .selectAll()
    .orderBy("version", "desc")
    .limit(1)
    .executeTakeFirst();
  return row
    ? {
        version: row.version,
        text: row.text,
        hash: row.hash,
        createdAt: row.created_at,
        createdBy: row.created_by,
      }
    : null;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- Verdicts as approvers see them -----------------------------------------------------------

export const verdictViewSchema = z.object({
  id: z.string(),
  judgedAt: z.string(),
  mode: z.enum(["shadow", "active"]),
  verdict: z.enum(["approve", "deny", "escalate"]),
  confidence: z.number(),
  reason: z.string(),
  outcome: z.enum(["recorded", "approved", "apply_failed", "escalated"]),
  acted: z.boolean(),
  note: z.string().nullable(),
  model: z.string().nullable(),
  policyVersion: z.number().nullable(),
  threshold: z.number(),
});
export type VerdictView = z.infer<typeof verdictViewSchema>;

/** Verdicts for these actions (human approvers only: the caller checks). */
export async function loadVerdicts(
  db: Kysely<CoreDatabase>,
  actionIds: readonly string[],
): Promise<Map<string, VerdictView>> {
  if (!actionIds.length) return new Map();
  const rows = await db
    .selectFrom("core_adjudication")
    .selectAll()
    .where("action_id", "in", jsonList([...actionIds]))
    .execute();
  return new Map(
    rows.map((r) => [
      r.action_id,
      {
        id: r.id,
        judgedAt: r.judged_at,
        mode: r.mode,
        verdict: r.verdict,
        confidence: r.confidence,
        reason: r.reason,
        outcome: r.outcome,
        acted: r.acted === 1,
        note: r.note,
        model: r.model,
        policyVersion: r.policy_version,
        threshold: r.threshold,
      },
    ]),
  );
}

// --- Judging one pending action ---------------------------------------------------------------

/** What running the adjudicator needs: the invocation context minus the caller. */
export type AdjudicatorDeps = Omit<
  InvocationContext,
  | "actor"
  | "user"
  | "origin"
  | "approval"
  | "reason"
  | "grantedPermissions"
  | "extension"
  | "simulate"
  | "onQueued"
>;

export type AdjudicationResult =
  | { status: "skipped"; why: "off" | "no_ai" | "no_policy" | "not_pending" | "judged" | "raced" }
  | {
      status: "judged";
      verdict: JudgeResult["verdict"];
      confidence: number;
      outcome: AdjudicationOutcome;
      note: string | null;
    };

async function loadActingUser(db: Kysely<CoreDatabase>, id: string): Promise<ActingUser | null> {
  const row = await db
    .selectFrom("core_user")
    .select(["id", "email", "name", "role"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) return null;
  const role = (ROLES as readonly string[]).includes(row.role) ? (row.role as Role) : "viewer";
  return { id: row.id, email: row.email, name: row.name, role };
}

function parse<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

async function resolve(deps: AdjudicatorDeps, name: string): Promise<AnyOperation | undefined> {
  return deps.resolveOperation?.(name) ?? (await resolveExtensionOperation(deps.db.query, name));
}

/**
 * Judges one pending action, records and audits the verdict, and in active mode applies an
 * approved one. Never throws (a failure is logged). Idempotent: an action gets one verdict.
 */
export async function adjudicatePendingAction(
  deps: AdjudicatorDeps,
  actionId: string,
): Promise<AdjudicationResult> {
  try {
    return await adjudicate(deps, actionId, await loadAdjudicatorSettings(deps.db.query));
  } catch (error) {
    console.error("policy adjudicator failed", actionId, error);
    return { status: "skipped", why: "raced" };
  }
}

async function adjudicate(
  deps: AdjudicatorDeps,
  actionId: string,
  settings: AdjudicatorSettings,
): Promise<AdjudicationResult> {
  if (settings.mode === "off") return { status: "skipped", why: "off" };
  const models: ModelRunner | undefined = deps.models;
  if (!models) return { status: "skipped", why: "no_ai" };
  const db = deps.db.query;
  const policy = await loadWrittenPolicy(db);
  if (!policy) return { status: "skipped", why: "no_policy" };
  const nowAt = () => (deps.clock?.() ?? new Date()).toISOString();
  const row = await db
    .selectFrom("core_pending_action as p")
    .leftJoin("core_change_set as c", "c.id", "p.change_set_id")
    .leftJoin("core_adjudication as a", "a.action_id", "p.id")
    .select([
      "p.id",
      "p.change_set_id",
      "p.operation",
      "p.risk",
      "p.input",
      "p.reason",
      "p.actor",
      "p.user_id",
      "p.origin",
      "p.granted_permissions",
      "p.bulk_size",
      "p.preview",
      "p.provisional",
      "p.depends_on",
      "p.status",
      "p.expires_at",
      "p.review_source",
      "c.client_name",
      "a.id as verdict_id",
    ])
    .where("p.id", "=", actionId)
    .executeTakeFirst();
  if (row?.status !== "pending" || row.expires_at <= nowAt()) {
    return { status: "skipped", why: "not_pending" };
  }
  if (row.verdict_id) return { status: "skipped", why: "judged" };

  const op = await resolve(deps, row.operation);
  const dependsOn = parse<string[]>(row.depends_on, []);
  const judged = await judgePendingItem(
    (messages, options) => models.run("review", messages, options),
    policy.text,
    {
      operation: row.operation,
      operationDescription: op?.description,
      risk: row.risk,
      actor: row.actor,
      clientName: row.client_name,
      bulkSize: row.bulk_size,
      reason: row.reason,
      preview: parse(row.preview, []),
      input: parse(row.input, {}),
      dependsOn: dependsOn.length,
    },
  );

  // Every dependency must already be applied for the approval machinery to apply this one.
  let dependenciesApplied = true;
  if (dependsOn.length) {
    const deps2 = await db
      .selectFrom("core_pending_action")
      .select(["id", "status"])
      .where("id", "in", jsonList(dependsOn))
      .execute();
    dependenciesApplied =
      deps2.length === dependsOn.length && deps2.every((d) => d.status === "applied");
  }
  const decision = decideAction({
    verdict: judged.verdict,
    confidence: judged.confidence,
    valid: judged.valid,
    error: judged.error,
    threshold: settings.threshold,
    reviewSource: row.review_source as ReviewSource | null,
    risk: row.risk,
    dependenciesApplied,
  });
  const mode: AdjudicationMode = settings.mode;
  const act = mode === "active" && decision.approve;
  const outcome: AdjudicationOutcome =
    mode === "shadow" ? "recorded" : act ? "approved" : "escalated";
  const now = nowAt();
  const verdictId = newId("adjudication");
  const auditId = newId("audit");

  // The verdict claims the action (unique action_id), and its audit row commits only with it.
  await deps.db.batch([
    deps.db.query
      .insertInto("core_adjudication")
      .values({
        id: verdictId,
        action_id: row.id,
        judged_at: now,
        mode,
        verdict: judged.verdict,
        confidence: judged.confidence,
        reason: judged.reason,
        outcome,
        acted: act ? 1 : 0,
        note: decision.note,
        provider: judged.provider ?? null,
        model: judged.model ?? null,
        policy_version: policy.version,
        policy_hash: policy.hash,
        threshold: settings.threshold,
        error: judged.error ? JSON.stringify(judged.error) : null,
        audit_id: auditId,
      })
      .onConflict((oc) => oc.column("action_id").doNothing()),
    deps.db.query
      .insertInto("core_audit")
      .columns([
        "id",
        "at",
        "operation",
        "risk",
        "actor",
        "user_id",
        "origin",
        "input",
        "result",
        "gate_decision",
        "outcome",
        "error",
        "pending_action_id",
      ])
      .expression(
        deps.db.query
          .selectFrom("core_adjudication")
          .select([
            sql<string>`${auditId}`.as("id"),
            sql<string>`${now}`.as("at"),
            sql<string>`${VERDICT_OPERATION}`.as("operation"),
            sql<string>`${row.risk}`.as("risk"),
            sql<string>`'automation'`.as("actor"),
            sql<null>`NULL`.as("user_id"),
            sql<string>`${JSON.stringify(ADJUDICATOR_ORIGIN)}`.as("origin"),
            sql<string>`${JSON.stringify({
              actionId: row.id,
              operation: row.operation,
              mode,
              policyVersion: policy.version,
              policyHash: policy.hash,
              provider: judged.provider ?? null,
              model: judged.model ?? null,
              threshold: settings.threshold,
            })}`.as("input"),
            sql<string>`${JSON.stringify({
              verdict: judged.verdict,
              confidence: judged.confidence,
              reason: judged.reason,
              outcome,
              acted: act,
              note: decision.note,
            })}`.as("result"),
            sql<string>`'review'`.as("gate_decision"),
            sql<string>`'ok'`.as("outcome"),
            sql<string | null>`${judged.error ? JSON.stringify(judged.error) : null}`.as("error"),
            sql<string>`${row.id}`.as("pending_action_id"),
          ])
          .where("id", "=", verdictId),
      ),
  ]);
  const claimed = await db
    .selectFrom("core_adjudication")
    .select("id")
    .where("action_id", "=", row.id)
    .executeTakeFirst();
  if (claimed?.id !== verdictId) return { status: "skipped", why: "raced" };

  const result = {
    status: "judged" as const,
    verdict: judged.verdict,
    confidence: judged.confidence,
    note: decision.note,
  };
  if (!act) return { ...result, outcome };
  const applied = await applyApproved(deps, row, now);
  if (applied.ok) return { ...result, outcome: "approved" };
  await deps.db.batch([
    deps.db.query
      .updateTable("core_adjudication")
      .set({ outcome: "apply_failed" })
      .where("id", "=", verdictId),
  ]);
  return { ...result, outcome: "apply_failed" };
}

/**
 * Applies an approved action as the approval machinery does (approval.approve): re-run through the
 * pipeline as its original actor, with provisional ids bound to the real ids of applied
 * dependencies, failing cleanly when its record changed. `decided_by` is the adjudicator.
 */
async function applyApproved(
  deps: AdjudicatorDeps,
  row: {
    id: string;
    change_set_id: string;
    operation: string;
    input: string;
    actor: InvocationContext["actor"];
    user_id: string;
    origin: string;
    granted_permissions: string | null;
    preview: string;
    provisional: string;
    depends_on: string;
  },
  now: string,
): Promise<{ ok: boolean }> {
  const db = deps.db.query;
  const bindings = new Map<string, string>();
  const dependsOn = parse<string[]>(row.depends_on, []);
  if (dependsOn.length) {
    const applied = await db
      .selectFrom("core_pending_action")
      .select(["bindings"])
      .where("id", "in", jsonList(dependsOn))
      .execute();
    for (const dep of applied) {
      for (const [p, r] of Object.entries(parse<Record<string, string>>(dep.bindings, {}))) {
        bindings.set(p, r);
      }
    }
  }
  let ok = true;
  let own: Record<string, string> = {};
  try {
    const op = await resolve(deps, row.operation);
    if (!op) throw new Error(`Unknown operation ${row.operation}`);
    const user = await loadActingUser(db, row.user_id);
    if (!user) throw new Error(`The user ${row.user_id} no longer exists`);
    await invokeOperation(op, replaceIds(parse(row.input, {}), bindings), {
      ...deps,
      actor: row.actor,
      user,
      origin: parse<Origin>(row.origin, { surface: "mcp" }),
      grantedPermissions: parse(row.granted_permissions, null) as never,
      approval: {
        actionId: row.id,
        approvedBy: ADJUDICATOR_PRINCIPAL,
        provisional: parse(row.provisional, []),
        preview: replaceIds(parse(row.preview, []), bindings),
      },
    });
    const after = await db
      .selectFrom("core_pending_action")
      .select(["bindings"])
      .where("id", "=", row.id)
      .executeTakeFirst();
    own = parse<Record<string, string>>(after?.bindings ?? null, {});
  } catch (error) {
    ok = false;
    const typed = toOperationError(error);
    await deps.db.batch([
      deps.db.query
        .updateTable("core_pending_action")
        .set({
          status: "failed",
          status_reason: `Failed: ${typed.message}`,
          error: JSON.stringify(typed.toJSON()),
          decided_by: ADJUDICATOR_PRINCIPAL,
          decided_at: now,
        })
        .where("id", "=", row.id)
        .where("status", "=", "pending"),
    ]);
  }
  // Automations waiting on the decision (ADR 0130) hear about it as from a person's.
  if (deps.events) {
    const records = parse<{ object: string; id: string }[]>(row.preview, [])
      .map((p) => ({ object: p.object, id: own[p.id] ?? p.id }))
      .filter((r) => !isProvisionalId(r.id));
    const origin = eventOriginOf({
      actor: "automation",
      userId: "system",
      origin: ADJUDICATOR_ORIGIN,
      operation: VERDICT_OPERATION,
      auditId: newId("audit"),
      bulk: false,
    });
    await emitDurably(
      deps.db,
      deps.events,
      approvalDecidedMessages(now, origin, [
        {
          actionId: row.id,
          changeSetId: row.change_set_id,
          operation: row.operation,
          decision: ok ? "approved" : "failed",
          decidedBy: null,
          records,
          actionOrigin: parse<Origin>(row.origin, { surface: "system" }),
        },
      ]),
      now,
    );
  }
  return { ok };
}

// --- The catch-up sweep -----------------------------------------------------------------------

/** Actions younger than this are left to the post-queue run. */
export const SWEEP_GRACE_MS = 2 * 60_000;

/**
 * Judges pending actions the post-queue run missed (it timed out, the isolate died, or they were
 * queued by ros-runner, which has no hook): queued since the adjudicator was switched on, older
 * than the grace period, still pending and without a verdict. Oldest first, at most `limit`.
 */
export async function runAdjudicatorSweep(
  deps: AdjudicatorDeps,
  options: { limit?: number } = {},
): Promise<{ judged: number; mode: AdjudicatorMode }> {
  const settings = await loadAdjudicatorSettings(deps.db.query);
  if (settings.mode === "off" || !deps.models) return { judged: 0, mode: settings.mode };
  const now = deps.clock?.() ?? new Date();
  const ids = await sweepCandidates(deps.db, settings, now, options.limit ?? 10);
  let judged = 0;
  for (const id of ids) {
    const result = await adjudicate(deps, id, settings).catch((error: unknown) => {
      console.error("policy adjudicator sweep failed", id, error);
      return null;
    });
    if (result?.status === "judged") judged += 1;
  }
  return { judged, mode: settings.mode };
}

export async function sweepCandidates(
  db: CrmDb,
  settings: AdjudicatorSettings,
  now: Date,
  limit: number,
): Promise<string[]> {
  const before = new Date(now.getTime() - SWEEP_GRACE_MS).toISOString();
  const rows = await db.query
    .selectFrom("core_pending_action as p")
    .select("p.id")
    .where("p.status", "=", "pending")
    .where("p.expires_at", ">", now.toISOString())
    .where("p.created_at", "<=", before)
    .$if(Boolean(settings.enabledAt), (q) =>
      q.where("p.created_at", ">=", settings.enabledAt ?? ""),
    )
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("core_adjudication as a")
            .select("a.id")
            .whereRef("a.action_id", "=", "p.id"),
        ),
      ),
    )
    .orderBy("p.id")
    .limit(limit)
    .execute();
  return rows.map((r) => r.id);
}

// --- Agreement --------------------------------------------------------------------------------

/** Verdicts judged in [from, to) with what a person decided afterwards. Bounded by `limit`. */
export async function loadAgreementRows(
  db: Kysely<CoreDatabase>,
  from: string,
  to: string,
  limit = 5000,
) {
  const rows = await db
    .selectFrom("core_adjudication as a")
    .innerJoin("core_pending_action as p", "p.id", "a.action_id")
    .select(["a.judged_at", "a.verdict", "a.acted", "p.status", "p.decided_by"])
    .where("a.judged_at", ">=", from)
    .where("a.judged_at", "<", to)
    .orderBy("a.judged_at")
    .limit(limit)
    .execute();
  return rows.map((r) => ({
    judgedAt: r.judged_at,
    verdict: r.verdict,
    acted: r.acted === 1,
    human: humanDecision(r.status, r.decided_by),
  }));
}

/** What a person decided on an action: approved (applied or failed on apply) or rejected. */
export function humanDecision(
  status: string,
  decidedBy: string | null,
): "approved" | "rejected" | null {
  if (!decidedBy || decidedBy === ADJUDICATOR_PRINCIPAL) return null;
  if (status === "applied" || status === "failed") return "approved";
  if (status === "rejected") return "rejected";
  return null;
}
