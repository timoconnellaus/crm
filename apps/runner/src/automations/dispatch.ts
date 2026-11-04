// Starting automation runs (ADR 0130). Every way a run starts goes through `startRuns`: the queue
// consumer (record and approval events, and stage 6b's integration events through
// `dispatchAutomationMessages`), the schedule cron, manual runs, retries and replays.
//
//   candidates ─► rails (cascade depth, cycle, debounce, fan-out budget, rate limits) ─►
//   conditions on the current record ─► run rows (INSERT OR IGNORE on the Workflow id: a duplicate
//   delivery is a no-op) ─► Workflow createBatch (≤100 per call; an existing id is ignored)
//
// Kill switch: nothing starts while it is engaged. Disabled, paused and removed automations are
// never loaded (core_automations_trigger_idx), so they never match.
import {
  type AutomationDefinition,
  type AutomationQueueMessage,
  type AutomationSettings,
  effectiveRails,
  FAN_OUT_BUDGET,
  idsMatchingConditions,
  jsonList,
  loadAutomationSettings,
  loadEnabledAutomations,
  MAX_CASCADE_DEPTH,
  messageObjects,
  newId,
  notifyStatements,
  type RateLimitBinding,
  type RunCandidate,
  refreshSchemaRegistry,
  triggerSourceFor,
  WORKFLOW_BATCH_MAX,
  workflowInstanceId,
} from "@crm/core";
import { type CrmDb, createCrmDb } from "@crm/db";
import type { AutomationJournalEntry, AutomationTriggerType } from "@crm/sdk";
import { sql } from "kysely";

/** What a run's Workflow instance is created with (and what a retry or replay reuses). */
export interface AutomationRunParams {
  runId: string;
  automationId: string;
  extensionId: string;
  key: string;
  commit: string | null;
  trigger: AutomationTriggerType;
  eventId: string;
  record?: { object: string; id: string };
  change?: RunCandidate["change"];
  approval?: RunCandidate["approval"];
  period?: string;
  manual?: { userId: string; recordIds: string[] };
  /** Cascade tags: the run's own depth and chain (its writes carry them). */
  depth: number;
  chain: string[];
  rootEventId: string;
  /** Debounce: the Workflow sleeps this long before it reads the record. */
  delaySeconds?: number;
  /** Retry: the steps of the failed run that completed, replayed without running again. */
  journal?: AutomationJournalEntry[];
}

/** Where a batch of candidates came from: the cascade position of the event. */
export interface CandidateOrigin {
  depth: number;
  chain: readonly string[];
  rootEventId: string;
  eventId: string;
  /** Event time (ISO), for the debounce bucket. */
  at: string;
}

export interface DispatchEnv {
  DB: D1Database;
  AUTOMATION_WORKFLOW: Workflow<AutomationRunParams>;
  AUTOMATION_RATE_LIMIT?: RateLimitBinding;
}

export interface StartResult {
  /** Run ids started (or already started, on a redelivery). */
  runIds: string[];
  /** Candidates a rail or the conditions dropped. */
  skipped: number;
  /** Reasons, for logs and tests. */
  dropped: { automationId: string; reason: string }[];
  /** Automations auto-paused by a rate limit in this call. */
  paused: string[];
}

export interface StartOptions {
  /** Retry / replay links and an explicit journal. */
  retryOf?: string;
  replayOf?: string;
  journal?: AutomationJournalEntry[];
  manual?: { userId: string; recordIds: string[] };
  now?: Date;
}

const emptyResult = (): StartResult => ({ runIds: [], skipped: 0, dropped: [], paused: [] });

function hourKey(at: string): string {
  return at.slice(0, 13);
}

/**
 * Applies the rails and conditions to `candidates`, writes their run rows and creates their
 * Workflow instances. Idempotent per candidate key.
 */
