// Agents as operations see them (ADR 0344): the limits, the queue, and the port to the AgentJob
// Durable Objects. Starting a job only writes a queued row; a slot is taken here, in one statement,
// so the limits hold however many jobs start at once, and a job that frees a slot starts the next.
import type { JobBudget } from "@relationship-os/agent-core";
import type { CoreDatabase, CrmDb } from "@relationship-os/db";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import { ConfigError } from "../errors.ts";
import { errorForLog } from "../log.ts";
import type { HandlerContext } from "../operation.ts";
import { chunk, jsonList } from "../records/common.ts";
import { emailRef, mentions, type ConversationScrub, scrubPattern, scrubText } from "./scrub.ts";

/** The row in core_settings (admin settings, ADR 0344). */
export const AGENT_SETTINGS = "agents";

export const agentSettingsSchema = z.object({
  maxRunningPerUser: z.number().int().min(1).max(100),
  maxRunningPerWorkspace: z.number().int().min(1).max(1_000),
  /** An agent with no profile gets these. */
  defaultSteps: z.number().int().min(1).max(5_000),
  defaultMinutes: z.number().int().min(1).max(1_440),
  defaultSpendUsd: z.number().min(0.01).max(1_000),
  /** How long the assistant waits for an awaited agent before it moves to the background. */
  awaitSeconds: z.number().int().min(1).max(120),
  /** How often the person is reminded of changes waiting for review. */
  reminderHours: z.number().int().min(1).max(168),
});
export type AgentSettings = z.infer<typeof agentSettingsSchema>;

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  maxRunningPerUser: 4,
  maxRunningPerWorkspace: 16,
  defaultSteps: 200,
  defaultMinutes: 30,
  defaultSpendUsd: 2,
  awaitSeconds: 20,
  reminderHours: 24,
};

export async function loadAgentSettings(db: Kysely<CoreDatabase>): Promise<AgentSettings> {
  const row = await db
    .selectFrom("core_settings")
    .select("value")
    .where("key", "=", AGENT_SETTINGS)
    .executeTakeFirst();
  if (!row) return DEFAULT_AGENT_SETTINGS;
  try {
    return agentSettingsSchema.parse(JSON.parse(row.value));
  } catch {
    return DEFAULT_AGENT_SETTINGS;
  }
}

/** The AgentJob objects as operations reach them. ros-app implements it with the namespace. */
export interface AgentJobHost {
  /** Tells the object to start or resume. Idempotent: its alarm owns the work from here. */
  begin(jobId: string): Promise<void>;
  /** Stops it after its current step. */
  stop(jobId: string): Promise<void>;
  /** Waits up to `ms` for it to finish; true when it has. */
  wait(jobId: string, ms: number): Promise<boolean>;
  /** Redacts an erased subject from what the object still holds. Idempotent. */
  scrub(jobId: string, scrub: ConversationScrub): Promise<void>;
}

/** What counts against the limits: paused jobs have let go of their slot. */
const HOLDS_A_SLOT = "running";

/**
 * Takes the next slot, if there is one: the oldest queued job whose person and workspace are under
 * their limits becomes `running`, in one statement. Returns its id, or null.
 */
export async function takeNextSlot(
  crm: CrmDb,
  settings: AgentSettings,
  now: string,
): Promise<string | null> {
  const result = await sql<{ id: string }>`
    UPDATE core_agent_job SET state = 'running', started_at = coalesce(started_at, ${now}), updated_at = ${now}
    WHERE id = (
      SELECT q.id FROM core_agent_job q
      WHERE q.state = 'queued'
        AND (SELECT count(*) FROM core_agent_job r
             WHERE r.state = ${HOLDS_A_SLOT} AND r.user_id = q.user_id) < ${settings.maxRunningPerUser}
        AND (SELECT count(*) FROM core_agent_job r
             WHERE r.state = ${HOLDS_A_SLOT}) < ${settings.maxRunningPerWorkspace}
      ORDER BY q.created_at, q.id
      LIMIT 1
    )
    AND state = 'queued'
    RETURNING id
  `.execute(crm.query);
  return result.rows[0]?.id ?? null;
}

/** Most jobs started by one dispatch: the rest wait for the next finish or the cron. */
const DISPATCH_MAX = 32;

/** Starts every queued job that has a slot. Never throws: the cron tries again. */
export async function dispatchAgentJobs(
  crm: CrmDb,
  host: AgentJobHost | undefined,
  now: string,
): Promise<string[]> {
  if (!host) return [];
  const started: string[] = [];
  try {
    const settings = await loadAgentSettings(crm.query);
    for (let i = 0; i < DISPATCH_MAX; i += 1) {
      const id = await takeNextSlot(crm, settings, now);
      if (!id) break;
      await host.begin(id);
      started.push(id);
    }
  } catch (error) {
    console.error("could not start the next agent", errorForLog(error));
  }
  return started;
}

