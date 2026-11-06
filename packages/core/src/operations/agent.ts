// agent.* and agentProfile.* operations (ADR 0344): the person's and the assistant's handle on
// agents. In code they are jobs. `agent.start` checks the grant in code (never wider than the
// starter), asks the judge whether it fits the brief, and queues the job; the AgentJob object does
// the work and reports through `agent.report`. People can stop an agent, not chat with it.

import { a2uiPartSchema, prepareCard } from "@relationship-os/agent-a2ui";
import { type JobBudget, ordinal } from "@relationship-os/agent-core";
import type { AgentJobState, CoreDatabase } from "@relationship-os/db";
import type { Kysely } from "kysely";
import { z } from "zod";
import { isModelRole, MODEL_ROLES, type ModelRole } from "../ai/roles.ts";
import {
  AGENT_SETTINGS,
  agentSettingsSchema,
  budgetWords,
  DEFAULT_AGENT_SETTINGS,
  dispatchAgentJobs,
  isFinishedState,
  loadAgentSettings,
} from "../assistant/agent-jobs.ts";
import { type AgentProfile, agentProfiles } from "../assistant/agent-profiles.ts";
import { CARD_STATUS } from "../assistant/events.ts";
import {
  assertWithinStarter,
  type Grant,
  grantCapsSchema,
  grantSchema,
  grantTargetSchema,
  type JobStarter,
  jobSession,
  targetWords,
} from "../assistant/grants.ts";
import { conversationRefs } from "../assistant/scrub.ts";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { askGrant, grantState } from "../judge/questions/grant-least-privilege.ts";
import { judgeUsageStatement } from "../judge/usage.ts";
import { notifyStatements } from "../notifications/send.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { jsonList } from "../records/common.ts";

const jobId = z.string().startsWith("job_").max(64).describe("The agent's id (job_…)");

const recordRef = z.object({
  object: z.string().min(1).max(64),
  id: z.string().min(1).max(64),
});

const budgetSchema = z.object({
  steps: z.number().int().min(1).max(5_000),
  minutes: z.number().int().min(1).max(1_440),
  spendUsd: z.number().min(0).max(1_000),
});

const progressSchema = z.object({
  done: z.number().int().min(0).max(1_000_000).optional(),
  total: z.number().int().min(0).max(1_000_000).optional(),
  now: z.string().trim().max(200).optional(),
});

const JOB_STATES = [
  "awaiting_confirm",
  "refused",
  "queued",
  "running",
  "paused",
  "done",
  "stopped",
  "failed",
  "cancelled",
] as const;