export async function startRuns(
  env: DispatchEnv,
  candidates: readonly RunCandidate[],
  origin: CandidateOrigin,
  options: StartOptions = {},
  preloaded?: AutomationSettings,
): Promise<StartResult> {
  const result = emptyResult();
  if (!candidates.length) return result;
  const crm = createCrmDb(env.DB);
  const db = crm.query;
  const now = (options.now ?? new Date()).toISOString();
  const settings = preloaded ?? (await loadAutomationSettings(db));
  const drop = (c: RunCandidate, reason: string) => {
    result.skipped += 1;
    result.dropped.push({ automationId: c.automation.id, reason });
  };
  if (settings.killSwitch) {
    for (const c of candidates) drop(c, "kill switch");
    return result;
  }

  // Skipped rows for the rare, interesting drops (depth, cycle): visible in the run history.
  const skippedRows: { candidate: RunCandidate; reason: string }[] = [];
  let kept: RunCandidate[] = [];
  for (const c of candidates) {
    if (origin.depth >= MAX_CASCADE_DEPTH) {
      console.warn(`automation ${c.automation.id}: dropped at cascade depth ${origin.depth}`);
      drop(c, "cascade depth");
      skippedRows.push({ candidate: c, reason: `Cascade depth limit (${MAX_CASCADE_DEPTH})` });
      continue;
    }
    if (c.record && origin.chain.includes(chainKey(c.automation.id, c.record))) {
      console.warn(`automation ${c.automation.id}: cycle on ${c.record.object} ${c.record.id}`);
      drop(c, "cycle");
      skippedRows.push({
        candidate: c,
        reason: "Cycle: it already ran on this record in this cascade",
      });
      continue;
    }
    kept.push(debounced(c, origin, settings));
  }

  // Conditions on the current record, one query per automation and object.
  const byAutomation = new Map<string, RunCandidate[]>();
  for (const c of kept) {
    byAutomation.set(c.automation.id, [...(byAutomation.get(c.automation.id) ?? []), c]);
  }
  kept = [];
  for (const group of byAutomation.values()) {
    const spec = (group[0] as RunCandidate).automation.spec;
    if (!spec.conditions) {
      kept.push(...group);
      continue;
    }
    const withRecord = group.filter((c) => c.record);
    for (const c of group) if (!c.record) drop(c, "conditions (no record)");
    const objects = [...new Set(withRecord.map((c) => (c.record as { object: string }).object))];
    for (const object of objects) {
      const ofObject = withRecord.filter((c) => c.record?.object === object);
      const ok = await idsMatchingConditions(
        db,
        object,
        ofObject.map((c) => c.record?.id as string),
        spec.conditions,
        { userId: `extension:${(group[0] as RunCandidate).automation.extensionId}`, now },
      );
      for (const c of ofObject) {
        if (ok.has(c.record?.id as string)) kept.push(c);
        else drop(c, "conditions");
      }
    }
  }

  // Fan-out budget per root event (cost audit U3).
  if (kept.length && origin.depth > 0) {
    const row = await db
      .selectFrom("core_automation_runs")
      .select(sql<number>`count(*)`.as("n"))
      .where("root_event_id", "=", origin.rootEventId)
      .executeTakeFirst();
    const room = Math.max(0, FAN_OUT_BUDGET - Number(row?.n ?? 0));
    if (kept.length > room) {
      console.warn(`automations: fan-out budget reached for ${origin.rootEventId}`);
      for (const c of kept.slice(room)) drop(c, "fan-out budget");
      kept = kept.slice(0, room);
    }
  } else if (kept.length > FAN_OUT_BUDGET) {
    for (const c of kept.slice(FAN_OUT_BUDGET)) drop(c, "fan-out budget");
    kept = kept.slice(0, FAN_OUT_BUDGET);
  }

  // Rate limits: runs per minute (the Rate Limiting binding, per automation) and writes per hour
  // (core_automation_counters). Exceeding either auto-pauses the automation.
  kept = await applyRateLimits(env, crm, kept, now, settings, result, drop);

  // Run rows, then Workflow instances.
  const rows = await Promise.all(
    [
      ...kept.map((c) => ({ candidate: c, skip: null as string | null })),
      ...skippedRows.map((s) => ({ candidate: s.candidate, skip: s.reason })),
    ].map(async ({ candidate, skip }) => ({
      candidate,
      skip,
      workflowId: await workflowInstanceId(candidate.automation.id, candidate.idempotencyKey),
      runId: newId("automationRun"),
    })),
  );
  if (!rows.length) return result;
  await crm.batch(
    rows.map(({ candidate: c, skip, workflowId, runId }) =>
      db
        .insertInto("core_automation_runs")
        .values({
          id: runId,
          automation_id: c.automation.id,
          extension_id: c.automation.extensionId,
          commit_oid: c.automation.commit,
          workflow_id: workflowId,
          trigger: JSON.stringify(triggerJson(c, origin, options)),
          record_object: c.record?.object ?? null,
          record_id: c.record?.id ?? null,
          status: skip ? "skipped" : "queued",
          status_reason: skip,
          test: 0,
          depth: origin.depth + 1,
          root_event_id: origin.rootEventId,
          retry_of: options.retryOf ?? null,
          replay_of: options.replayOf ?? null,
          started_at: now,
          updated_at: now,
          ...(skip ? { finished_at: now } : {}),
        })
        .onConflict((oc) => oc.doNothing()),
    ),
  );
  const toStart = rows.filter((r) => !r.skip);
  if (!toStart.length) return result;
  // On a redelivery the rows already exist: use theirs, and (re)create only queued ones.
  const existing: { id: string; workflow_id: string | null; status: string }[] = [];
  for (let i = 0; i < toStart.length; i += 100) {
    existing.push(
      ...(await db
        .selectFrom("core_automation_runs")
        .select(["id", "workflow_id", "status"])
        .where("workflow_id", "in", jsonList(toStart.slice(i, i + 100).map((r) => r.workflowId)))
        .execute()),
    );
  }
  const byWorkflow = new Map(existing.map((e) => [e.workflow_id as string, e]));
  const instances: { id: string; params: AutomationRunParams }[] = [];
  for (const r of toStart) {
    const row = byWorkflow.get(r.workflowId);
    if (!row) continue;
    result.runIds.push(row.id);
    if (row.status !== "queued") continue;
    instances.push({ id: r.workflowId, params: runParams(r.candidate, row.id, origin, options) });
  }
  for (let i = 0; i < instances.length; i += WORKFLOW_BATCH_MAX) {
    const batch = instances.slice(i, i + WORKFLOW_BATCH_MAX);
    try {
      await env.AUTOMATION_WORKFLOW.createBatch(batch);
    } catch (error) {
      // createBatch reports existing ids rather than throwing; anything else is retried by
      // the caller (the queue redelivers, and the rows are still `queued`).
      if (!/already exists|duplicate|10405|10415/i.test(String(error))) throw error;
    }
  }
  return result;
}

