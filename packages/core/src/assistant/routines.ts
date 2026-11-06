// Personal routines (ADR 0343): proactive work the person asked for, on the automation engine. A
// routine is a core_automations row with `scope = 'personal'` and an owner, so the dispatcher, the
// kill switch, the rails and run history all apply, plus a core_routine row with what only a
// routine has. Its one step, "message me in my chat", is host code: there is no extension.
//
//   trigger ─► plain gates ─► Jev gates ─► (AutomationWorkflow) ─► queue ─► ros-app ─► the thread
//
// Gates run cheapest first and all before any model call. The person's words stay on the row for
// the why panel. In chat nothing here is called a routine: the read-back and the why panel are
// written in outcomes, and the model is told the same (prompt.ts).
import { type A2uiPart, prepareCard } from "@relationship-os/agent-a2ui";
import type { MessagePart } from "@relationship-os/agent-core";
import type { CoreDatabase } from "@relationship-os/db";
import {
  type AutomationManifest,
  automationConditionSchema,
  automationTriggerSchema,
  type ViewFilter,
} from "@relationship-os/sdk";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import { parseCron, shortestCronGap } from "../automations/cron.ts";
import { idsMatchingConditions, type TriggerRecord, titleOf } from "../automations/records.ts";
import { triggerText } from "../automations/summary.ts";
import { ValidationError } from "../errors.ts";
import { refreshSchemaRegistry } from "../extensions/schema.ts";
import { getObject } from "../fields/index.ts";
import { compileFilter, type Filter } from "../filter.ts";
import { askRoutineGate, routineGateState } from "../judge/questions/routine-gate.ts";
import { type Judge, placementAvailable } from "../judge/types.ts";
import type { HandlerContext } from "../operation.ts";
import { summaryContext } from "../operations/automation.ts";
import { resolveRelative } from "../relative.ts";
import { ROUTINE_WHY_NOTICE, type RoutineCheckView, type RoutineWhy } from "./events.ts";
import { filterInWords } from "./memory.ts";
import { producers } from "./producers.ts";
import { type ConversationScrub, mentions, scrubPattern, scrubValue } from "./scrub.ts";
import { routineSkills } from "./skills.ts";

/** The `extension_id` of every routine: it names no extension (ADR 0343). */
export const ROUTINE_EXTENSION = "routine";
/** core_settings: the shortest gap between a schedule's runs, in minutes (admin setting). */
export const ROUTINE_MIN_INTERVAL_SETTING = "routines.minIntervalMinutes";
export const DEFAULT_ROUTINE_MIN_INTERVAL = 15;
/** Each person keeps at most this many (My routines shows them all on one page). */
export const ROUTINE_MAX_PER_USER = 30;
export const automationIdOf = (routineId: string) => `${ROUTINE_EXTENSION}.${routineId}`;
export const isRoutineAutomation = (automationId: string) =>
  automationId.startsWith(`${ROUTINE_EXTENSION}.`);

// ---------------------------------------------------------------------------------------------
// The definition

const TRIGGERS = ["schedule", "record", "fieldChanged", "dateRelative", "syncEvent"] as const;

const existsSchema = z.object({
  object: z.string().min(1).max(80).describe("The record type, such as task or deals.deal"),
  filter: automationConditionSchema.describe("The view filter shape; values may be $relative"),
});

const messageSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("producer"),
    producer: z.string().min(1).max(120).describe("A saved card's name"),
    input: z.record(z.string(), z.unknown()).default({}),
  }),
  z.object({
    kind: z.literal("skill"),
    skill: z.string().min(1).max(120).describe("A skill's name"),
  }),
  z.object({
    kind: z.literal("turn"),
    prompt: z.string().trim().min(3).max(1_000).describe("What to write, for a short model turn"),
  }),
  z.object({
    kind: z.literal("agent"),
    brief: z.string().trim().min(3).max(2_000).describe("What the agent should do"),
    profile: z.string().max(120).optional(),
  }),
]);