const jobViewSchema = z.object({
  id: z.string(),
  title: z.string(),
  brief: z.string(),
  profile: z.string().nullable(),
  mode: z.enum(["awaited", "background"]),
  state: z.enum(JOB_STATES),
  grant: grantSchema,
  budget: budgetSchema,
  reviewEverything: z.boolean(),
  progress: progressSchema.nullable(),
  steps: z.number(),
  spentUsd: z.number(),
  fieldsFilled: z.number(),
  result: z.string().nullable(),
  error: z.string().nullable(),
  /** The change set holding what it staged. */
  changeSetId: z.string().nullable(),
  /** "N changes to review". */
  toReview: z.number(),
  /** Position among queued jobs from 1, when queued. */
  place: z.number().nullable(),
  placeLabel: z.string().nullable(),
  startedBy: z.object({ kind: z.string(), id: z.string() }),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type AgentJobView = z.infer<typeof jobViewSchema>;

type JobRow = Awaited<ReturnType<typeof loadRows>>[number];

function loadRows(db: Kysely<CoreDatabase>, where: { id?: string; userId?: string }) {
  let query = db.selectFrom("core_agent_job").selectAll();
  if (where.id) query = query.where("id", "=", where.id);
  if (where.userId) query = query.where("user_id", "=", where.userId);
  return query.orderBy("created_at", "desc").limit(50).execute();
}

function json<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

async function jobViews(ctx: HandlerContext, rows: readonly JobRow[]): Promise<AgentJobView[]> {
  if (!rows.length) return [];
  const sessions = rows.map((r) => jobSession(r.id));
  const sets = await ctx.db
    .selectFrom("core_change_set as c")
    .leftJoin("core_pending_action as p", (join) =>
      join
        .onRef("p.change_set_id", "=", "c.id")
        .on("p.status", "=", "pending")
        .on("p.expires_at", ">", ctx.now),
    )
    .select((eb) => ["c.id", "c.session_id", eb.fn.count<number>("p.id").as("pending")])
    .where("c.session_id", "in", jsonList(sessions))
    .groupBy("c.id")
    .execute();
  const queued = await ctx.db
    .selectFrom("core_agent_job")
    .select(["id"])
    .where("state", "=", "queued")
    .orderBy("created_at")
    .orderBy("id")
    .limit(200)
    .execute();
  return rows.map((row) => {
    const mine = sets.filter((s) => s.session_id === jobSession(row.id));
    const place = queued.findIndex((q) => q.id === row.id);
    return {
      id: row.id,
      title: row.title,
      brief: row.brief,
      profile: row.profile,
      mode: row.mode,
      state: row.state,
      grant: json<Grant>(row.access, {} as Grant),
      budget: json<JobBudget>(row.budget, { steps: 0, minutes: 0, spendUsd: 0 }),
      reviewEverything: row.review_everything === 1,
      progress: json(row.progress, null),
      steps: row.steps,
      spentUsd: row.spent_microusd / 1_000_000,
      fieldsFilled: row.fields_filled,
      result: row.result,
      error: row.error,
      changeSetId: mine.at(-1)?.id ?? null,
      toReview: mine.reduce((n, s) => n + Number(s.pending), 0),
      place: place >= 0 ? place + 1 : null,
      placeLabel: place >= 0 ? `${ordinal(place + 1)} in line` : null,
      startedBy: { kind: row.starter_kind, id: row.starter_id },
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    };
  });
}

/** A job the caller may act on. Only its person can see or stop it. */
async function ownJob(ctx: HandlerContext, id: string): Promise<JobRow> {
  const [row] = await loadRows(ctx.db, { id });
  if (!row || row.user_id !== ctx.user.id) throw new NotFoundError("agent", id);
  return row;
}

function starterOf(ctx: HandlerContext): JobStarter {
  if (ctx.actor === "automation") {
    return { kind: "routine", id: ctx.origin.automationId ?? "routine", actor: "automation" };
  }
  if (ctx.actor === "extension") {
    if (!ctx.extension) throw new ForbiddenError("Extension calls need the calling extension");
    return {
      kind: "plugin",
      id: ctx.extension.id,
      actor: "extension",
      extension: ctx.extension,
    };
  }
  return { kind: "user", id: ctx.user.id, actor: ctx.actor };
}

/** The grant asked for: the profile's defaults, with whatever the starter said instead. */
function grantFrom(
  input: {
    operations?: string[] | undefined;
    target?: Grant["target"] | undefined;
    caps?: Partial<z.input<typeof grantCapsSchema>> | undefined;
    expiresInHours?: number | undefined;
    records: { id: string }[];
  },
  profile: AgentProfile | null,
  now: string,
  starter: JobStarter,
): Grant {
  const operations = input.operations ?? [...(profile?.defaultGrant.operations ?? [])];
  if (!operations.length) {
    throw new ValidationError("Name a profile, or the operations this agent needs", {
      field: "operations",
    });
  }
  // A routine's brief names no records: with an empty target, nothing applies without review.
  const target =
    input.target ??
    (input.records.length || starter.kind !== "user"
      ? { ids: input.records.map((r) => r.id) }
      : null);
  if (!target) {
    throw new ValidationError("Name the records this agent works on, or a target filter", {
      field: "target",
    });
  }
  const caps = grantCapsSchema.parse({
    ...(profile?.defaultGrant.caps ?? { changes: 0, notes: 0, tasks: 0 }),
    ...(input.caps ?? {}),
  });
  const hours = input.expiresInHours ?? profile?.defaultGrant.expiresInHours ?? 8;
  return {
    operations,
    target,
    caps,
    expiresAt: new Date(Date.parse(now) + hours * 3_600_000).toISOString(),
  };
}

function capWords(caps: Grant["caps"]): string {
  const parts = [
    caps.changes ? `up to ${caps.changes} fields filled` : "",
    caps.notes ? `${caps.notes} notes` : "",
    caps.tasks ? `${caps.tasks} tasks` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "nothing without review";
}

function grantWords(grant: Grant): string[] {
  const can = [`${capWords(grant.caps)}, on ${targetWords(grant.target)}`];
  can.push(`Until ${grant.expiresAt.slice(0, 16).replace("T", " ")} UTC`);
  return can;
}

/** The card a person confirms a grant on. */
function grantCard(job: {
  id: string;
  title: string;
  brief: string;
  grant: Grant;
  budget: JobBudget;
  note?: string | undefined;
}) {
  return prepareCard(
    {
      a2ui: 1,
      root: {
        type: "agentGrant",
        jobId: job.id,
        title: job.title,
        brief: job.brief.slice(0, 2_000),
        can: grantWords(job.grant),
        aside: [
          "Changing a value that's already filled in",
          "Anything else, like emails or deleting",
        ],
        budget: `${budgetWords(job.budget)} Runs in the background, so you can keep chatting.`,
        ...(job.note ? { note: job.note } : {}),
      },
    },
    { source: "host", text: `Before I start: ${job.title}` },
  );
}

function jobCard(id: string, title: string, words: string) {
  return prepareCard(
    { a2ui: 1, root: { type: "agentJob", jobId: id, title } },
    { source: "host", text: words },
  );
}

const startResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal(CARD_STATUS),
    part: a2uiPartSchema,
    jobId: z.string(),
    state: z.enum(JOB_STATES),
  }),
  z.object({
    status: z.literal("done"),
    jobId: z.string(),
    state: z.enum(JOB_STATES),
    result: z.string(),
    toReview: z.number(),
  }),
  z.object({
    status: z.literal("refused"),
    jobId: z.string(),
    message: z.string(),
    canResubmit: z.boolean(),
  }),
]);

