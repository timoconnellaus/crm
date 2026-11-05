// The automation host (ADR 0130, ADR 0133): ros-runner's side of automation.test, automation.run,
// retry, replay and cancel. ros-app reaches it over RPC (the Runner entrypoint's methods).
import {
  type AutomationDefinition,
  type AutomationDraftTarget,
  type AutomationHost,
  type AutomationTestInput,
  type AutomationTestReport,
  createTestSimulation,
  extensionPrincipalId,
  idsMatchingConditions,
  loadApprovalPolicy,
  loadAutomationSettings,
  loadTriggerRecord,
  newId,
  parseSpec,
  type RunCandidate,
  type RunOperationRecord,
  type SampleApproval,
  type StartRunInput,
  sampleApproval,
  zonedTime,
} from "@relationship-os/core";
import { createCrmDb } from "@relationship-os/db";
import type {
  AutomationEvent,
  AutomationJournalEntry,
  AutomationRunValue,
  AutomationTestStep,
  ExtensionManifest,
} from "@relationship-os/sdk";
import { manifestSchema } from "@relationship-os/sdk";
import { Executor, type ExecutorOptions } from "../executor/executor.ts";
import { type AutomationRunParams, type DispatchEnv, startRuns } from "./dispatch.ts";
import { finishRun, stepOperations } from "./run.ts";

export type AutomationHostEnv = DispatchEnv & ConstructorParameters<typeof Executor>[0];

async function loadDefinition(
  env: { DB: D1Database },
  automationId: string,
): Promise<{ definition: AutomationDefinition; enabled: boolean } | null> {
  const row = await createCrmDb(env.DB)
    .query.selectFrom("core_automations")
    .selectAll()
    .where("id", "=", automationId)
    .executeTakeFirst();
  const spec = row ? parseSpec(row.spec) : null;
  if (!row || !spec) return null;
  return {
    definition: {
      id: row.id,
      extensionId: row.extension_id,
      key: row.key,
      commit: row.commit_oid,
      spec,
    },
    enabled: row.enabled === 1 && !row.paused_reason && !row.removed_at,
  };
}

const TRIGGER_OBJECT_TYPES = new Set(["record", "fieldChanged", "dateRelative", "manual"]);

/**
 * Test mode (ADR 0133): one executor call in `test` mode with an in-memory simulation. Every
 * operation the run calls goes through the pipeline simulated: nothing is written and no events
 * are sent. The report, and a test run row for the automation page, are the only writes.
 */
/**
 * A proposed automation (ADR 0133, stage 7b): evaluates the extension at the proposed commit (the
 * evaluation extension.check and install use, cached by source hash) and takes entry `key`.
 */
async function loadDraftDefinition(
  executor: Executor,
  draft: AutomationDraftTarget,
): Promise<
  | { ok: true; definition: AutomationDefinition; manifest: ExtensionManifest }
  | { ok: false; error: { code: string; message: string } }
> {
  const evaluated = await executor.evaluate({ id: draft.extensionId, commit: draft.commit });
  const parsed = evaluated.ok ? manifestSchema.safeParse(evaluated.manifest) : null;
  if (!evaluated.ok || !parsed?.success) {
    const why = evaluated.ok
      ? (parsed?.error?.issues[0]?.message ?? "invalid manifest")
      : evaluated.issues.map((i) => `${i.path}: ${i.message}`).join("; ");
    return {
      ok: false,
      error: {
        code: "evaluate_failed",
        message: `${draft.extensionId} at commit ${draft.commit} does not evaluate: ${why}`,
      },
    };
  }
  const manifest = parsed.data;
  const spec = Object.hasOwn(manifest.automations, draft.key)
    ? manifest.automations[draft.key]
    : undefined;
  if (!spec) {
    const keys = Object.keys(manifest.automations);
    return {
      ok: false,
      error: {
        code: "unknown_automation",
        message:
          `The proposed ${draft.extensionId} declares no automation "${draft.key}" ` +
          (keys.length ? `(its automations: ${keys.join(", ")})` : "(it declares no automations)"),
      },
    };
  }
  return {
    ok: true,
    manifest,
    definition: {
      id: `${draft.extensionId}.${draft.key}`,
      extensionId: draft.extensionId,
      key: draft.key,
      commit: draft.commit,
      spec,
    },
  };
}