export const routineDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(80).describe('A short name, such as "Morning briefing"'),
  what: z
    .string()
    .trim()
    .min(3)
    .max(300)
    .describe(`Finishes "I'll …": "send you your open deals with no activity for 14 days"`),
  trigger: automationTriggerSchema.describe(
    "schedule { cron } in the workspace timezone, record { object, on }, fieldChanged, " +
      "dateRelative or syncEvent { event } (for example email.received)",
  ),
  conditions: automationConditionSchema
    .optional()
    .describe("Plain check on the record that triggered it (the view filter shape)"),
  exists: z
    .array(existsSchema)
    .min(1)
    .max(4)
    .optional()
    .describe("Plain check for a schedule: at least one record matches one of these"),
  checks: z
    .array(z.object({ question: z.string().trim().min(3).max(200) }))
    .max(3)
    .default([])
    .describe('Typed checks in the person\'s words over the event: "the email sounds keen"'),
  message: messageSchema,
  quietWhenEmpty: z.boolean().default(true).describe("Send nothing when a saved card is empty"),
});
export type RoutineDefinition = z.infer<typeof routineDefinitionSchema>;
export type RoutineDefinitionInput = z.input<typeof routineDefinitionSchema>;

/** Starts an agent from a routine's message step. W5 registers it (ADR 0344). */
export type RoutineAgentStarter = (input: {
  userId: string;
  brief: string;
  profile?: string | undefined;
}) => Promise<{ text: string }>;

let agentStarter: RoutineAgentStarter | null = null;

/** The hook W5 fills, so a routine can start an agent. Until then that step is refused. */
export function registerRoutineAgentStarter(starter: RoutineAgentStarter | null): void {
  agentStarter = starter;
}

export function routineAgentStarter(): RoutineAgentStarter | null {
  return agentStarter;
}

function fail(message: string, field: string): never {
  throw new ValidationError(message, { field });
}

/** The shortest gap a schedule may have, in minutes. */
export async function routineMinInterval(db: Kysely<CoreDatabase>): Promise<number> {
  const row = await db
    .selectFrom("core_settings")
    .select("value")
    .where("key", "=", ROUTINE_MIN_INTERVAL_SETTING)
    .executeTakeFirst();
  try {
    const value = row ? (JSON.parse(row.value) as unknown) : null;
    return typeof value === "number" && value >= DEFAULT_ROUTINE_MIN_INTERVAL
      ? value
      : DEFAULT_ROUTINE_MIN_INTERVAL;
  } catch {
    return DEFAULT_ROUTINE_MIN_INTERVAL;
  }
}

function assertFilter(object: string, filter: ViewFilter, field: string, ownerId: string): void {
  const def = getObject(object);
  if (!def) fail(`Unknown record type "${object}"`, field);
  const now = new Date().toISOString();
  compileFilter(def, resolveRelative(filter, ownerId, now) as Filter, "r");
}

const triggerObjectOf = (definition: RoutineDefinition): string | null => {
  const t = definition.trigger;
  if (t.type === "syncEvent") return "activity";
  return "object" in t ? (t.object ?? null) : null;
};

/**
 * Everything that makes a definition refused: the words, the trigger, a schedule under the
 * minimum interval, filters that do not fit their records, what it sends, and typed checks where
 * they cannot run. The same whether it is drafted, turned on or changed.
 */