export const agentStart = defineOperation({
  name: "agent.start",
  description:
    "Start an agent: a background worker for anything longer than a couple of tool calls or a few " +
    "seconds (research across records, a clean-up, drafting several things). Tell the person at " +
    "once that it is running and carry on: they see a progress card and can keep chatting. It " +
    "gets only what you give it: write a full brief, because it cannot see this chat. Pick a " +
    "profile (researcher, drafter, importer, analyst, see agentProfile.list) for its default " +
    "access, or name the operations. It can fill empty fields and add notes and tasks on `records` " +
    "by itself; every other change waits in one review for the person. Use mode `awaited` for " +
    "short work you need in your reply (no card, it moves to the background if it runs long). If " +
    "the grant is refused as wider than the brief needs, narrow it, or call again once with a " +
    "`justification`. Never for a single lookup: do those yourself.",
  input: z.object({
    title: z.string().trim().min(1).max(120).describe("A short name: 'Account research'"),
    brief: z
      .string()
      .trim()
      .min(10)
      .max(8_000)
      .describe("Everything it needs to know, written out. It cannot see the chat"),
    records: z.array(recordRef).max(1_000).default([]).describe("The records it works on"),
    profile: z.string().max(120).optional().describe("An agent profile's name"),
    mode: z.enum(["awaited", "background"]).default("background"),
    operations: z.array(z.string().min(3).max(120)).max(60).optional(),
    target: grantTargetSchema.optional().describe("Default: `records`"),
    caps: grantCapsSchema.partial().optional(),
    expiresInHours: z.number().min(0.25).max(168).optional(),
    budget: budgetSchema.partial().optional().describe("Default: the profile's"),
    justification: z
      .string()
      .trim()
      .min(5)
      .max(500)
      .optional()
      .describe("Only after a refusal: why it needs this access"),
  }),
  output: startResultSchema,
  permission: "records:read",
  risk: "write",
  actors: ["human", "assistant", "automation", "extension"],
  // Starting one writes no records; what it does is gated call by call.
  bookkeeping: true,
  mcp: { curated: true, title: "Start an agent", toolName: "start_agent" },
  async handler(input, ctx) {
    if (ctx.origin.jobId) throw new ForbiddenError("An agent cannot start another agent");
    const profile = input.profile ? (agentProfiles.get(input.profile) ?? null) : null;
    if (input.profile && !profile) throw new NotFoundError("agent profile", input.profile);
    const settings = await loadAgentSettings(ctx.db);
    const starter = starterOf(ctx);
    const grant = grantFrom(input, profile, ctx.now, starter);
    // In code, before anything else: never wider than whatever started it.
    await assertWithinStarter(grant, {
      db: ctx.db,
      user: ctx.user,
      starter,
      floor: ctx.floor,
      grantedPermissions: ctx.grantedPermissions,
      resolve: (name) => ctx.pipeline.resolve(name),
    });
    const budget: JobBudget = {
      steps: input.budget?.steps ?? profile?.budget.steps ?? settings.defaultSteps,
      minutes: input.budget?.minutes ?? profile?.budget.minutes ?? settings.defaultMinutes,
      spendUsd: input.budget?.spendUsd ?? profile?.budget.spendUsd ?? settings.defaultSpendUsd,
    };
    const role: ModelRole = profile?.role ?? "assistant.subagent";
    if (!isModelRole(role)) throw new ValidationError(`No model role named ${String(role)}`);

    // One resubmission (ADR 0344): the same brief, refused before, comes back only with a reason.
    const refusals = await ctx.db
      .selectFrom("core_agent_job")
      .select(["id", "justification"])
      .where("user_id", "=", ctx.user.id)
      .where("state", "=", "refused")
      .where("brief", "=", input.brief)
      .execute();
    if (refusals.some((r) => r.justification !== null)) {
      return {
        status: "refused" as const,
        jobId: refusals[0]?.id ?? "",
        message: "This access was refused twice. Narrow what the agent needs, or ask the person.",
        canResubmit: false,
      };
    }
    if (refusals.length && !input.justification) {
      return {
        status: "refused" as const,
        jobId: refusals[0]?.id ?? "",
        message: "This access was refused. Narrow it, or give a justification once.",
        canResubmit: true,
      };
    }

    const id = newId("agentJob");
    let state: AgentJobState = "awaiting_confirm";
    let note: string | undefined;
    let judged: Record<string, unknown> = { status: "off" };
    if (ctx.judge) {
      const operations = grant.operations.map((name) => ({
        name,
        does: ctx.pipeline.resolve(name)?.description.slice(0, 160) ?? name,
      }));
      const asked = await askGrant(
        ctx.judge,
        grantState({
          brief: input.brief,
          profile: profile?.label ?? "None",
          operations,
          target: targetWords(grant.target),
          caps: capWords(grant.caps),
          expiry: grant.expiresAt,
          ...(input.justification ? { justification: input.justification } : {}),
        }),
      );
      if (asked.status === "answered") {
        ctx.write(
          judgeUsageStatement(
            ctx.db,
            "grant.leastPrivilege",
            { calls: 1, inputTokens: asked.inputTokens },
            ctx.now,
          ),
        );
        judged = { status: "answered", label: asked.label, probabilities: asked.probabilities };
        state = asked.fits ? "queued" : "refused";
      } else {
        judged = { status: "failed", reason: asked.reason };
        note = "This wasn't checked automatically, so please look it over.";
      }
    }
    const mode = starter.kind === "user" ? input.mode : "background";
    ctx.write(
      ctx.db.insertInto("core_agent_job").values({
        id,
        user_id: ctx.user.id,
        starter_kind: starter.kind,
        starter_id: starter.id,
        profile: profile?.name ?? null,
        role,
        title: input.title,
        brief: input.brief,
        records: JSON.stringify(input.records),
        access: JSON.stringify(grant),
        budget: JSON.stringify(budget),
        mode,
        state,
        judged: JSON.stringify(judged),
        justification: input.justification ?? null,
        finished_at: state === "refused" ? ctx.now : null,
        created_at: ctx.now,
        updated_at: ctx.now,
      }),
    );
    const refs = await conversationRefs([input.title, input.brief, input.records]);
    if (refs.length) {
      ctx.write(
        ctx.db
          .insertInto("core_agent_job_refs")
          .values(refs.slice(0, 20).map((ref) => ({ job_id: id, ref })))
          .onConflict((oc) => oc.doNothing()),
      );
    }
    if (state === "refused") {
      return {
        status: "refused" as const,
        jobId: id,
        message: input.justification
          ? "This access is still more than the brief needs. Narrow it, or ask the person."
          : "This access is more than the brief needs. Narrow it, or give a justification once.",
        canResubmit: !input.justification,
      };
    }
    if (state === "awaiting_confirm") {
      return {
        status: CARD_STATUS,
        part: grantCard({ id, title: input.title, brief: input.brief, grant, budget, note }),
        jobId: id,
        state,
      };
    }
    const host = ctx.agentJobs;
    return ctx.afterCommit(async () => {
      await dispatchAgentJobs(ctx.pipeline.crm, host, ctx.now);
      const [row] = await loadRows(ctx.db, { id });
      if (mode === "awaited" && host && row?.state === "running") {
        if (await host.wait(id, settings.awaitSeconds * 1_000)) {
          const [done] = await loadRows(ctx.db, { id });
          const [view] = done ? await jobViews(ctx, [done]) : [];
          if (view) {
            return {
              status: "done" as const,
              jobId: id,
              state: view.state,
              result: view.result ?? view.error ?? "",
              toReview: view.toReview,
            };
          }
        }
        // Past the limit it carries on in the background, with a card.
        await ctx.pipeline.crm.batch([
          ctx.db.updateTable("core_agent_job").set({ mode: "background" }).where("id", "=", id),
        ]);
      }
      const waiting = row?.state === "queued";
      return {
        status: CARD_STATUS,
        part: jobCard(
          id,
          input.title,
          waiting
            ? `${input.title} is waiting for a free slot. It starts when another agent finishes.`
            : `${input.title} is running in the background.`,
        ),
        jobId: id,
        state: row?.state ?? "queued",
      };
    });
  },
});