/** The chain entry of a run: `<automationId>:<object>:<recordId>`. */
export function chainKey(automationId: string, record: { object: string; id: string }): string {
  return `${automationId}:${record.object}:${record.id}`;
}

/** `updated` events for one record within the debounce window coalesce into one run. */
function debounced(
  c: RunCandidate,
  origin: CandidateOrigin,
  settings: AutomationSettings,
): RunCandidate {
  if (c.automation.spec.trigger.type !== "record" || c.change?.action !== "updated" || !c.record) {
    return c;
  }
  const window = effectiveRails(c.automation.spec, settings).debounceSeconds;
  if (!window) return c;
  const at = Math.floor(Date.parse(origin.at) / 1000);
  const bucket = Math.floor(at / window);
  return {
    ...c,
    idempotencyKey: `${c.record.id}:debounce:${bucket}`,
    delaySeconds: (bucket + 1) * window - at,
  };
}

function triggerJson(c: RunCandidate, origin: CandidateOrigin, options: StartOptions) {
  return {
    type: c.automation.spec.trigger.type,
    eventId: origin.eventId,
    key: c.idempotencyKey,
    ...(c.record ? { record: c.record } : {}),
    ...(c.change ? { change: c.change } : {}),
    ...(c.approval ? { approval: c.approval } : {}),
    ...(c.period ? { period: c.period } : {}),
    ...(options.manual ? { manual: options.manual } : {}),
    chain: origin.chain,
  };
}

