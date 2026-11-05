// The host side of one automation run (ADR 0130): what each Workflow step does. Every function
// here runs inside a Workflow `step.do`, so it runs once per step (retried on failure) and its
// result is journaled by Workflows. Run bookkeeping (core_automation_runs, run records,
// counters) is trusted host code writing directly, like core_extension_runs.
import {
  type AutomationDefinition,
  coreRegistry,
  loadAutomationSettings,
  loadTriggerRecord,
  notifyStatements,
  parseSpec,
  queueEventSink,
  type RunOperationRecord,
  type RunStatus,
  type RunStepRecord,
  TERMINAL_RUN_STATUSES,
} from "@relationship-os/core";
import { createCrmDb } from "@relationship-os/db";
import type {
  AutomationAdvance,
  AutomationEvent,
  AutomationJournalEntry,
  AutomationManifest,
} from "@relationship-os/sdk";
import { sql } from "kysely";
import { type Executor, PERMANENT_AUTOMATION_ERRORS } from "../executor/executor.ts";
import type { RunLog, RunOperation } from "../executor/host.ts";
import type { AutomationRunParams } from "./dispatch.ts";

/** Journaled step values above this are not kept for a retry (the retry re-runs from the start). */
const JOURNAL_VALUE_MAX = 64_000;

export interface RunEnv {
  DB: D1Database;
  AUTOMATION_EVENTS?: Queue;
}