export const agentStop = defineOperation({
  name: "agent.stop",
  description:
    "Stop an agent, or take one out of the queue, when the person asks. Nothing else runs. What " +
    "it already did stays, and its changes waiting for review stay waiting.",
  input: z.object({ jobId }),
  output: z.object({ jobId: z.string(), state: z.enum(JOB_STATES) }),
  permission: "records:read",
  risk: "write",
  actors: ["human", "assistant"],
  bookkeeping: true,
  mcp: { curated: true, title: "Stop an agent", toolName: "stop_agent" },
  async handler(input, ctx) {
    const row = await ownJob(ctx, input.jobId);
    if (isFinishedState(row.state)) return { jobId: row.id, state: row.state };
    const state: AgentJobState =
      row.state === "queued" || row.state === "awaiting_confirm" ? "cancelled" : "stopped";
    ctx.write(
      ctx.db
        .updateTable("core_agent_job")
        .set({ state, finished_at: ctx.now, updated_at: ctx.now })
        .where("id", "=", row.id)
        .where("state", "=", row.state),
    );
    const host = ctx.agentJobs;
    return ctx.afterCommit(async () => {
      if (row.started_at) await host?.stop(row.id);
      await dispatchAgentJobs(ctx.pipeline.crm, host, ctx.now);
      return { jobId: row.id, state };
    });
  },
});

