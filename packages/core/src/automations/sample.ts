// Test mode's sample approval decision (ADR 0133 amendment): an `approvalDecided` automation has
// no record to test against, and code written for it usually returns early when
// `event.approval` is missing, so test mode would show nothing. It is given a decision instead,
// built from a recent real pending action that the trigger would match when there is one, or made
// up when there is none, and the report says it is a sample.
import type { CoreDatabase } from "@relationship-os/db";
import type { AutomationEvent, AutomationManifest } from "@relationship-os/sdk";
import type { Kysely } from "kysely";

type ApprovalTrigger = Extract<AutomationManifest["trigger"], { type: "approvalDecided" }>;
type Approval = NonNullable<AutomationEvent["approval"]>;

export interface SampleApproval {
  approval: Approval;
  /** `recent`: from a real pending action (`approval.actionId`); `synthetic`: made up. */
  source: "recent" | "synthetic";
  /** One line for the report, saying it is a sample. */
  label: string;
}

/** The id a made-up decision carries; no pending action has it. */
export const SAMPLE_ACTION_ID = "pac_sample";

/** How many recent pending actions are looked at for one that fits (newest first, by id). */
const RECENT_LIMIT = 50;
const RECORDS_LIMIT = 100;

const CORE_UPDATES: Record<string, string> = {
  person: "person.update",
  organisation: "organisation.update",
  task: "task.update",
};

/**
 * A realistic decision for test mode. Prefers the newest pending action that touches records,
 * matches the trigger's operation and object (and the chosen record, if any), and was decided the
 * way the trigger wants; then any such action, whatever its status. Without one, a made-up
 * decision about the chosen record.
 */
export async function sampleApproval(
  db: Kysely<CoreDatabase>,
  trigger: ApprovalTrigger,
  record?: { object: string; id: string } | null,
): Promise<SampleApproval> {
  const wanted = trigger.decision === "approved" || trigger.decision === "rejected"
    ? trigger.decision
    : null;
  let query = db
    .selectFrom("core_pending_action as p")
    .select(["p.id", "p.operation", "p.status", "p.created_at"])
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("core_pending_action_records as r")
          .select("r.action_id")
          .whereRef("r.action_id", "=", "p.id")
          .$if(Boolean(trigger.object), (q) => q.where("r.object_type", "=", trigger.object ?? ""))
          .$if(Boolean(record), (q) =>
            q
              .where("r.object_type", "=", record?.object ?? "")
              .where("r.record_id", "=", record?.id ?? ""),
          ),
      ),
    );
  if (trigger.operation) query = query.where("p.operation", "=", trigger.operation);
  const recent = await query.orderBy("p.id", "desc").limit(RECENT_LIMIT).execute();
  const decided = (status: string) =>
    status === "rejected" ? "rejected" : status === "applied" ? "approved" : null;
  const action =
    (wanted ? recent.find((a) => decided(a.status) === wanted) : recent.find((a) => decided(a.status))) ??
    recent[0];

  if (action) {
    const records = await db
      .selectFrom("core_pending_action_records")
      .select(["object_type as object", "record_id as id"])
      .where("action_id", "=", action.id)
      .limit(RECORDS_LIMIT)
      .execute();
    const decision = wanted ?? decided(action.status) ?? "approved";
    const how = decided(action.status) === decision ? "" : ` (it is ${action.status}; shown as ${decision})`;
    return {
      approval: { actionId: action.id, operation: action.operation, decision, records },
      source: "recent",
      label:
        `Sample decision: ${action.operation} ${decision}, from the recent pending action ` +
        `${action.id}${how}. A real run gets the decision that triggered it.`,
    };
  }

  const decision = wanted ?? "approved";
  const object = record?.object ?? trigger.object ?? null;
  const operation =
    trigger.operation ?? (object ? (CORE_UPDATES[object] ?? "record.update") : "record.update");
  return {
    approval: {
      actionId: SAMPLE_ACTION_ID,
      operation,
      decision,
      records: record ? [{ object: record.object, id: record.id }] : [],
    },
    source: "synthetic",
    label:
      `Sample decision: ${operation} ${decision}, made up because no pending action matches ` +
      `this trigger (action id ${SAMPLE_ACTION_ID}). A real run gets the decision that ` +
      "triggered it.",
  };
}