/** A step failure retrying cannot fix. The Workflow treats it as non-retryable. */
export class PermanentStepError extends Error {
  override name = "PermanentStepError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type StartOutcome = { stopped: string } | { event: AutomationEvent };

async function runStatus(env: RunEnv, runId: string): Promise<RunStatus | null> {
  const row = await createCrmDb(env.DB)
    .query.selectFrom("core_automation_runs")
    .select("status")
    .where("id", "=", runId)
    .executeTakeFirst();
  return (row?.status as RunStatus | undefined) ?? null;
}

/** Why the run must stop before its next step (kill switch, cancelled), or null. */
async function stopReason(env: RunEnv, runId: string): Promise<string | null> {
  const db = createCrmDb(env.DB).query;
  const settings = await loadAutomationSettings(db);
  if (settings.killSwitch) {
    await finishRun(env, runId, "cancelled", { reason: "Stopped by the kill switch" });
    return "kill switch";
  }
  const status = await runStatus(env, runId);
  if (status && TERMINAL_RUN_STATUSES.includes(status)) return status;
  return null;
}

/** Step `start`: reads the trigger record and marks the run running. */
export async function startRun(env: RunEnv, params: AutomationRunParams): Promise<StartOutcome> {
  const stopped = await stopReason(env, params.runId);
  if (stopped) return { stopped };
  const crm = createCrmDb(env.DB);
  const now = new Date().toISOString();
  const record = params.record
    ? await loadTriggerRecord(crm.query, params.record.object, params.record.id)
    : null;
  const event: AutomationEvent = {
    automation: params.automationId,
    runId: params.runId,
    trigger: params.trigger,
    ...(params.record
      ? {
          record: {
            object: params.record.object,
            id: params.record.id,
            data: record?.data ?? null,
            // The SDK reads it for `{record}` in notification titles.
            ...({ title: record?.title ?? null } as object),
          },
        }
      : {}),
    ...(params.change ? { change: params.change } : {}),
    ...(params.period ? { period: params.period } : {}),
    ...(params.manual ? { manual: params.manual } : {}),
    ...(params.approval ? { approval: params.approval } : {}),
    test: false,
  };
  await crm.batch([
    crm.query
      .updateTable("core_automation_runs")
      .set({ status: "running", wait_until: null, updated_at: now })
      .where("id", "=", params.runId)
      .where("status", "in", ["queued", "running", "waiting"]),
    ...(params.record
      ? [
          crm.query
            .insertInto("core_automation_run_records")
            .values({
              object_type: params.record.object,
              record_id: params.record.id,
              run_id: params.runId,
              role: "trigger",
              at: now,
            })
            .onConflict((oc) => oc.doNothing()),
        ]
      : []),
  ]);
  return { event };
}

export async function loadRunSpec(
  env: RunEnv,
  automationId: string,
): Promise<AutomationManifest | null> {
  const row = await createCrmDb(env.DB)
    .query.selectFrom("core_automations")
    .select("spec")
    .where("id", "=", automationId)
    .executeTakeFirst();
  return row ? parseSpec(row.spec) : null;
}

const isWrite = (operation: string) =>
  operation.startsWith("x.") || (coreRegistry.get(operation)?.risk ?? "read") !== "read";

/** The operations of a step as run history keeps them, undeclared writes flagged. */
export function stepOperations(
  operations: readonly RunOperation[],
  spec: AutomationManifest | null,
  stepName: string | null,
): RunOperationRecord[] {
  const declared = spec?.steps.find((s) => s.name === stepName);
  const writes = new Set(
    declared && (declared.kind ?? "do") === "do"
      ? ((declared as { writes?: { object: string }[] }).writes ?? []).map((w) => w.object)
      : [],
  );
  return operations.map((op) => {
    const write = isWrite(op.operation) && op.operation !== "notification.send";
    const undeclared = write && Boolean(spec) && !writes.has(op.object ?? "");
    return {
      operation: op.operation,
      ok: op.ok,
      ...(op.code ? { code: op.code } : {}),
      ...(op.pendingActionId ? { pendingActionId: op.pendingActionId, gate: "review" } : {}),
      ...(op.recordId && op.object
        ? {
            records: [
              {
                object: op.object,
                id: op.recordId,
                action: op.operation.endsWith(".create") ? "create" : "update",
              },
            ],
          }
        : {}),
      ...(undeclared ? { undeclared: true } : {}),
      ms: op.ms,
    };
  });
}

function capLogs(logs: readonly RunLog[]) {
  return logs.slice(0, 50).map((l) => ({ level: l.level, message: l.message, at: l.at }));
}

export interface AdvanceOutcome {
  stopped?: string;
  advance?: AutomationAdvance;
  /** Review pause: the actions this step queued, and how long to wait for each. */
  pending: { actionId: string; changeSetId: string; timeoutMs: number; expiresAt: string }[];
}

/** Step `advance:<n>`: runs the next step of the automation in its Dynamic Worker. */
export async function advanceRun(
  env: RunEnv,
  executor: Executor,
  params: AutomationRunParams,
  event: AutomationEvent,
  journal: readonly AutomationJournalEntry[],
): Promise<AdvanceOutcome> {
  const stopped = await stopReason(env, params.runId);
  if (stopped) return { stopped, pending: [] };
  if (!params.commit) throw new PermanentStepError("disabled", "The automation has no commit");
  const startedAt = new Date().toISOString();
  const exec = await executor.runAutomation({
    extensionId: params.extensionId,
    commit: params.commit,
    request: {
      automation: params.key,
      event,
      journal: [...journal],
      mode: "advance",
      version: "",
    },
    automation: {
      automationId: params.automationId,
      runId: params.runId,
      depth: params.depth,
      chain: params.chain,
      rootEventId: params.rootEventId,
      ...(env.AUTOMATION_EVENTS ? { events: queueEventSink(env.AUTOMATION_EVENTS) } : {}),
    },
  });
  if (!exec.response.ok) {
    const { code, message } = exec.response.error;
    if (PERMANENT_AUTOMATION_ERRORS.has(code)) throw new PermanentStepError(code, message);
    throw new Error(`${code}: ${message}`);
  }
  const advance = exec.response.value as AutomationAdvance;
  const now = new Date();
  const pending = exec.operations
    .filter((op) => op.pending)
    .map((op) => {
      const p = op.pending as NonNullable<RunOperation["pending"]>;
      return {
        actionId: p.actionId,
        changeSetId: p.changeSetId,
        expiresAt: p.expiresAt,
        timeoutMs: Math.max(1_000, Date.parse(p.expiresAt) - now.getTime()),
      };
    });
  const spec = await loadRunSpec(env, params.automationId);
  const stepName = advance.kind === "do" ? advance.name : null;
  const writes = exec.operations
    .filter((op) => op.ok && !op.pending && isWrite(op.operation))
    .reduce((n, op) => n + (op.writes ?? 1), 0);
  const crm = createCrmDb(env.DB);
  const statements = [];
  if (advance.kind === "do") {
    const value = JSON.stringify(advance.value ?? null);
    const record: RunStepRecord & { value?: unknown } = {
      name: advance.name,
      kind: "do",
      status: pending.length ? "review" : "completed",
      startedAt,
      ms: exec.ms,
      operations: stepOperations(exec.operations, spec, stepName),
      logs: capLogs(exec.logs),
      ...(pending.length ? { pendingActionIds: pending.map((p) => p.actionId) } : {}),
      // Kept so a retry can replay completed steps without running them again.
      ...(value.length <= JOURNAL_VALUE_MAX ? { value: advance.value ?? null } : {}),
    };
    statements.push(appendStep(crm.query, params.runId, record, writes, now.toISOString()));
  } else if (writes) {
    statements.push(
      crm.query
        .updateTable("core_automation_runs")
        .set((eb) => ({ writes: eb("writes", "+", writes), updated_at: now.toISOString() }))
        .where("id", "=", params.runId),
    );
  }
  const touched = exec.operations.filter((op) => op.ok && op.recordId && op.object);
  for (const op of touched) {
    statements.push(
      crm.query
        .insertInto("core_automation_run_records")
        .values({
          object_type: op.object as string,
          record_id: op.recordId as string,
          run_id: params.runId,
          role: op.operation.endsWith(".create") ? "create" : "update",
          at: now.toISOString(),
        })
        .onConflict((oc) => oc.doNothing()),
    );
  }
  if (statements.length) await crm.batch(statements);
  return { advance, pending };
}

function appendStep(
  db: ReturnType<typeof createCrmDb>["query"],
  runId: string,
  step: RunStepRecord,
  writes: number,
  now: string,
) {
  return db
    .updateTable("core_automation_runs")
    .set((eb) => ({
      steps: sql<string>`json_insert(steps, '$[#]', json(${JSON.stringify(step)}))`,
      writes: eb("writes", "+", writes),
      updated_at: now,
    }))
    .where("id", "=", runId);
}

/** Marks the run waiting (sleep, waitForEvent) or in review, and records the wait as a step. */
export async function markWaiting(
  env: RunEnv,
  runId: string,
  input: {
    status: "waiting" | "review";
    step?: { name: string; kind: "sleep" | "waitForEvent" };
    until: string;
    changeSetId?: string;
  },
): Promise<void> {
  const crm = createCrmDb(env.DB);
  const now = new Date().toISOString();
  await crm.batch([
    crm.query
      .updateTable("core_automation_runs")
      .set((eb) => ({
        status: input.status,
        wait_until: input.until,
        ...(input.changeSetId ? { change_set_id: input.changeSetId } : {}),
        ...(input.step
          ? {
              steps: sql<string>`json_insert(steps, '$[#]', json(${JSON.stringify({
                name: input.step.name,
                kind: input.step.kind,
                status: "waiting",
                startedAt: now,
                until: input.until,
                operations: [],
                logs: [],
              } satisfies RunStepRecord)}))`,
            }
          : {}),
        updated_at: eb.val(now),
      }))
      .where("id", "=", runId)
      .where("status", "in", ["running", "waiting", "review"]),
  ]);
}

/** Marks a wait over: the run continues. */
export async function markRunning(env: RunEnv, runId: string): Promise<void> {
  await createCrmDb(env.DB)
    .query.updateTable("core_automation_runs")
    .set({ status: "running", wait_until: null, updated_at: new Date().toISOString() })
    .where("id", "=", runId)
    .where("status", "in", ["waiting", "review"])
    .execute();
}

/**
 * Ends the run: its status, reason and error, and one upsert of the automation's hourly
 * counters (rails: writes per hour). A failed run notifies the admins once.
 */
export async function finishRun(
  env: RunEnv,
  runId: string,
  status: Extract<RunStatus, "completed" | "failed" | "cancelled" | "expired">,
  detail: { reason?: string; error?: { code: string; message: string } } = {},
): Promise<void> {
  const crm = createCrmDb(env.DB);
  const now = new Date().toISOString();
  const updated = await crm.query
    .updateTable("core_automation_runs")
    .set({
      status,
      status_reason: detail.reason ?? null,
      error: detail.error ? JSON.stringify(detail.error) : null,
      wait_until: null,
      finished_at: now,
      updated_at: now,
    })
    .where("id", "=", runId)
    .where("status", "not in", [...TERMINAL_RUN_STATUSES])
    .returning(["automation_id", "writes"])
    .execute();
  const row = updated[0];
  if (!row) return;
  const statements = [
    crm.query
      .insertInto("core_automation_counters")
      .values({
        automation_id: row.automation_id,
        hour: now.slice(0, 13),
        runs: 1,
        writes: row.writes,
      })
      .onConflict((oc) =>
        oc.columns(["automation_id", "hour"]).doUpdateSet((eb) => ({
          runs: eb("core_automation_counters.runs", "+", 1),
          writes: eb("core_automation_counters.writes", "+", eb.ref("excluded.writes")),
        })),
      ),
  ];
  if (status === "failed") {
    try {
      const plan = await notifyStatements(
        crm.query,
        {
          to: [{ role: "admin" }],
          type: "automation.failed",
          title: `An automation run failed: ${row.automation_id}`,
          body: detail.error?.message ?? null,
          link: { kind: "automationRun", automationId: row.automation_id, runId },
          dedupeKey: `failed:${runId}`,
          source: { actor: "automation", automationId: row.automation_id, runId },
        },
        now,
      );
      statements.push(...(plan.statements as typeof statements));
    } catch (error) {
      console.error("automation failed notice", error);
    }
  }
  await crm.batch(statements);
}

/** onRejected `{ notify }`: a notification through notification.send as the automation. */
export async function notifyRejected(
  env: RunEnv,
  params: AutomationRunParams,
  automation: Pick<AutomationDefinition, "spec">,
  actionId: string,
): Promise<void> {
  const rule = automation.spec.onRejected;
  if (!rule || typeof rule !== "object") return;
  const crm = createCrmDb(env.DB);
  const to =
    rule.notify === "admins" || rule.notify === "actor"
      ? [{ role: "admin" as const }]
      : "userId" in rule.notify
        ? [{ userId: rule.notify.userId }]
        : params.record
          ? "field" in rule.notify
            ? [{ field: rule.notify.field, record: params.record }]
            : [{ managerOf: rule.notify.managerOf, record: params.record }]
          : [{ role: "admin" as const }];
  const plan = await notifyStatements(
    crm.query,
    {
      to,
      type: "automation.message",
      title: rule.message ?? `A change from “${automation.spec.label}” was rejected`,
      link: { kind: "automationRun", automationId: params.automationId, runId: params.runId },
      dedupeKey: `rejected:${actionId}`,
      source: { actor: "automation", automationId: params.automationId, runId: params.runId },
    },
    new Date().toISOString(),
  );
  if (plan.statements.length) await crm.batch(plan.statements);
}