export const agentStatus = defineOperation({
  name: "agent.status",
  description:
    "How the person's agents are doing: one by id, or their newest. Each has its state, progress, " +
    "steps, spend, fields filled, how many changes wait for review, and its result once done. " +
    "Read-only.",
  input: z.object({ jobId: jobId.optional() }),
  output: z.object({ jobs: z.array(jobViewSchema) }),
  permission: "records:read",
  risk: "read",
  actors: ["human", "assistant", "automation"],
  mcp: { curated: true, idempotent: true, title: "Agent status", toolName: "agent_status" },
  async handler(input, ctx) {
    const rows = input.jobId
      ? [await ownJob(ctx, input.jobId)]
      : await loadRows(ctx.db, { userId: ctx.user.id });
    return { jobs: await jobViews(ctx, rows) };
  },
});

export const agentAllowSpend = defineOperation({
  name: "agent.allowSpend",
  description:
    "Let an agent paused at its spend limit carry on, with this much more. People only: it goes " +
    "back in line and is charged to whatever started it.",
  input: z.object({ jobId, usd: z.number().min(0.01).max(100) }),
  output: z.object({ jobId: z.string(), spendUsd: z.number(), state: z.enum(JOB_STATES) }),
  permission: "records:read",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const row = await ownJob(ctx, input.jobId);
    if (row.state !== "paused") {
      throw new ConflictError("This agent is not paused at its spend limit", { state: row.state });
    }
    const budget = json<JobBudget>(row.budget, { steps: 0, minutes: 0, spendUsd: 0 });
    const spendUsd = Math.round((budget.spendUsd + input.usd) * 100) / 100;
    ctx.write(
      ctx.db
        .updateTable("core_agent_job")
        .set({
          state: "queued",
          budget: JSON.stringify({ ...budget, spendUsd }),
          updated_at: ctx.now,
        })
        .where("id", "=", row.id)
        .where("state", "=", "paused"),
    );
    const host = ctx.agentJobs;
    return ctx.afterCommit(async () => {
      await dispatchAgentJobs(ctx.pipeline.crm, host, ctx.now);
      const [after] = await loadRows(ctx.db, { id: row.id });
      return { jobId: row.id, spendUsd, state: after?.state ?? "queued" };
    });
  },
});