export async function assertRoutine(
  ctx: Pick<HandlerContext, "db" | "judge" | "now"> & { user: { id: string } },
  definition: RoutineDefinition,
): Promise<void> {
  const { trigger, message } = definition;
  if (/\broutines?\b/i.test(`${definition.name} ${definition.what}`)) {
    fail(`Say what it does for the person, in plain words, without the word "routine"`, "name");
  }
  if (!(TRIGGERS as readonly string[]).includes(trigger.type)) {
    fail(`It can run on ${TRIGGERS.join(", ")}, not ${trigger.type}`, "trigger");
  }
  await refreshSchemaRegistry(ctx.db);
  if (trigger.type === "schedule") {
    try {
      parseCron(trigger.cron);
    } catch (error) {
      fail(error instanceof Error ? error.message : "That schedule cannot be read", "trigger.cron");
    }
    const min = await routineMinInterval(ctx.db);
    const gap = shortestCronGap(trigger.cron, ctx.now.slice(0, 10));
    if (gap !== null && gap < min) {
      fail(
        `That would run every ${gap} minutes. The shortest gap allowed is ${min} minutes.`,
        "trigger.cron",
      );
    }
    if (definition.conditions) {
      fail("A schedule has no record to check: use exists instead of conditions", "conditions");
    }
    if (definition.checks.length && !definition.exists) {
      fail("A typed check needs something to read: add exists, or use another trigger", "checks");
    }
  } else if (definition.exists) {
    fail("exists is for a schedule: use conditions on the record that triggered it", "exists");
  }
  const object = triggerObjectOf(definition);
  if (definition.conditions && object) {
    assertFilter(object, definition.conditions, "conditions", ctx.user.id);
  }
  for (const source of definition.exists ?? []) {
    assertFilter(source.object, source.filter, "exists", ctx.user.id);
  }
  if (definition.checks.length && !(await placementAvailable(ctx.judge, "routine.gate"))) {
    fail("Typed checks are not available on this deployment. Use plain checks only.", "checks");
  }
  switch (message.kind) {
    case "producer":
      if (!producers.get(message.producer)) {
        fail(`There is no saved card called ${message.producer}`, "message.producer");
      }
      break;
    case "skill":
      if (!routineSkills.get(message.skill)) {
        fail(`There is no skill called ${message.skill}`, "message.skill");
      }
      break;
    case "agent":
      if (!agentStarter) fail("Starting an agent from this is not available yet", "message");
      break;
    default:
  }
}

/** The automation a routine runs as. Its one step is declared so the engine's views stay true. */
export function routineSpec(definition: RoutineDefinition): AutomationManifest {
  return {
    label: definition.name,
    description: definition.what,
    trigger: definition.trigger,
    ...(definition.conditions ? { conditions: definition.conditions } : {}),
    steps: [{ name: "message me", label: "Message me in my chat" }],
    // A personal message is never a burst: anything faster than this is a broad trigger.
    rails: { maxRunsPerMinute: 6 },
  };
}

// ---------------------------------------------------------------------------------------------
// In words

/** "Weekdays at 8:00", from the same words automations use. */
export function routineWhen(definition: RoutineDefinition, timezone: string): string {
  return triggerText(routineSpec(definition), summaryContext(timezone));
}

/** The plain gates in words, in the order they run. */
export function plainGateWords(definition: RoutineDefinition): string[] {
  const object = triggerObjectOf(definition);
  const words: string[] = [];
  if (definition.conditions && object) {
    const def = getObject(object);
    if (def) words.push(filterInWords(def, definition.conditions as Filter));
  }
  const sources = (definition.exists ?? []).flatMap((source) => {
    const def = getObject(source.object);
    return def ? [filterInWords(def, source.filter as Filter)] : [];
  });
  if (sources.length) words.push(`There is at least one of: ${sources.join("; or ")}`);
  return words;
}

export interface RoutineBacktest {
  days: number;
  /** How many messages it would have sent. */
  fired: number;
  /** One entry per day, oldest first: would it have sent anything that day? */
  fires: boolean[];
  examples: { text: string; passed: boolean }[];
  /** Deterministic warnings, in plain words. */
  flags: { code: "no_data" | "broad"; text: string }[];
  /** How the number was reached, when that matters to reading it. */
  note?: string | undefined;
}

export interface ReadBackOptions {
  draftId: string;
  timezone: string;
  /** What the person said, by code, never by a model. */
  asked: string | null;
  askedAt: string;
  /** Turning it on changes this routine instead of making a new one. */
  replaces?: string | undefined;
  backtest: RoutineBacktest;
}

/** "Every weekday at 8:00, I'll … If there is nothing to send, I won't message you." */
export function routineSummary(definition: RoutineDefinition, timezone: string): string {
  const quiet =
    definition.message.kind === "producer" && definition.quietWhenEmpty
      ? " If there is nothing to send, I won't message you."
      : "";
  return `${routineWhen(definition, timezone)}, I'll ${definition.what}.${quiet}`.slice(0, 500);
}