function runParams(
  c: RunCandidate,
  runId: string,
  origin: CandidateOrigin,
  options: StartOptions,
): AutomationRunParams {
  return {
    runId,
    automationId: c.automation.id,
    extensionId: c.automation.extensionId,
    key: c.automation.key,
    commit: c.automation.commit,
    trigger: c.automation.spec.trigger.type,
    eventId: origin.eventId,
    ...(c.record ? { record: c.record } : {}),
    ...(c.change ? { change: c.change } : {}),
    ...(c.approval ? { approval: c.approval } : {}),
    ...(c.period ? { period: c.period } : {}),
    ...(options.manual ? { manual: options.manual } : {}),
    depth: origin.depth + 1,
    chain: c.record ? [...origin.chain, chainKey(c.automation.id, c.record)] : [...origin.chain],
    rootEventId: origin.rootEventId,
    ...(c.delaySeconds ? { delaySeconds: c.delaySeconds } : {}),
    ...(options.journal?.length ? { journal: options.journal } : {}),
  };
}

/**
 * Auto-pauses `automationId` (once: a paused one is not re-paused) and notifies the admins with
 * one `automation.paused` notification per pause. Returns true when this call paused it.
 */
export async function pauseAutomation(
  crm: CrmDb,
  automation: AutomationDefinition,
  reason: string,
  now: string,
): Promise<boolean> {
  const paused = await crm.query
    .updateTable("core_automations")
    .set({ paused_reason: reason, paused_at: now, updated_at: now })
    .where("id", "=", automation.id)
    .where("paused_reason", "is", null)
    .returning("id")
    .execute();
  if (!paused.length) return false;
  console.warn(`automation ${automation.id} auto-paused: ${reason}`);
  try {
    const plan = await notifyStatements(
      crm.query,
      {
        to: [{ role: "admin" }],
        type: "automation.paused",
        title: `“${automation.spec.label}” was paused`,
        body: `${reason}. Resume it on the automation page once you have checked why.`,
        link: { kind: "automation", automationId: automation.id },
        dedupeKey: `paused:${automation.id}:${now}`,
        source: { actor: "automation", automationId: automation.id },
      },
      now,
    );
    if (plan.statements.length) await crm.batch(plan.statements);
  } catch (error) {
    console.error("automation paused notice failed", error);
  }
  return true;
}

async function applyRateLimits(
  env: DispatchEnv,
  crm: CrmDb,
  candidates: RunCandidate[],
  now: string,
  settings: AutomationSettings,
  result: StartResult,
  drop: (c: RunCandidate, reason: string) => void,
): Promise<RunCandidate[]> {
  const out: RunCandidate[] = [];
  const blocked = new Set<string>();
  const writesChecked = new Map<string, boolean>();
  for (const c of candidates) {
    const a = c.automation;
    if (blocked.has(a.id)) {
      drop(c, "paused");
      continue;
    }
    const rails = effectiveRails(a.spec, settings);
    if (!writesChecked.has(a.id)) {
      const counter = await crm.query
        .selectFrom("core_automation_counters")
        .select(["writes"])
        .where("automation_id", "=", a.id)
        .where("hour", "=", hourKey(now))
        .executeTakeFirst();
      const over = (counter?.writes ?? 0) >= rails.maxWritesPerHour;
      writesChecked.set(a.id, over);
      if (over) {
        const reason = `More than ${rails.maxWritesPerHour} writes in an hour`;
        if (await pauseAutomation(crm, a, reason, now)) result.paused.push(a.id);
        blocked.add(a.id);
        drop(c, "rate limit");
        continue;
      }
    }
    let allowed = true;
    if (env.AUTOMATION_RATE_LIMIT) {
      allowed = (await env.AUTOMATION_RATE_LIMIT.limit({ key: a.id })).success;
    }
    if (allowed && rails.maxRunsPerMinute < 60) {
      // A stricter per-automation limit than the binding's: count the last minute's runs.
      const since = new Date(Date.parse(now) - 60_000).toISOString();
      const recent = await crm.query
        .selectFrom("core_automation_runs")
        .select(sql<number>`count(*)`.as("n"))
        .where("automation_id", "=", a.id)
        .where("started_at", ">=", since)
        .executeTakeFirst();
      const started = out.filter((o) => o.automation.id === a.id).length;
      allowed = Number(recent?.n ?? 0) + started < rails.maxRunsPerMinute;
    }
    if (!allowed) {
      const reason = `More than ${rails.maxRunsPerMinute} runs a minute`;
      if (await pauseAutomation(crm, a, reason, now)) result.paused.push(a.id);
      blocked.add(a.id);
      drop(c, "rate limit");
      continue;
    }
    out.push(c);
  }
  return out;
}