export const agentConfirmGrant = defineOperation({
  name: "agent.confirmGrant",
  description:
    "The person's answer on a grant shown before an agent starts: start it, start it with every " +
    "change set aside for them, or cancel. People only.",
  input: z.object({ jobId, decision: z.enum(["start", "startReviewing", "cancel"]) }),
  output: z.object({ jobId: z.string(), state: z.enum(JOB_STATES) }),
  permission: "records:read",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const row = await ownJob(ctx, input.jobId);
    if (row.state !== "awaiting_confirm") {
      throw new ConflictError("This agent is not waiting for a yes", { state: row.state });
    }
    const state: AgentJobState = input.decision === "cancel" ? "cancelled" : "queued";
    ctx.write(
      ctx.db
        .updateTable("core_agent_job")
        .set({
          state,
          mode: "background",
          review_everything: input.decision === "startReviewing" ? 1 : 0,
          finished_at: state === "cancelled" ? ctx.now : null,
          updated_at: ctx.now,
        })
        .where("id", "=", row.id)
        .where("state", "=", "awaiting_confirm"),
    );
    const host = ctx.agentJobs;
    return ctx.afterCommit(async () => {
      await dispatchAgentJobs(ctx.pipeline.crm, host, ctx.now);
      const [after] = await loadRows(ctx.db, { id: row.id });
      return { jobId: row.id, state: after?.state ?? state };
    });
  },
});

