// routine.* operations (ADR 0343): what a person asked their assistant to do on its own. The
// assistant drafts one and shows the read-back; the person turns it on with a button, so
// `routine.create` and `routine.update` are people's only. A routine belongs to its owner: every
// operation here is scoped to ctx.user, and automation.* does not show them.
//
// These never queue for review (`bookkeeping`): a routine reads and messages its owner, and the
// owner confirms it themselves.

import { a2uiPartSchema } from "@relationship-os/agent-a2ui";
import { z } from "zod";
import { CARD_STATUS } from "../assistant/events.ts";
import { BACKTEST_DAYS, backtestRoutine } from "../assistant/routine-backtest.ts";
import {
  assertRoutine,
  DEFAULT_ROUTINE_MIN_INTERVAL,
  parseDefinition,
  plainGateWords,
  queueDeleteRoutine,
  queueInsertRoutine,
  queueUpdateRoutine,
  ROUTINE_MAX_PER_USER,
  ROUTINE_MIN_INTERVAL_SETTING,
  type RoutineDefinition,
  type RoutineRow,
  routineDefinitionSchema,
  routineMinInterval,
  routineReadBack,
  routinesQuery,
  routineWhen,
  routineWhy,
  runRoutineChecks,
} from "../assistant/routines.ts";
import { nextCronFire, zonedTime } from "../automations/cron.ts";
import { loadTriggerRecord } from "../automations/records.ts";
import { loadAutomationSettings } from "../automations/registry.ts";
import { ConfigError, NotFoundError, ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { judgeUsageStatement } from "../judge/usage.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { assertNotLocked } from "../plugins/resolve.ts";

const routineId = z
  .string()
  .regex(/^rtn_[0-9A-Za-z]{10,40}$/)
  .describe("A routine's id (rtn_…)");

const statusSchema = z.enum(["on", "paused", "failing"]);

const routineSchema = z.object({
  id: z.string(),
  name: z.string(),
  what: z.string(),
  status: statusSchema,
  /** Why it is paused or failing, in plain words. */
  statusReason: z.string().nullable(),
  when: z.string(),
  gates: z.array(z.string()),
  checks: z.array(z.string()),
  asked: z.string().nullable(),
  askedAt: z.string().nullable(),
  pausedUntil: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastDeliveredAt: z.string().nullable(),
  /** The next scheduled run; null for a routine that waits for an event. */
  nextRunAt: z.string().nullable(),
  /** The schedule, for the edit form. */
  cron: z.string().nullable(),
});
export type RoutineView = z.infer<typeof routineSchema>;

const backtestSchema = z.object({
  days: z.number(),
  fired: z.number(),
  fires: z.array(z.boolean()),
  examples: z.array(z.object({ text: z.string(), passed: z.boolean() })),
  flags: z.array(z.object({ code: z.enum(["no_data", "broad"]), text: z.string() })),
  note: z.string().optional(),
});

function statusOf(
  row: RoutineRow,
  now: string,
): { status: RoutineView["status"]; reason: string | null } {
  if (!row.enabled) return { status: "paused", reason: null };
  if (row.paused_reason) return { status: "paused", reason: row.paused_reason };
  if (row.paused_until && row.paused_until > now) {
    return { status: "paused", reason: "Snoozed" };
  }
  if (row.last_error) return { status: "failing", reason: row.last_error };
  return { status: "on", reason: null };
}

/** A local `YYYY-MM-DDTHH:MM` in `timezone`, as the instant it names. */
function instantOf(local: string, timezone: string): string {
  const guess = new Date(`${local}:00Z`);
  const shown = zonedTime(guess, timezone);
  const offset = Date.parse(`${shown.minuteKey}:00Z`) - guess.getTime();
  return new Date(guess.getTime() - offset).toISOString();
}

function toView(
  row: RoutineRow,
  input: { now: string; timezone: string; lastRunAt: string | null },
): RoutineView {
  const definition = parseDefinition(row.definition);
  const { status, reason } = statusOf(row, input.now);
  const cron = definition?.trigger.type === "schedule" ? definition.trigger.cron : null;
  const next =
    cron && status !== "paused"
      ? nextCronFire(cron, zonedTime(new Date(input.now), input.timezone).minuteKey)
      : null;
  return {
    id: row.id,
    name: row.name,
    what: row.what,
    status,
    statusReason: reason,
    when: definition ? routineWhen(definition, input.timezone) : row.name,
    gates: definition ? plainGateWords(definition) : [],
    checks: definition?.checks.map((c) => c.question) ?? [],
    asked: row.asked,
    askedAt: row.asked_at,
    pausedUntil: row.paused_until,
    lastRunAt: input.lastRunAt,
    lastDeliveredAt: row.last_delivered_at,
    nextRunAt: next ? instantOf(next, input.timezone) : null,
    cron,
  };
}

async function lastRuns(ctx: HandlerContext, automationIds: string[]) {
  if (!automationIds.length) return new Map<string, string>();
  const rows = await ctx.db
    .selectFrom("core_automation_runs")
    .select(["automation_id", (eb) => eb.fn.max("started_at").as("at")])
    .where("automation_id", "in", automationIds)
    .where("test", "=", 0)
    .groupBy("automation_id")
    .execute();
  return new Map(rows.map((r) => [r.automation_id, r.at as string]));
}

async function ownRow(ctx: HandlerContext, id: string): Promise<RoutineRow> {
  const row = (await routinesQuery(ctx.db)
    .where("r.id", "=", id)
    .where("r.owner_user_id", "=", ctx.user.id)
    .executeTakeFirst()) as RoutineRow | undefined;
  if (!row) throw new NotFoundError("routine", id);
  return row;
}

async function viewOf(ctx: HandlerContext, row: RoutineRow): Promise<RoutineView> {
  const { timezone } = await loadAutomationSettings(ctx.db);
  const last = await lastRuns(ctx, [row.automation_id]);
  return toView(row, {
    now: ctx.now,
    timezone,
    lastRunAt: last.get(row.automation_id) ?? null,
  });
}

function countSpend(ctx: HandlerContext, judge: { calls: number; inputTokens: number }) {
  if (judge.calls) ctx.write(judgeUsageStatement(ctx.db, "routine.gate", judge, ctx.now));
}

const DRAFT_DESCRIPTION = `Offer to do something for the person on their own schedule or when something happens: a morning briefing, a weekly summary, telling them when an email comes in. It tries the idea on the last ${BACKTEST_DAYS} days and shows a read-back card; the person turns it on with a button, so it does nothing until they do. Say what you would do in outcomes ("Do you want me to send you a morning briefing?"). After it, add at most one short sentence.

definition:
- name: "Morning briefing". what: finishes "I'll …", such as "send you your open deals with no activity for 14 days".
- trigger: { type: "schedule", cron: "0 8 * * 1-5" } (5 fields, in the workspace timezone, at least 15 minutes apart), or { type: "record", object, on: ["created"] }, { type: "fieldChanged", object, field, to }, { type: "dateRelative", object, field, offsetDays }, { type: "syncEvent", event: "email.received" }.
- conditions: plain check on the triggering record, the view filter shape. exists: for a schedule, [{ object, filter }]: it runs only when at least one record matches. Filter values may be { "$relative": "me" | "now" | "today" | "tomorrow" }.
- checks: [{ question }]: a check in the person's words over the event, such as "the email sounds keen to go ahead", for what a filter cannot say. Refused where they are not available: then use plain checks.
- message: { kind: "producer", producer, input } for a saved card (fastest, no model), { kind: "skill", skill } or { kind: "turn", prompt } for a short written message.
- replaces: pass a routine's id to change it instead of adding one.`;

const cardOutput = z.object({
  status: z.literal(CARD_STATUS),
  part: a2uiPartSchema,
  backtest: backtestSchema,
});

async function draftCard(ctx: HandlerContext, definition: RoutineDefinition, replaces?: string) {
  await assertRoutine(ctx, definition);
  const { timezone } = await loadAutomationSettings(ctx.db);
  if (replaces) await ownRow(ctx, replaces);
  const { backtest, judge } = await backtestRoutine({
    db: ctx.db,
    judge: ctx.judge,
    ownerId: ctx.user.id,
    definition,
    now: ctx.now,
    timezone,
  });
  countSpend(ctx, judge);
  const part = routineReadBack(definition, {
    draftId: newId("routine"),
    timezone,
    asked: ctx.assistantTurn?.text.slice(0, 500) ?? null,
    askedAt: ctx.now,
    replaces,
    backtest,
  });
  return { status: CARD_STATUS, part, backtest };
}

export const routineDraft = defineOperation({
  name: "routine.draft",
  description: DRAFT_DESCRIPTION,
  input: z.object({
    definition: routineDefinitionSchema,
    replaces: routineId.optional(),
  }),
  output: cardOutput,
  permission: "records:read",
  risk: "write",
  bookkeeping: true,
  actors: ["human", "assistant"],
  mcp: { curated: true, title: "Offer to do this for them", toolName: "offer_standing_help" },
  async handler(input, ctx) {
    return draftCard(ctx, input.definition, input.replaces);
  },
});

/** The first offer (ADR 0343): one concrete thing, in the person's first chat. */
export const MORNING_BRIEFING: RoutineDefinition = {
  name: "Morning briefing",
  what: "send you your meetings for the day and anything overdue",
  trigger: { type: "schedule", cron: "0 8 * * 1-5" },
  exists: [
    {
      object: "task",
      label: "You have a task due or overdue",
      filter: {
        and: [
          { field: "status", op: "eq", value: "open" },
          { field: "assigneeId", op: "eq", value: { $relative: "me" } },
          { field: "dueAt", op: "lt", value: { $relative: "tomorrow" } },
        ],
      },
    },
    {
      object: "activity",
      label: "you have a meeting today",
      filter: {
        and: [
          { field: "type", op: "eq", value: "meeting" },
          { field: "occurredAt", op: "gte", value: { $relative: "today" } },
          { field: "occurredAt", op: "lt", value: { $relative: "tomorrow" } },
        ],
      },
    },
  ],
  checks: [],
  message: { kind: "producer", producer: "briefing.morningCard", input: {} },
  quietWhenEmpty: true,
};

export const routineOffer = defineOperation({
  name: "routine.offer",
  description:
    "Offer the person a morning briefing, as a read-back card they can turn on with a button. " +
    "Use it when the context block says this is your first chat. Takes nothing. Say it in " +
    'outcomes: "Do you want me to send you a morning briefing?".',
  input: z.object({}),
  output: cardOutput,
  permission: "records:read",
  risk: "write",
  bookkeeping: true,
  actors: ["human", "assistant"],
  mcp: { curated: true, title: "Offer a morning briefing", toolName: "offer_morning_briefing" },
  async handler(_input, ctx) {
    return draftCard(ctx, MORNING_BRIEFING);
  },
});

export const routineBacktest = defineOperation({
  name: "routine.backtest",
  description: `Try an idea, or an existing one by id, on the last ${BACKTEST_DAYS} days: how many times it would have messaged the person, examples that pass and fail, and warnings when there is no data or the trigger is very broad. Writes nothing to the CRM.`,
  input: z
    .object({
      definition: routineDefinitionSchema.optional(),
      id: routineId.optional(),
    })
    .refine((v) => Boolean(v.definition) !== Boolean(v.id), "Give a definition or an id"),
  output: backtestSchema,
  permission: "records:read",
  risk: "write",
  bookkeeping: true,
  actors: ["human", "assistant"],
  mcp: { title: "Try it on the last 30 days" },
  async handler(input, ctx) {
    const definition =
      input.definition ??
      parseDefinition((await ownRow(ctx, input.id as string)).definition) ??
      null;
    if (!definition) throw new ValidationError("That cannot be read any more");
    await assertRoutine(ctx, definition);
    const { timezone } = await loadAutomationSettings(ctx.db);
    const { backtest, judge } = await backtestRoutine({
      db: ctx.db,
      judge: ctx.judge,
      ownerId: ctx.user.id,
      definition,
      now: ctx.now,
      timezone,
    });
    countSpend(ctx, judge);
    return backtest;
  },
});

export const routineCreate = defineOperation({
  name: "routine.create",
  description:
    "Turn on what the read-back card showed. People only: this is the card's Turn on button, " +
    "and a model can never do it. Pressing it twice turns it on once.",
  input: z.object({
    draftId: routineId,
    definition: routineDefinitionSchema,
    asked: z.string().max(500).optional(),
    askedAt: z.string().max(40).optional(),
  }),
  output: routineSchema,
  permission: "records:read",
  risk: "write",
  bookkeeping: true,
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const existing = await ctx.db
      .selectFrom("core_routine")
      .select("id")
      .where("draft_id", "=", input.draftId)
      .where("owner_user_id", "=", ctx.user.id)
      .executeTakeFirst();
    if (existing) return viewOf(ctx, await ownRow(ctx, existing.id));
    const { definition } = input;
    await assertRoutine(ctx, definition);
    const count = await ctx.db
      .selectFrom("core_routine")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("owner_user_id", "=", ctx.user.id)
      .executeTakeFirst();
    if (Number(count?.n ?? 0) >= ROUTINE_MAX_PER_USER) {
      throw new ValidationError(
        `You have ${ROUTINE_MAX_PER_USER} already. Delete one in Settings, under My routines.`,
      );
    }
    const row = queueInsertRoutine(ctx, {
      id: input.draftId,
      ownerId: ctx.user.id,
      definition,
      asked: input.asked ?? null,
      askedAt: input.askedAt ?? null,
      draftId: input.draftId,
    });
    const { timezone } = await loadAutomationSettings(ctx.db);
    return toView(
      { ...row, enabled: 1, paused_reason: null },
      {
        now: ctx.now,
        timezone,
        lastRunAt: null,
      },
    );
  },
});

