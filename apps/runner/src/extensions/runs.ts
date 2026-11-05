// Run history (ADR 0025): one core_extension_runs row per execution of extension code, with its
// duration, outcome, logs and the operations it called. Written by trusted host code.
import { newId, type ToolCaller } from "@relationship-os/core";
import { createCrmDb } from "@relationship-os/db";
import type { RunResponse } from "@relationship-os/sdk";

export interface RunRecord {
  /** The run id, when the caller made it before the run (it is passed to the worker). */
  id?: string;
  extensionId: string;
  commit: string | null;
  kind: "tool" | "manifest" | "automation";
  name: string | null;
  caller: ToolCaller | null;
  ms: number;
  response: RunResponse;
  logs: unknown[];
  operations: unknown[];
}

export async function recordRun(env: { DB: D1Database }, run: RunRecord): Promise<string> {
  const id = run.id ?? newId("extensionRun");
  const outcome = run.response.ok
    ? "ok"
    : run.response.error.code === "timeout"
      ? "timeout"
      : "error";
  await createCrmDb(env.DB)
    .query.insertInto("core_extension_runs")
    .values({
      id,
      extension_id: run.extensionId,
      commit_oid: run.commit,
      kind: run.kind,
      name: run.name,
      actor: run.caller?.actor ?? null,
      user_id: run.caller?.userId ?? null,
      started_at: new Date(Date.now() - run.ms).toISOString(),
      duration_ms: Math.round(run.ms),
      outcome,
      error: run.response.ok ? null : JSON.stringify(run.response.error),
      logs: JSON.stringify(run.logs),
      operations: JSON.stringify(run.operations),
    })
    .execute();
  return id;
}