export const agentProgress = defineOperation({
  name: "agent.progress",
  description:
    "For an agent at work: say how far along you are, for the person's progress card. `done` of " +
    "`total` records, and what you are on `now`. Call it as you finish each record.",
  input: progressSchema,
  output: z.object({ ok: z.boolean() }),
  permission: "records:read",
  risk: "write",
  actors: ["assistant"],
  bookkeeping: true,
  mcp: { curated: true, title: "Report progress", toolName: "agent_progress" },
  async handler(input, ctx) {
    const id = ctx.origin.jobId;
    if (!id) throw new ForbiddenError("Only an agent reports progress");
    ctx.write(
      ctx.db
        .updateTable("core_agent_job")
        .set({ progress: JSON.stringify(input), updated_at: ctx.now })
        .where("id", "=", id),
    );
    return { ok: true };
  },
});

export const agentReport = defineOperation({
  name: "agent.report",
  description:
    "Internal: the AgentJob object's bookkeeping, as its person. What it has used, and how it " +
    "ended. Returns the job's state, which may be stopped. Refused for anything but that object.",
  input: z.object({
    jobId,
    steps: z.number().int().min(0),
    spentMicrousd: z.number().int().min(0),
    fieldsFilled: z.number().int().min(0),
    end: z
      .object({
        state: z.enum(["done", "failed", "stopped", "paused"]),
        result: z.string().max(40_000).optional(),
        error: z.string().max(2_000).optional(),
      })
      .optional(),
    refs: z.array(z.string().max(100)).max(100).default([]),
    remind: z
      .string()
      .startsWith("chs_")
      .max(64)
      .optional()
      .describe("Tell the person this change set is still waiting"),
  }),
  output: z.object({ state: z.enum(JOB_STATES) }),
  permission: "records:read",
  risk: "write",
  actors: ["human"],
  bookkeeping: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    // Only the job's own object: adapters set the origin, so a person's call is `ui` and cannot
    // rewrite their job's counters or state.
    if (ctx.origin.surface !== "system" || ctx.origin.jobId !== input.jobId) {
      throw new ForbiddenError("Only the agent's own object reports on it");
    }
    const row = await ownJob(ctx, input.jobId);
    const stopped = row.state === "stopped" || row.state === "cancelled";
    const end = input.end && !stopped ? input.end : undefined;
    ctx.write(
      ctx.db
        .updateTable("core_agent_job")
        .set({
          steps: input.steps,
          spent_microusd: input.spentMicrousd,
          fields_filled: input.fieldsFilled,
          updated_at: ctx.now,
          ...(end
            ? {
                state: end.state,
                ...(end.result !== undefined ? { result: end.result } : {}),
                ...(end.error !== undefined ? { error: end.error } : {}),
                ...(end.state === "paused" ? {} : { finished_at: ctx.now }),
              }
            : stopped && input.end?.result !== undefined
              ? { result: input.end.result }
              : {}),
        })
        .where("id", "=", row.id),
    );
    if (input.refs.length) {
      for (let i = 0; i < input.refs.length; i += 40) {
        ctx.write(
          ctx.db
            .insertInto("core_agent_job_refs")
            .values(input.refs.slice(i, i + 40).map((ref) => ({ job_id: row.id, ref })))
            .onConflict((oc) => oc.doNothing()),
        );
      }
    }
    if (input.remind) {
      const changeSetId = input.remind;
      const plan = await notifyStatements(
        ctx.db,
        {
          to: [{ userId: row.user_id }],
          type: "approval.pending",
          title: `${row.title} has changes waiting for you`,
          body: "Review them in the Approvals inbox.",
          link: { kind: "approval", changeSetId },
          dedupeKey: `agent-review:${row.id}:${ctx.now.slice(0, 10)}`,
          source: { actor: "assistant", userId: row.user_id },
        },
        ctx.now,
      );
      ctx.write(...plan.statements);
    }
    const state = end?.state ?? row.state;
    if (!isFinishedState(state) && state !== "paused") return { state };
    const host = ctx.agentJobs;
    return ctx.afterCommit(async () => {
      await dispatchAgentJobs(ctx.pipeline.crm, host, ctx.now);
      return { state };
    });
  },
});