export const routineUpdate = defineOperation({
  name: "routine.update",
  description:
    "Change one of your routines: its whole definition (from a read-back's Save changes), or " +
    "its name or schedule (from My routines). People only.",
  input: z.object({
    id: routineId,
    definition: routineDefinitionSchema.optional(),
    name: z.string().trim().min(1).max(80).optional(),
    cron: z.string().trim().min(9).max(100).optional(),
  }),
  output: routineSchema,
  permission: "records:read",
  risk: "write",
  bookkeeping: true,
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const row = await ownRow(ctx, input.id);
    await assertNotLocked(ctx, "routine", row.id);
    const current = input.definition ?? parseDefinition(row.definition);
    if (!current) throw new ValidationError("That cannot be read any more");
    if (input.cron && current.trigger.type !== "schedule") {
      throw new ValidationError("This one waits for an event, so it has no schedule", {
        field: "cron",
      });
    }
    const definition: RoutineDefinition = {
      ...current,
      ...(input.name ? { name: input.name } : {}),
      ...(input.cron ? { trigger: { type: "schedule", cron: input.cron } } : {}),
    };
    await assertRoutine(ctx, definition);
    const values = queueUpdateRoutine(ctx, row, definition);
    return viewOf(ctx, { ...row, ...values });
  },
});