/**
 * The extension's principal user (ADR 0025), as installExtension creates it, if it does not exist
 * yet. A draft runs as its principal like a real run, and operations check that their caller and
 * default assignee exist (task.create assigns the caller), so a not-yet-installed extension needs
 * the row. It is the one write a draft test makes besides test mode's own; install reuses it.
 */
async function ensurePrincipal(
  db: ReturnType<typeof createCrmDb>["query"],
  extensionId: string,
  manifest: ExtensionManifest,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto("core_user")
    .values({
      id: extensionPrincipalId(extensionId),
      name: manifest.label ?? extensionId,
      email: `${extensionId}@extensions.crm.invalid`,
      email_verified: 0,
      image: null,
      created_at: now,
      updated_at: now,
      role: "member",
      kind: "extension",
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
}

export async function testAutomation(
  env: AutomationHostEnv,
  input: AutomationTestInput,
  options: ExecutorOptions = {},
): Promise<AutomationTestReport> {
  const crm = createCrmDb(env.DB);
  const db = crm.query;
  const executor = new Executor(env, options);
  const policy = await loadApprovalPolicy(db);
  let definition: AutomationDefinition;
  let draftManifest: ExtensionManifest | null = null;
  if (input.draft) {
    const loaded = await loadDraftDefinition(executor, input.draft);
    if (!loaded.ok) {
      return {
        automationId: `${input.draft.extensionId}.${input.draft.key}`,
        record: null,
        matched: false,
        matchReason: loaded.error.message,
        steps: [],
        writes: [],
        notifications: [],
        approvals: [],
        policyPreset: policy.preset,
        ok: false,
        error: loaded.error,
        stored: false,
        draft: input.draft,
      };
    }
    definition = loaded.definition;
    draftManifest = loaded.manifest;
    await ensurePrincipal(db, input.draft.extensionId, loaded.manifest);
  } else {
    const found = await loadDefinition(env, input.automationId);
    if (!found) throw new Error(`No automation ${input.automationId}`);
    definition = found.definition;
  }
  const spec = definition.spec;
  const trigger = spec.trigger;
  const runId = newId("automationRun");
  const now = new Date();
  const settings = await loadAutomationSettings(db);
  // A draft's report is not stored: there is no automation page for it yet (and an installed
  // older version's page must not show a test of a version that is not live).
  const stored = !input.draft;
  const base = {
    automationId: definition.id,
    steps: [] as AutomationTestReport["steps"],
    writes: [] as AutomationTestReport["writes"],
    notifications: [] as AutomationTestReport["notifications"],
    approvals: [] as AutomationTestReport["approvals"],
    policyPreset: policy.preset,
    stored: false,
    ...(input.draft ? { draft: input.draft } : {}),
  };

  // Does the trigger (and do the conditions) match this record?
  const triggerObject = "object" in trigger ? (trigger.object ?? null) : null;
  let record: Awaited<ReturnType<typeof loadTriggerRecord>> = null;
  let matched = true;
  let matchReason = "";
  if (input.record) {
    record = await loadTriggerRecord(db, input.record.object, input.record.id);
    if (!record) {
      return {
        ...base,
        record: { ...input.record, title: null },
        matched: false,
        matchReason: `No ${input.record.object} ${input.record.id}`,
        ok: false,
        error: { code: "not_found", message: `No ${input.record.object} ${input.record.id}` },
      };
    }
    if (
      triggerObject &&
      TRIGGER_OBJECT_TYPES.has(trigger.type) &&
      triggerObject !== record.object
    ) {
      matched = false;
      matchReason = `It runs on ${triggerObject} records, not ${record.object}`;
    } else if (spec.conditions) {
      const ok = await idsMatchingConditions(db, record.object, [record.id], spec.conditions, {
        userId: `extension:${definition.extensionId}`,
        now: now.toISOString(),
      });
      matched = ok.has(record.id);
      matchReason = matched
        ? "The record meets the conditions"
        : "The record does not meet the conditions, so a real run would not start";
    } else {
      matchReason = "The trigger applies to this record";
    }
  } else if (triggerObject && TRIGGER_OBJECT_TYPES.has(trigger.type)) {
    matchReason = "No record chosen: steps that read the trigger record see none";
  } else {
    matchReason = "This trigger has no record";
  }

  // approvalDecided: there is no real decision to test against, so the run gets a sample one
  // (from a recent pending action when one fits), labelled as such, and the record a real run
  // would get with it when no record was chosen (ADR 0133 amendment).
  let sample: SampleApproval | null = null;
  if (trigger.type === "approvalDecided") {
    sample = await sampleApproval(db, trigger, record);
    if (!record) {
      const first = trigger.object
        ? sample.approval.records.find((r) => r.object === trigger.object)
        : sample.approval.records[0];
      if (first) record = await loadTriggerRecord(db, first.object, first.id);
    }
    matchReason = record
      ? `${sample.label} It is about ${record.object} ${record.id}.`
      : sample.label;
  }

  // The event a real run would get. A fieldChanged trigger is simulated as the field changing to
  // the record's current value (from null), so a record already in the `to` state matches.
  const recordRef = record ? { object: record.object, id: record.id } : undefined;
  const event: AutomationEvent = {
    automation: definition.id,
    runId,
    trigger: trigger.type,
    ...(record
      ? { record: { object: record.object, id: record.id, data: record.data, title: record.title } }
      : {}),
    ...(trigger.type === "fieldChanged" && record
      ? {
          change: {
            action: "updated" as const,
            diff: { [trigger.field]: { before: null, after: record.data[trigger.field] ?? null } },
          },
        }
      : trigger.type === "record" && record
        ? { change: { action: trigger.on[0] ?? "updated", diff: {} } }
        : {}),
    ...(trigger.type === "schedule" ? { period: zonedTime(now, settings.timezone).minuteKey } : {}),
    ...(trigger.type === "dateRelative" ? { period: zonedTime(now, settings.timezone).date } : {}),
    ...(trigger.type === "manual"
      ? { manual: { userId: input.userId, recordIds: recordRef ? [recordRef.id] : [] } }
      : {}),
    ...(sample ? { approval: sample.approval } : {}),
    test: true,
  };

  const simulate = createTestSimulation();
  const exec = definition.commit
    ? await executor.runAutomation({
        extensionId: definition.extensionId,
        commit: definition.commit,
        request: { automation: definition.key, event, journal: [], mode: "test", version: "" },
        automation: {
          automationId: definition.id,
          runId,
          depth: 1,
          chain: [],
          rootEventId: `test:${runId}`,
          simulate,
        },
        ...(draftManifest ? { draft: { manifest: draftManifest } } : {}),
      })
    : null;
  const response = exec?.response ?? {
    ok: false as const,
    error: { code: "disabled", message: "The automation has no installed commit" },
  };
  const value = response.ok ? (response.value as AutomationRunValue) : null;
  const ranSteps: AutomationTestStep[] =
    value && value.kind === "test"
      ? value.steps
      : (((!response.ok ? (response.error.details as { steps?: unknown } | undefined) : null)
          ?.steps ?? []) as AutomationTestStep[]);
  const operations = exec?.operations ?? [];
  const steps = ranSteps.map((s) => {
    const ops: RunOperationRecord[] = stepOperations(
      operations.filter((o) => o.step === s.name),
      spec,
      s.name,
    ).map((op, i) => {
      const gate = simulate.gates.find(
        (g, gi) => g.operation === op.operation && gi >= i && g.gate !== "auto",
      );
      return gate && op.pendingActionId ? { ...op, gate: gate.gate } : op;
    });
    const logs = (exec?.logs ?? []).map((l) => `${l.level}: ${l.message}`);
    return { ...s, operations: ops, logs: s.kind === "do" ? logs : [] };
  });
  const assignees = new Set<string>();
  for (const w of simulate.writes) {
    const assignee = simulate.overlay.record(w.object, w.id)?.record?.assigneeId;
    if (typeof assignee === "string") assignees.add(assignee);
  }
  const names = assignees.size
    ? await db
        .selectFrom("core_user")
        .select(["id", "name"])
        .where("id", "in", [...assignees])
        .execute()
    : [];
  const report: AutomationTestReport = {
    ...base,
    record: record ? { object: record.object, id: record.id, title: record.title } : null,
    matched,
    matchReason,
    ...(sample
      ? {
          sample: {
            kind: "approval" as const,
            source: sample.source,
            label: sample.label,
            approval: {
              actionId: sample.approval.actionId,
              operation: sample.approval.operation,
              decision: sample.approval.decision,
            },
          },
        }
      : {}),
    steps,
    writes: simulate.writes.map((w) => {
      const assignee = simulate.overlay.record(w.object, w.id)?.record?.assigneeId;
      const name = names.find((n) => n.id === assignee)?.name;
      return {
        object: w.object,
        id: w.id,
        action: w.action,
        title: w.title,
        ...(name ? { for: name } : {}),
      };
    }),
    notifications: simulate.notifications,
    approvals: simulate.gates
      .filter((g) => g.gate === "review")
      .map((g) => ({ operation: g.operation, reason: g.reason, bulkSize: g.bulkSize })),
    ok: response.ok,
    ...(response.ok
      ? {}
      : { error: { code: response.error.code, message: response.error.message } }),
    stored,
  };
  if (!stored) return report;
  const at = now.toISOString();
  await db
    .insertInto("core_automation_runs")
    .values({
      id: runId,
      automation_id: definition.id,
      extension_id: definition.extensionId,
      commit_oid: definition.commit,
      workflow_id: null,
      trigger: JSON.stringify({ type: trigger.type, test: true }),
      record_object: record?.object ?? null,
      record_id: record?.id ?? null,
      status: response.ok ? "completed" : "failed",
      status_reason: "Test mode: nothing was written",
      test: 1,
      depth: 0,
      steps: JSON.stringify(steps),
      report: JSON.stringify(report),
      error: response.ok ? null : JSON.stringify(response.error),
      started_at: at,
      updated_at: at,
      finished_at: at,
    })
    .execute();
  return report;
}

/** Manual trigger: one run per record, through the rails and conditions. */
export async function startManualRun(
  env: AutomationHostEnv,
  input: StartRunInput,
): Promise<{ runIds: string[]; skipped: number }> {
  const found = await loadDefinition(env, input.automationId);
  if (!found?.enabled) {
    return { runIds: [], skipped: input.recordIds.length };
  }
  const nonce = crypto.randomUUID();
  const candidates: RunCandidate[] = input.recordIds.map((id) => ({
    automation: found.definition,
    idempotencyKey: `manual:${nonce}:${id}`,
    record: { object: input.object, id },
  }));
  const result = await startRuns(
    env,
    candidates,
    {
      depth: 0,
      chain: [],
      rootEventId: `manual:${nonce}`,
      eventId: `manual:${nonce}`,
      at: new Date().toISOString(),
    },
    { manual: { userId: input.userId, recordIds: input.recordIds } },
  );
  return { runIds: result.runIds, skipped: result.skipped };
}

interface RunRow {
  id: string;
  automation_id: string;
  workflow_id: string | null;
  status: string;
  trigger: string;
  record_object: string | null;
  record_id: string | null;
  steps: string;
  depth: number;
  root_event_id: string | null;
}

async function loadRun(env: { DB: D1Database }, runId: string): Promise<RunRow> {
  const row = await createCrmDb(env.DB)
    .query.selectFrom("core_automation_runs")
    .select([
      "id",
      "automation_id",
      "workflow_id",
      "status",
      "trigger",
      "record_object",
      "record_id",
      "steps",
      "depth",
      "root_event_id",
    ])
    .where("id", "=", runId)
    .executeTakeFirst();
  if (!row) throw new Error(`No automation run ${runId}`);
  return row as RunRow;
}

/** A new run with an earlier run's trigger: a retry (with its journal) or a replay. */
async function rerun(
  env: AutomationHostEnv,
  runId: string,
  mode: "retry" | "replay",
): Promise<{ runId: string }> {
  const run = await loadRun(env, runId);
  if (mode === "retry" && run.status !== "failed") {
    throw new Error(`Only failed runs can be retried (this one is ${run.status})`);
  }
  const found = await loadDefinition(env, run.automation_id);
  if (!found) throw new Error(`No automation ${run.automation_id}`);
  const trigger = JSON.parse(run.trigger) as {
    eventId?: string;
    change?: RunCandidate["change"];
    approval?: RunCandidate["approval"];
    period?: string;
    integration?: RunCandidate["integration"];
    manual?: AutomationRunParams["manual"];
    chain?: string[];
  };
  // The steps that completed (their values were kept) replay without running again.
  const journal: AutomationJournalEntry[] = [];
  if (mode === "retry") {
    for (const step of JSON.parse(run.steps) as {
      name: string;
      kind: AutomationJournalEntry["kind"];
      status: string;
      value?: unknown;
    }[]) {
      if (step.kind === "do" && step.status === "completed" && "value" in step) {
        journal.push({ name: step.name, kind: "do", value: step.value ?? null });
      } else if (step.kind !== "do" && step.status !== "failed") {
        journal.push({ name: step.name, kind: step.kind, value: null });
      } else {
        break;
      }
    }
  }
  const nonce = crypto.randomUUID();
  const result = await startRuns(
    env,
    [
      {
        automation: found.definition,
        idempotencyKey: `${mode}:${runId}:${nonce}`,
        ...(run.record_object && run.record_id
          ? { record: { object: run.record_object, id: run.record_id } }
          : {}),
        ...(trigger.change ? { change: trigger.change } : {}),
        ...(trigger.approval ? { approval: trigger.approval } : {}),
        ...(trigger.period ? { period: trigger.period } : {}),
        ...(trigger.integration ? { integration: trigger.integration } : {}),
      },
    ],
    {
      depth: Math.max(0, run.depth - 1),
      chain: (trigger.chain ?? []).filter((c) => !c.startsWith(`${run.automation_id}:`)),
      rootEventId: run.root_event_id ?? `${mode}:${nonce}`,
      eventId: trigger.eventId ?? `${mode}:${nonce}`,
      at: new Date().toISOString(),
    },
    {
      ...(mode === "retry" ? { retryOf: runId, journal } : { replayOf: runId }),
      ...(trigger.manual ? { manual: trigger.manual } : {}),
    },
  );
  const started = result.runIds[0];
  if (!started) {
    throw new Error(
      `The ${mode} did not start (${result.dropped.map((d) => d.reason).join(", ") || "skipped"})`,
    );
  }
  return { runId: started };
}

export async function cancelRun(env: AutomationHostEnv, runId: string): Promise<{ runId: string }> {
  const run = await loadRun(env, runId);
  if (run.workflow_id) {
    try {
      const instance = await env.AUTOMATION_WORKFLOW.get(run.workflow_id);
      await instance.terminate();
    } catch (error) {
      console.warn(`automation run ${runId}: terminate`, error);
    }
  }
  await finishRun(env, runId, "cancelled", { reason: "Cancelled by a person" });
  return { runId };
}

/** The AutomationHost for ros-runner's own environment. */
export function automationHost(
  env: AutomationHostEnv,
  options: ExecutorOptions = {},
): AutomationHost {
  return {
    testAutomation: (input) => testAutomation(env, input, options),
    startManualRun: (input) => startManualRun(env, input),
    retryRun: (runId) => rerun(env, runId, "retry"),
    replayRun: (runId) => rerun(env, runId, "replay"),
    cancelRun: (runId) => cancelRun(env, runId),
  };
}