const agentSettingsOutput = agentSettingsSchema.extend({ defaults: agentSettingsSchema });

export const agentSettings = defineOperation({
  name: "agent.settings",
  description:
    "The limits on agents: how many run at once per person and per workspace, the default step, " +
    "time and spend budgets, how long the assistant waits for an awaited agent, and how often " +
    "people are reminded of changes to review. Read-only.",
  input: z.object({}),
  output: agentSettingsOutput,
  permission: "records:read",
  risk: "read",
  mcp: { expose: false },
  async handler(_input, ctx) {
    return { ...(await loadAgentSettings(ctx.db)), defaults: DEFAULT_AGENT_SETTINGS };
  },
});

export const agentUpdateSettings = defineOperation({
  name: "agent.updateSettings",
  description: "Set the limits on agents (admins). Jobs already running keep their budgets.",
  input: agentSettingsSchema,
  output: agentSettingsSchema,
  permission: "settings:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const before = await loadAgentSettings(ctx.db);
    const value = JSON.stringify(input);
    ctx.write(
      ctx.db
        .insertInto("core_settings")
        .values({ key: AGENT_SETTINGS, value, updated_at: ctx.now, updated_by: ctx.user.id })
        .onConflict((oc) =>
          oc.column("key").doUpdateSet({ value, updated_at: ctx.now, updated_by: ctx.user.id }),
        ),
    );
    ctx.recordChange({
      object: "agent_settings",
      id: AGENT_SETTINGS,
      action: "update",
      before: { ...before },
      after: { ...input },
    });
    return input;
  },
});

const profileSchema = z.object({
  name: z.string(),
  label: z.string(),
  description: z.string(),
  role: z.enum(MODEL_ROLES),
  operations: z.array(z.string()),
  caps: grantCapsSchema,
  expiresInHours: z.number(),
  budget: budgetSchema,
  source: z.string(),
});

function profileView(profile: AgentProfile): z.input<typeof profileSchema> {
  return {
    name: profile.name,
    label: profile.label,
    description: profile.description,
    role: profile.role ?? "assistant.subagent",
    operations: [...profile.defaultGrant.operations],
    caps: profile.defaultGrant.caps,
    expiresInHours: profile.defaultGrant.expiresInHours,
    budget: profile.budget,
    source: profile.source,
  };
}

export const agentProfileList = defineOperation({
  name: "agentProfile.list",
  description:
    "The kinds of agent you can start by name: what each is for, what it can do by default, its " +
    "budget and its model role. Shipped ones and any a plugin added. Read-only.",
  input: z.object({}),
  output: z.object({ items: z.array(profileSchema) }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler() {
    return { items: agentProfiles.list().map(profileView) };
  },
});

export const agentProfileGet = defineOperation({
  name: "agentProfile.get",
  description: "One agent profile by name, with its instructions. Read-only.",
  input: z.object({ name: z.string().min(1).max(120) }),
  output: profileSchema.extend({ instructions: z.string() }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input) {
    const profile = agentProfiles.get(input.name);
    if (!profile) throw new NotFoundError("agent profile", input.name);
    return { ...profileView(profile), instructions: profile.instructions };
  },
});

export const agentOperations = [
  agentStart,
  agentStop,
  agentStatus,
  agentAllowSpend,
  agentConfirmGrant,
  agentProgress,
  agentReport,
  agentSettings,
  agentUpdateSettings,
  agentProfileList,
  agentProfileGet,
] as const;