export const routinePause = defineOperation({
  name: "routine.pause",
  description:
    "Stop one of the person's standing requests for now, or start it again with resume. Give " +
    "until for a snooze (it starts again by itself). call_operation routine.list gives ids.",
  input: z.object({
    id: routineId,
    resume: z.boolean().default(false),
    until: z.string().datetime().optional().describe("Snooze until this time"),
  }),
  output: routineSchema,
  permission: "records:read",
  risk: "write",
  bookkeeping: true,
  actors: ["human", "assistant"],
  mcp: { title: "Pause it" },
  async handler(input, ctx) {
    const row = await ownRow(ctx, input.id);
    const until = input.resume ? null : (input.until ?? null);
    const enabled = input.resume || input.until ? 1 : 0;
    ctx.write(
      ctx.db
        .updateTable("core_automations")
        .set({
          enabled,
          ...(input.resume ? { paused_reason: null, paused_at: null } : {}),
          updated_at: ctx.now,
        })
        .where("id", "=", row.automation_id),
    );
    ctx.write(
      ctx.db
        .updateTable("core_routine")
        .set({
          paused_until: until,
          ...(input.resume ? { last_error: null } : {}),
          updated_at: ctx.now,
        })
        .where("id", "=", row.id),
    );
    return viewOf(ctx, {
      ...row,
      enabled,
      paused_until: until,
      paused_reason: input.resume ? null : row.paused_reason,
      last_error: input.resume ? null : row.last_error,
    });
  },
});