/** The read-back card (a host card: its buttons run as the person, who turns it on). */
export function routineReadBack(definition: RoutineDefinition, options: ReadBackOptions): A2uiPart {
  const { backtest } = options;
  const turnOn = options.replaces
    ? {
        kind: "operation" as const,
        label: "Save changes",
        style: "primary" as const,
        operation: "routine.update",
        input: { id: options.replaces, definition },
        done: "Saved",
      }
    : {
        kind: "operation" as const,
        label: "Turn on",
        style: "primary" as const,
        operation: "routine.create",
        input: {
          draftId: options.draftId,
          definition,
          ...(options.asked ? { asked: options.asked, askedAt: options.askedAt } : {}),
        },
        done: "Turned on. You can pause it any time.",
      };
  return prepareCard(
    {
      a2ui: 1,
      root: {
        type: "routineReadBack",
        title: definition.name,
        summary: routineSummary(definition, options.timezone),
        trigger: routineWhen(definition, options.timezone),
        gates: [
          ...plainGateWords(definition).map((text) => ({
            kind: "plain" as const,
            text: text.slice(0, 300),
          })),
          ...definition.checks.map((c) => ({ kind: "jev" as const, text: c.question })),
        ],
        backtest: {
          days: backtest.days,
          fired: backtest.fired,
          fires: backtest.fires,
          examples: backtest.examples,
        },
        notes: [...backtest.flags.map((f) => f.text), ...(backtest.note ? [backtest.note] : [])],
        actions: [
          turnOn,
          {
            kind: "reply",
            label: "Change it",
            style: "secondary",
            text: `I'd like to change "${definition.name}"`,
          },
          { kind: "reply", label: "Cancel", style: "ghost", text: "No thanks, leave it" },
        ],
      },
    },
    { source: "host", text: routineSummary(definition, options.timezone) },
  );
}

// ---------------------------------------------------------------------------------------------
// The gates

export interface RoutineCheck extends RoutineCheckView {
  kind: "plain" | "jev";
}

export interface RoutineCheckResult {
  pass: boolean;
  checks: RoutineCheck[];
  /** Why it stopped, when it did. */
  reason?: string | undefined;
  /** What the judge cost, for its spend count. */
  judge: { calls: number; inputTokens: number };
}

/** Titles of records matching `sources` at `now`, and how many there are (at most `limit`). */
export async function matchingRecords(
  db: Kysely<CoreDatabase>,
  sources: readonly z.infer<typeof existsSchema>[],
  ownerId: string,
  now: string,
  limit = 20,
): Promise<string[]> {
  const titles: string[] = [];
  for (const source of sources) {
    const def = getObject(source.object);
    if (!def) continue;
    const filter = resolveRelative(source.filter, ownerId, now) as Filter;
    const where = compileFilter(def, filter, "r");
    const created = def.fields.find((f) => f.name === "createdAt")?.column;
    const rows = await sql<Record<string, unknown>>`
      SELECT r.* FROM ${sql.table(def.source)} AS r
      WHERE ${where} ${created ? sql`AND r.${sql.ref(created)} <= ${now}` : sql``}
      LIMIT ${limit}
    `.execute(db);
    for (const row of rows.rows) titles.push(titleOf(def, row) ?? def.label);
  }
  return titles;
}

/** An event as the judge reads it: the record's title and fields, bounded. */
export function routineEventText(record: Pick<TriggerRecord, "title" | "data"> | null): string {
  if (!record) return "";
  const fields = Object.entries(record.data)
    .filter(([key, value]) => key !== "id" && value !== null && value !== "")
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  return [record.title, ...fields].filter(Boolean).join("\n");
}

/**
 * The gates of one event, cheapest first: plain conditions on its record, then "at least one of"
 * for a schedule, then each typed check. It stops at the first that fails, so a plain miss never
 * reaches the judge. A check the judge cannot answer does not pass.
 */