/**
 * Turns queue messages into runs (the consumer's whole job, and the seam stage 6b uses for
 * integration events polled from core_integration_event): per message, its kind's TriggerSource
 * matches the enabled automations, then `startRuns` applies the rails and conditions. Approval
 * decisions also wake the run waiting on that action (review pause).
 */
export async function dispatchAutomationMessages(
  env: DispatchEnv,
  messages: readonly AutomationQueueMessage[],
  options: { now?: Date } = {},
): Promise<StartResult> {
  const total = emptyResult();
  if (!messages.length) return total;
  const db = createCrmDb(env.DB).query;
  // Trigger sources read extension objects from the field registry (a stage relation's status
  // field for `{ stageType }`); a fresh isolate has only core objects until it is refreshed.
  await refreshSchemaRegistry(db);
  const settings = await loadAutomationSettings(db);
  const cache = new Map<string, AutomationDefinition[]>();
  for (const message of messages) {
    if (message.kind === "approval" && message.actionOrigin.runId) {
      await wakeReviewedRun(env, message.actionOrigin.runId, message.actionId, message.decision);
    }
    const source = triggerSourceFor(message.kind);
    if (!source) continue;
    const objects = messageObjects(message);
    const cacheKey = `${source.kind}|${objects?.join(",") ?? "*"}`;
    let automations = cache.get(cacheKey);
    if (!automations) {
      automations = await loadEnabledAutomations(db, source.triggerTypes, objects);
      cache.set(cacheKey, automations);
    }
    if (!automations.length) continue;
    const candidates = source.match(message, automations);
    const started = await startRuns(
      env,
      candidates,
      {
        depth: message.origin.depth,
        chain: message.origin.chain,
        rootEventId: message.origin.rootEventId,
        eventId: message.id,
        at: message.at,
      },
      options.now ? { now: options.now } : {},
      settings,
    );
    total.runIds.push(...started.runIds);
    total.skipped += started.skipped;
    total.dropped.push(...started.dropped);
    total.paused.push(...started.paused);
  }
  return total;
}

/** Sends a pending action's decision to the run waiting on it (Workflow waitForEvent). */
async function wakeReviewedRun(
  env: DispatchEnv,
  runId: string,
  actionId: string,
  decision: string,
): Promise<void> {
  const row = await createCrmDb(env.DB)
    .query.selectFrom("core_automation_runs")
    .select(["workflow_id"])
    .where("id", "=", runId)
    .executeTakeFirst();
  if (!row?.workflow_id) return;
  try {
    const instance = await env.AUTOMATION_WORKFLOW.get(row.workflow_id);
    await instance.sendEvent({ type: reviewEventType(actionId), payload: { decision } });
  } catch (error) {
    console.warn(`automation run ${runId}: could not deliver the decision on ${actionId}`, error);
  }
}

/** The Workflow event type a review pause waits for (no dots: `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`). */
export function reviewEventType(actionId: string): string {
  return `approval-${actionId}`;
}