export const routineDelete = defineOperation({
  name: "routine.delete",
  description:
    "Delete one of your routines and its run history. Messages it already sent stay in your " +
    "chat. People only.",
  input: z.object({ id: routineId }),
  output: z.object({ deleted: z.literal(true) }),
  permission: "records:read",
  risk: "write",
  bookkeeping: true,
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const row = await ownRow(ctx, input.id);
    await assertNotLocked(ctx, "routine", row.id);
    queueDeleteRoutine(ctx, row);
    return { deleted: true as const };
  },
});

export const routineList = defineOperation({
  name: "routine.list",
  description:
    "The person's standing requests, with status, schedule, what it checks first, and last and " +
    "next run. Read-only. In chat, describe them by what they do.",
  input: z.object({}),
  output: z.object({
    routines: z.array(routineSchema),
    minIntervalMinutes: z.number(),
  }),
  permission: "records:read",
  risk: "read",
  actors: ["human", "assistant"],
  mcp: { title: "List what you do for them", idempotent: true },
  async handler(_input, ctx) {
    const rows = (await routinesQuery(ctx.db)
      .where("r.owner_user_id", "=", ctx.user.id)
      .orderBy("r.created_at")
      .execute()) as RoutineRow[];
    const { timezone } = await loadAutomationSettings(ctx.db);
    const last = await lastRuns(
      ctx,
      rows.map((r) => r.automation_id),
    );
    return {
      routines: rows.map((row) =>
        toView(row, {
          now: ctx.now,
          timezone,
          lastRunAt: last.get(row.automation_id) ?? null,
        }),
      ),
      minIntervalMinutes: await routineMinInterval(ctx.db),
    };
  },
});