export async function runRoutineChecks(input: {
  db: Kysely<CoreDatabase>;
  judge: Judge | undefined;
  ownerId: string;
  definition: RoutineDefinition;
  record: {
    object: string;
    id: string;
    title: string | null;
    data: Record<string, unknown>;
  } | null;
  now: string;
}): Promise<RoutineCheckResult> {
  const { db, definition, record, ownerId, now } = input;
  await refreshSchemaRegistry(db);
  const checks: RoutineCheck[] = [];
  const judge = { calls: 0, inputTokens: 0 };
  const stop = (reason: string): RoutineCheckResult => ({ pass: false, checks, reason, judge });
  const words = plainGateWords(definition);
  let event = routineEventText(record);

  if (definition.conditions) {
    const text = words.shift() ?? "Plain check";
    const passed = record
      ? (
          await idsMatchingConditions(db, record.object, [record.id], definition.conditions, {
            userId: ownerId,
            now,
          })
        ).has(record.id)
      : false;
    checks.push({ kind: "plain", text, passed });
    if (!passed) return stop("The record did not match");
  }
  if (definition.exists) {
    const text = words.shift() ?? "There is something to send";
    const titles = await matchingRecords(db, definition.exists, ownerId, now);
    checks.push({ kind: "plain", text, passed: titles.length > 0 });
    if (!titles.length) return stop("There was nothing to send");
    event = titles.join("\n");
  }
  for (const { question } of definition.checks) {
    const state = routineGateState({ check: question, event });
    const asked = input.judge
      ? await askRoutineGate(input.judge, state)
      : ({ status: "failed", reason: "off" } as const);
    if (asked.status === "failed") {
      checks.push({ kind: "jev", text: question, passed: false, unavailable: true });
      return stop("A check could not be made");
    }
    judge.calls += 1;
    judge.inputTokens += asked.inputTokens;
    checks.push({ kind: "jev", text: question, passed: asked.passed });
    if (!asked.passed) return stop("A check did not pass");
  }
  return { pass: true, checks, judge };
}

// ---------------------------------------------------------------------------------------------
// Rows

export interface RoutineRow {
  id: string;
  automation_id: string;
  owner_user_id: string;
  name: string;
  what: string;
  asked: string | null;
  asked_at: string | null;
  definition: string;
  paused_until: string | null;
  last_delivered_at: string | null;
  last_error: string | null;
  enabled: number;
  paused_reason: string | null;
  created_at: string;
}

export const ROUTINE_COLUMNS = [
  "r.id",
  "r.automation_id",
  "r.owner_user_id",
  "r.name",
  "r.what",
  "r.asked",
  "r.asked_at",
  "r.definition",
  "r.paused_until",
  "r.last_delivered_at",
  "r.last_error",
  "a.enabled",
  "a.paused_reason",
  "r.created_at",
] as const;

export function routinesQuery(db: Kysely<CoreDatabase>) {
  return db
    .selectFrom("core_routine as r")
    .innerJoin("core_automations as a", "a.id", "r.automation_id")
    .select([...ROUTINE_COLUMNS]);
}