/** How long a running job may go without a word before the cron nudges its object. */
export const STALE_JOB_MINUTES = 5;

/**
 * The cron's sweep: starts what is queued, and nudges running jobs whose object has gone quiet
 * (`begin` is idempotent, and the alarm normally needs no help).
 */
export async function sweepAgentJobs(
  crm: CrmDb,
  host: AgentJobHost | undefined,
  now: string = new Date().toISOString(),
): Promise<void> {
  if (!host) return;
  const stale = new Date(Date.parse(now) - STALE_JOB_MINUTES * 60_000).toISOString();
  const quiet = await crm.query
    .selectFrom("core_agent_job")
    .select("id")
    .where("state", "=", "running")
    .where("updated_at", "<", stale)
    .limit(50)
    .execute();
  for (const row of quiet) {
    try {
      await host.begin(row.id);
    } catch (error) {
      console.error("could not nudge an agent", errorForLog(error));
    }
  }
  await dispatchAgentJobs(crm, host, now);
}

/** The states a job can no longer leave. */
export const FINISHED_STATES = ["done", "stopped", "failed", "cancelled", "refused"] as const;

export function isFinishedState(state: string): boolean {
  return (FINISHED_STATES as readonly string[]).includes(state);
}

/** A budget as the card reads it: "Up to 200 steps, 30 minutes and $2.00". */
export function budgetWords(budget: JobBudget): string {
  return `Up to ${budget.steps} steps, ${budget.minutes} minutes and $${budget.spendUsd.toFixed(2)}.`;
}

/** Jobs still running hold what they read, whether or not it was indexed yet. */
const LIVE_STATES = ["awaiting_confirm", "queued", "running", "paused"] as const;

const PARALLEL = 8;

/**
 * The agents' side of an erase (ADR 0320, ADR 0344): every finished job that named the subject, by
 * the ref index, and every job still alive, whose object may have read them since. Rows are
 * redacted in the erase's own batch; objects are scrubbed now, before the commit, so an unreachable
 * one fails the erase and it can be retried. Returns how many jobs named the subject.
 */
export async function queueScrubAgentJobs(
  ctx: HandlerContext,
  subject: { recordIds: readonly string[]; terms: readonly string[]; names: readonly string[] },
): Promise<number> {
  const scrub: ConversationScrub = {
    terms: [...subject.recordIds, ...subject.terms],
    names: [...subject.names],
  };
  const pattern = scrubPattern(scrub);
  if (!pattern) return 0;
  const emails = subject.terms.filter((t) => t.includes("@"));
  const refs = [...subject.recordIds, ...(await Promise.all(emails.map(emailRef)))];
  const rows = await ctx.db
    .selectFrom("core_agent_job")
    .select(["id", "title", "brief", "records", "progress", "result", "error", "state"])
    .where((eb) =>
      eb.or([
        eb("state", "in", [...LIVE_STATES]),
        ...(refs.length
          ? [
              eb(
                "id",
                "in",
                eb
                  .selectFrom("core_agent_job_refs")
                  .select("job_id")
                  .where("ref", "in", jsonList(refs)),
              ),
            ]
          : []),
      ]),
    )
    .execute();
  const live = rows.filter((r) => (LIVE_STATES as readonly string[]).includes(r.state));
  if (live.length && !ctx.simulation) {
    const host = ctx.agentJobs;
    if (host) {
      for (const batch of chunk(live, PARALLEL)) {
        await Promise.all(batch.map((row) => host.scrub(row.id, scrub)));
      }
    } else if (live.some((row) => mentions(row, pattern))) {
      throw new ConfigError(
        "An agent still working mentions this record, and it cannot be reached from here. " +
          "Erase it from the app, which can redact it.",
      );
    }
  }
  let named = 0;
  for (const row of rows) {
    if (!mentions(row, pattern)) continue;
    named += 1;
    ctx.write(
      ctx.db
        .updateTable("core_agent_job")
        .set({
          title: scrubText(row.title, pattern),
          brief: scrubText(row.brief, pattern),
          records: scrubText(row.records, pattern),
          progress: row.progress === null ? null : scrubText(row.progress, pattern),
          result: row.result === null ? null : scrubText(row.result, pattern),
          error: row.error === null ? null : scrubText(row.error, pattern),
          updated_at: ctx.now,
        })
        .where("id", "=", row.id),
    );
  }
  if (refs.length) {
    ctx.write(ctx.db.deleteFrom("core_agent_job_refs").where("ref", "in", jsonList(refs)));
  }
  return named;
}