/** The newest record its trigger could have fired on, so a test has something to read. */
async function sampleRecord(ctx: HandlerContext, definition: RoutineDefinition) {
  const t = definition.trigger;
  const object = t.type === "syncEvent" ? "activity" : "object" in t ? (t.object as string) : null;
  if (!object) return null;
  const change = await ctx.db
    .selectFrom("core_audit_changes")
    .select("record_id")
    .where("object_type", "=", object)
    .orderBy("at", "desc")
    .limit(1)
    .executeTakeFirst();
  const record = change ? await loadTriggerRecord(ctx.db, object, change.record_id) : null;
  return record ? { ...record } : null;
}

export const routineTest = defineOperation({
  name: "routine.test",
  description:
    "Try one of your routines now: run its checks and, when they pass, send the message to your " +
    "chat, marked as a test. For a routine that waits for an event it uses the newest record of " +
    "that kind. People only: it can cost a model call.",
  input: z.object({ id: routineId }),
  output: z.object({
    sent: z.boolean(),
    checks: z.array(z.object({ text: z.string(), passed: z.boolean() })),
    reason: z.string().nullable(),
  }),
  permission: "records:read",
  risk: "write",
  bookkeeping: true,
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const row = await ownRow(ctx, input.id);
    const definition = parseDefinition(row.definition);
    if (!definition) throw new ValidationError("That cannot be read any more");
    const record = await sampleRecord(ctx, definition);
    const result = await runRoutineChecks({
      db: ctx.db,
      judge: ctx.judge,
      ownerId: ctx.user.id,
      definition,
      record,
      now: ctx.now,
    });
    countSpend(ctx, result.judge);
    const checks = result.checks.map(({ text, passed }) => ({ text, passed }));
    if (!result.pass) return { sent: false, checks, reason: result.reason ?? null };
    if (!ctx.assistantThreads) {
      throw new ConfigError("The assistant is not available on this deployment");
    }
    await ctx.assistantThreads.deliverRoutine(ctx.user.id, {
      routineId: row.id,
      runId: null,
      test: true,
      checks: result.checks,
      ...(record ? { record: { object: record.object, id: record.id } } : {}),
    });
    return { sent: true, checks, reason: null };
  },
});

export const routineRecordDelivery = defineOperation({
  name: "routine.recordDelivery",
  description:
    "Record what became of a delivery: sent, nothing to send, or failed. Called by the thread " +
    "itself after it delivers.",
  input: z.object({
    id: routineId,
    outcome: z.enum(["delivered", "quiet", "failed"]),
    error: z.string().max(300).optional(),
  }),
  output: z.object({ ok: z.literal(true) }),
  permission: "records:read",
  risk: "write",
  bookkeeping: true,
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    await ownRow(ctx, input.id);
    ctx.write(
      ctx.db
        .updateTable("core_routine")
        .set({
          ...(input.outcome === "delivered" ? { last_delivered_at: ctx.now } : {}),
          last_error: input.outcome === "failed" ? (input.error ?? "It could not be sent") : null,
          updated_at: ctx.now,
        })
        .where("id", "=", input.id),
    );
    return { ok: true as const };
  },
});

const settingsSchema = z.object({
  minIntervalMinutes: z
    .number()
    .int()
    .min(DEFAULT_ROUTINE_MIN_INTERVAL)
    .max(1_440)
    .describe("The shortest gap between a schedule's runs, in minutes"),
});

export const routineUpdateSettings = defineOperation({
  name: "routine.updateSettings",
  description:
    "Set how often people's routines may run on a schedule. Admins. It applies to new and " +
    "changed schedules.",
  input: settingsSchema,
  output: settingsSchema,
  permission: "settings:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const value = JSON.stringify(input.minIntervalMinutes);
    ctx.write(
      ctx.db
        .insertInto("core_settings")
        .values({ key: ROUTINE_MIN_INTERVAL_SETTING, value, updated_at: ctx.now })
        .onConflict((oc) => oc.column("key").doUpdateSet({ value, updated_at: ctx.now })),
    );
    return input;
  },
});

export { routineWhy };

export const routineOperations = [
  routineDraft,
  routineOffer,
  routineBacktest,
  routineCreate,
  routineUpdate,
  routinePause,
  routineDelete,
  routineList,
  routineTest,
  routineRecordDelivery,
  routineUpdateSettings,
] as const;