export function parseDefinition(json: string): RoutineDefinition | null {
  try {
    const parsed = routineDefinitionSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface RoutineRunReport {
  routine: { checks: RoutineCheck[]; reason?: string | undefined };
}

/** What a run's `report` holds for a routine: the checks it made. */
export function routineRunChecks(report: string | null): RoutineCheck[] {
  try {
    return report ? ((JSON.parse(report) as RoutineRunReport).routine?.checks ?? []) : [];
  } catch {
    return [];
  }
}

/** The why panel of one delivery, in plain facts: no scores. */
export function routineWhy(
  row: Pick<RoutineRow, "id" | "name" | "asked" | "asked_at" | "definition">,
  input: {
    runId: string | null;
    at: string;
    timezone: string;
    checks: readonly RoutineCheck[];
    record?: { title: string | null } | null | undefined;
    test?: boolean | undefined;
  },
): RoutineWhy {
  const definition = parseDefinition(row.definition);
  return {
    routineId: row.id,
    runId: input.runId,
    name: row.name,
    asked: row.asked,
    askedAt: row.asked_at,
    when: definition ? routineWhen(definition, input.timezone) : row.name,
    at: input.at,
    ...(input.record?.title ? { about: input.record.title } : {}),
    checks: input.checks
      .filter((c) => c.kind === "plain")
      .map(({ text, passed }) => ({ text, passed })),
    jev: input.checks.filter((c) => c.kind === "jev").map(({ text, passed }) => ({ text, passed })),
    ...(input.test ? { test: true } : {}),
  };
}

const RECORD_PATHS: Record<string, (id: string) => string> = {
  person: (id) => `/people/${id}`,
  organisation: (id) => `/organisations/${id}`,
  task: () => "/tasks",
  activity: () => "/activity",
};

/** The buttons a delivery carries beside the thing itself: Open, Snooze, Create task. */
export function routineActions(
  routineId: string,
  input: {
    now: string;
    record?: { object: string; id: string; title: string | null } | null | undefined;
  },
): A2uiPart | null {
  const { record } = input;
  const tomorrow = new Date(Date.parse(input.now) + 86_400_000).toISOString();
  const open = record
    ? {
        kind: "open" as const,
        label: "Open",
        style: "secondary" as const,
        href: (RECORD_PATHS[record.object] ?? ((id: string) => `/x/${record.object}/${id}`))(
          record.id,
        ),
      }
    : null;
  const task =
    record && (record.object === "person" || record.object === "organisation")
      ? {
          kind: "operation" as const,
          label: "Create task",
          style: "secondary" as const,
          operation: "task.create",
          input: {
            title: `Follow up: ${record.title ?? "this record"}`.slice(0, 200),
            links: [{ object: record.object, id: record.id }],
          },
          done: "Task created",
        }
      : null;
  const snooze = {
    kind: "operation" as const,
    label: "Snooze",
    style: "ghost" as const,
    operation: "routine.pause",
    input: { id: routineId, until: tomorrow },
    done: "Snoozed until tomorrow",
  };
  return prepareCard(
    { a2ui: 1, root: { type: "actions", actions: [open, snooze, task].filter(Boolean) } },
    { source: "host", text: "Snooze" },
  );
}

/** The run a stored message was delivered for, if it was. */
export function routineRunOf(parts: readonly MessagePart[]): string | null {
  for (const part of parts) {
    if (part.type === "notice" && part.kind === ROUTINE_WHY_NOTICE) {
      return (part.data as RoutineWhy | undefined)?.runId ?? null;
    }
  }
  return null;
}

/** A saved card with nothing in it: a routine that stays quiet sends nothing. */
export function isEmptyCard(part: A2uiPart): boolean {
  return (part.document?.root as { type?: string } | undefined)?.type === "emptyState";
}

// ---------------------------------------------------------------------------------------------
// Erase (ADR 0320)

/**
 * Routines whose words or filters name the erased subject lose those mentions, in the routine and
 * in its automation's spec, and pause: a filter that named someone matches nothing useful now. A
 * person holds at most ROUTINE_MAX_PER_USER, so this reads them all and matches in code, which
 * also catches a name in the person's own words.
 */
export async function queueEraseRoutines(
  ctx: HandlerContext,
  scrub: ConversationScrub,
): Promise<number> {
  const pattern = scrubPattern(scrub);
  if (!pattern) return 0;
  const rows = await ctx.db
    .selectFrom("core_routine as r")
    .innerJoin("core_automations as a", "a.id", "r.automation_id")
    .select(["r.id", "r.automation_id", "r.name", "r.what", "r.asked", "r.definition", "a.spec"])
    .execute();
  let count = 0;
  for (const row of rows) {
    if (!mentions(row, pattern)) continue;
    count += 1;
    const clean = scrubValue(
      { name: row.name, what: row.what, asked: row.asked, definition: row.definition },
      pattern,
    );
    ctx.write(
      ctx.db
        .updateTable("core_routine")
        .set({ ...clean, updated_at: ctx.now })
        .where("id", "=", row.id),
    );
    ctx.write(
      ctx.db
        .updateTable("core_automations")
        .set({
          label: clean.name,
          spec: scrubValue(row.spec, pattern),
          paused_reason: "It named someone who was erased",
          paused_at: ctx.now,
          updated_at: ctx.now,
        })
        .where("id", "=", row.automation_id),
    );
  }
  return count;
}
