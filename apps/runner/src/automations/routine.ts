// A routine's run (ADR 0343). A routine has no extension code, so its Workflow does two things:
//
//   checks ─► plain gates, then Jev gates, before any model call
//   deliver ─► one message on ROUTINE_DELIVERY for ros-app, which owns the person's thread
//
// ros-runner cannot reach the AssistantAgent directly: ros-app already binds to ros-runner, and a
// binding back would make the first deploy of either Worker fail. A queue has no such order, and
// retries a delivery that fails. The message holds ids only: nothing about a person sits in the
// queue. The checks stay in the run's `report`, where the why panel and an erase find them.
import {
  errorForLog,
  judgeUsageStatement,
  loadTriggerRecord,
  parseDefinition,
  ROUTINE_EXTENSION,
  type RoutineDeliveryMessage,
  type RoutineRunReport,
  runRoutineChecks,
} from "@relationship-os/core";
import { createCrmDb } from "@relationship-os/db";
import { runnerJudge } from "../extensions/ai.ts";
import type { AutomationRunParams } from "./dispatch.ts";
import { PermanentStepError, type RunEnv } from "./run.ts";

export interface RoutineRunEnv extends RunEnv {
  ROUTINE_DELIVERY?: Queue<RoutineDeliveryMessage>;
}

export const isRoutineRun = (params: AutomationRunParams) =>
  params.extensionId === ROUTINE_EXTENSION;

export interface RoutineChecked {
  deliver: boolean;
  /** Why it stopped, for run history. */
  reason?: string;
}

/** Step `checks`: is it still wanted, and do its gates pass? Stores what it found on the run. */
export async function checkRoutineRun(
  env: RoutineRunEnv,
  params: AutomationRunParams,
  judge = runnerJudge(env),
): Promise<RoutineChecked> {
  const crm = createCrmDb(env.DB);
  const row = await crm.query
    .selectFrom("core_routine as r")
    .innerJoin("core_user as u", "u.id", "r.owner_user_id")
    .select(["r.definition", "r.owner_user_id", "r.paused_until", "u.deactivated_at"])
    .where("r.automation_id", "=", params.automationId)
    .executeTakeFirst();
  if (!row) return { deliver: false, reason: "It no longer exists" };
  if (row.deactivated_at) return { deliver: false, reason: "Its owner's account is deactivated" };
  const now = new Date().toISOString();
  if (row.paused_until && row.paused_until > now) return { deliver: false, reason: "Snoozed" };
  const definition = parseDefinition(row.definition);
  if (!definition) throw new PermanentStepError("bad_definition", "It cannot be read any more");
  const record = params.record
    ? await loadTriggerRecord(crm.query, params.record.object, params.record.id)
    : null;
  const result = await runRoutineChecks({
    db: crm.query,
    judge,
    ownerId: row.owner_user_id,
    definition,
    record,
    now,
  });
  const report: RoutineRunReport = {
    routine: { checks: result.checks, ...(result.reason ? { reason: result.reason } : {}) },
  };
  await crm.batch([
    crm.query
      .updateTable("core_automation_runs")
      .set({ report: JSON.stringify(report), updated_at: now })
      .where("id", "=", params.runId),
    ...(result.judge.calls
      ? [judgeUsageStatement(crm.query, "routine.gate", result.judge, now)]
      : []),
  ]);
  return { deliver: result.pass, ...(result.reason ? { reason: result.reason } : {}) };
}

/** Step `deliver`: hands the message to ros-app. A repeat is harmless: delivery is per run. */
export async function queueRoutineDelivery(
  env: RoutineRunEnv,
  params: AutomationRunParams,
): Promise<void> {
  if (!env.ROUTINE_DELIVERY) {
    throw new PermanentStepError("no_delivery", "This deployment has no delivery queue");
  }
  const row = await createCrmDb(env.DB)
    .query.selectFrom("core_routine")
    .select(["id", "owner_user_id"])
    .where("automation_id", "=", params.automationId)
    .executeTakeFirst();
  if (!row) return;
  try {
    await env.ROUTINE_DELIVERY.send({
      v: 1,
      routineId: row.id,
      runId: params.runId,
      userId: row.owner_user_id,
    });
  } catch (error) {
    console.error("routine delivery could not be queued", errorForLog(error));
    throw error;
  }
}
