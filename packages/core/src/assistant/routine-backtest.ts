// A routine's backtest (ADR 0343): "would have messaged you 6 times in 30 days", with examples that
// pass and fail, from what the workspace holds. It replays the trigger over the last 30 days:
//
//   schedule       every fire of the cron, each day's plain check run as of that day
//   record         the record history (core_audit_changes), plain checks on today's record
//   fieldChanged   as record, keeping the changes the trigger names
//   syncEvent      the emails and meetings on the timeline
//   dateRelative   the records that date fell on
//
// History keeps changes, not whole past records, so plain checks read today's values. A date-based
// check still moves with each day of a schedule. Typed checks cost a call each, so they run only on
// the newest few events, and the card says the count is from before them. Deterministic flags say
// when there is no data, or when the trigger is very broad.
import type { CoreDatabase } from "@relationship-os/db";
import { type Kysely, sql } from "kysely";
import { addDaysToDate, cronFires, zonedTime } from "../automations/cron.ts";
import { idsMatchingConditions, loadTriggerRecord, recordsOnDate } from "../automations/records.ts";
import { valueMatches } from "../automations/sources.ts";
import { getObject } from "../fields/index.ts";
import type { Judge } from "../judge/types.ts";
import { chunk } from "../records/common.ts";
import {
  matchingRecords,
  type RoutineBacktest,
  type RoutineDefinition,
  runRoutineChecks,
} from "./routines.ts";

export const BACKTEST_DAYS = 30;
/** More than this many messages in 30 days (three a day) is a very broad trigger. */
const BROAD_MESSAGES = BACKTEST_DAYS * 3;
/** History rows read per backtest. */
const MAX_EVENTS = 1_000;
/** Typed checks tried per backtest, on the newest events. */
const MAX_JUDGED = 5;
const MAX_EXAMPLES = 6;

const AUDIT_ACTIONS = {
  created: "create",
  updated: "update",
  deleted: "delete",
  restored: "restore",
} as const;

interface PastEvent {
  /** Local date. */
  date: string;
  id: string;
}

const dayLabel = (date: string) =>
  new Intl.DateTimeFormat("en-AU", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  })
    .format(new Date(`${date}T00:00:00Z`))
    .replace(",", "");

const list = (titles: readonly string[]) =>
  titles.length > 2
    ? `${titles.slice(0, 2).join(", ")} and ${titles.length - 2} more`
    : titles.join(", ");

function emptyResult(): RoutineBacktest {
  return {
    days: BACKTEST_DAYS,
    fired: 0,
    fires: Array(BACKTEST_DAYS).fill(false),
    examples: [],
    flags: [],
  };
}

function daySlot(startDate: string, date: string): number {
  return Math.round(
    (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000,
  );
}

/** A cron's days, each checked as of that day. */
async function scheduleBacktest(
  db: Kysely<CoreDatabase>,
  definition: RoutineDefinition,
  ownerId: string,
  startDate: string,
  cron: string,
): Promise<{ result: RoutineBacktest; events: number }> {
  const result = emptyResult();
  const fires = cronFires(cron, startDate, BACKTEST_DAYS);
  const byDay = new Map<string, string[]>();
  for (const fire of fires) {
    const date = fire.slice(0, 10);
    byDay.set(date, [...(byDay.get(date) ?? []), fire]);
  }
  const passes: { text: string; passed: boolean }[] = [];
  const misses: { text: string; passed: boolean }[] = [];
  for (const [date, times] of byDay) {
    const titles = definition.exists
      ? await matchingRecords(db, definition.exists, ownerId, `${times[0]}:00.000Z`)
      : null;
    const label = dayLabel(date);
    if (titles && !titles.length) {
      misses.push({ text: `${label}: nothing to send`, passed: false });
      continue;
    }
    result.fired += times.length;
    const slot = daySlot(startDate, date);
    if (slot >= 0 && slot < BACKTEST_DAYS) result.fires[slot] = true;
    passes.push({
      text: titles ? `${label}: ${list(titles)}`.slice(0, 300) : `${label}: would message you`,
      passed: true,
    });
  }
  result.examples = [...passes.slice(-3).reverse(), ...misses.slice(-3).reverse()];
  return { result, events: fires.length };
}

/** The last 30 days of record changes this trigger would have started on. */
async function recordEvents(
  db: Kysely<CoreDatabase>,
  trigger: Extract<RoutineDefinition["trigger"], { type: "record" | "fieldChanged" }>,
  since: string,
  timezone: string,
): Promise<PastEvent[]> {
  const actions: string[] =
    trigger.type === "record" ? trigger.on.map((on) => AUDIT_ACTIONS[on]) : ["update"];
  const rows = await db
    .selectFrom("core_audit_changes")
    .select(["record_id", "action", "diff", "at"])
    .where("object_type", "=", trigger.object)
    .where("at", ">=", since)
    .orderBy("at", "desc")
    .limit(MAX_EVENTS)
    .execute();
  const out: PastEvent[] = [];
  for (const row of rows) {
    if (!actions.includes(row.action)) continue;
    if (trigger.type === "fieldChanged") {
      const diff = parseDiff(row.diff);
      const change = diff[trigger.field];
      if (!change) continue;
      if (!valueMatches(trigger.from, change.before, undefined)) continue;
      if (!valueMatches(trigger.to, change.after, undefined)) continue;
    }
    out.push({ date: zonedTime(new Date(String(row.at)), timezone).date, id: row.record_id });
  }
  return out;
}

function parseDiff(text: unknown): Record<string, { before?: unknown; after?: unknown }> {
  try {
    return (typeof text === "string" ? JSON.parse(text) : text) as Record<
      string,
      { before?: unknown; after?: unknown }
    >;
  } catch {
    return {};
  }
}

/** The timeline's emails or meetings: what `syncEvent` would have started on. */
async function syncEvents(
  db: Kysely<CoreDatabase>,
  event: string,
  since: string,
  timezone: string,
): Promise<PastEvent[]> {
  const type = event.startsWith("email") ? "email" : "meeting";
  const rows = await sql<{ id: string; occurred_at: string }>`
    SELECT id, occurred_at FROM crm_activities
    WHERE type = ${type} AND occurred_at >= ${since}
    ORDER BY occurred_at DESC LIMIT ${MAX_EVENTS}
  `.execute(db);
  return rows.rows.map((r) => ({
    id: r.id,
    date: zonedTime(new Date(r.occurred_at), timezone).date,
  }));
}

async function titlesOf(
  db: Kysely<CoreDatabase>,
  object: string,
  ids: readonly string[],
): Promise<Map<string, { title: string | null; data: Record<string, unknown> }>> {
  const out = new Map<string, { title: string | null; data: Record<string, unknown> }>();
  for (const id of ids) {
    const record = await loadTriggerRecord(db, object, id);
    if (record) out.set(id, { title: record.title, data: record.data });
  }
  return out;
}

/** Past events through the plain checks, with the newest few through the typed ones. */
async function eventBacktest(
  db: Kysely<CoreDatabase>,
  judge: Judge | undefined,
  definition: RoutineDefinition,
  ownerId: string,
  object: string,
  events: readonly PastEvent[],
  startDate: string,
  now: string,
): Promise<{ result: RoutineBacktest; judge: { calls: number; inputTokens: number } }> {
  const result = emptyResult();
  const spend = { calls: 0, inputTokens: 0 };
  const ids = [...new Set(events.map((e) => e.id))];
  const kept = new Set<string>();
  for (const part of chunk(ids)) {
    const ok = definition.conditions
      ? await idsMatchingConditions(db, object, part, definition.conditions, {
          userId: ownerId,
          now,
        })
      : new Set(part);
    for (const id of ok) kept.add(id);
  }
  const passed = events.filter((e) => kept.has(e.id));
  const failed = events.filter((e) => !kept.has(e.id));
  // Newest first: the examples, and what the typed checks try.
  const shown = await titlesOf(db, object, [
    ...new Set([...passed.slice(0, MAX_JUDGED), ...failed.slice(0, 2)].map((e) => e.id)),
  ]);
  const name = (e: PastEvent) => shown.get(e.id)?.title ?? getObject(object)?.label ?? "A record";
  result.fired = passed.length;
  for (const e of passed) {
    const slot = daySlot(startDate, e.date);
    if (slot >= 0 && slot < BACKTEST_DAYS) result.fires[slot] = true;
  }
  const examples: { text: string; passed: boolean }[] = [];
  if (definition.checks.length) {
    let judged = 0;
    for (const e of passed.slice(0, MAX_JUDGED)) {
      const record = shown.get(e.id);
      if (!record) continue;
      const checked = await runRoutineChecks({
        db,
        judge,
        ownerId,
        definition: { ...definition, conditions: undefined },
        record: { object, id: e.id, ...record },
        now,
      });
      spend.calls += checked.judge.calls;
      spend.inputTokens += checked.judge.inputTokens;
      judged += 1;
      examples.push({
        text: `${dayLabel(e.date)}: ${name(e)}${checked.pass ? "" : ` (${checked.checks.at(-1)?.text ?? "a check"}: no)`}`.slice(
          0,
          300,
        ),
        passed: checked.pass,
      });
    }
    if (judged) {
      result.note = `I tried the checks in your words on the newest ${judged}, so the count is from before them.`;
    }
  } else {
    for (const e of passed.slice(0, 3)) {
      examples.push({ text: `${dayLabel(e.date)}: ${name(e)}`.slice(0, 300), passed: true });
    }
  }
  for (const e of failed.slice(0, 2)) {
    examples.push({
      text: `${dayLabel(e.date)}: ${name(e)} did not match`.slice(0, 300),
      passed: false,
    });
  }
  result.examples = examples.slice(0, MAX_EXAMPLES);
  return { result, judge: spend };
}

export interface BacktestOutcome {
  backtest: RoutineBacktest;
  /** What its typed checks cost, for the judge's spend count. */
  judge: { calls: number; inputTokens: number };
}

/** Replays `definition` over the last 30 days, ending at `now`. Writes nothing. */
export async function backtestRoutine(input: {
  db: Kysely<CoreDatabase>;
  judge: Judge | undefined;
  ownerId: string;
  definition: RoutineDefinition;
  now: string;
  timezone: string;
}): Promise<BacktestOutcome> {
  const { db, judge, ownerId, definition, now, timezone } = input;
  const today = zonedTime(new Date(now), timezone).date;
  const startDate = addDaysToDate(today, -(BACKTEST_DAYS - 1));
  const since = new Date(Date.parse(now) - BACKTEST_DAYS * 86_400_000).toISOString();
  const trigger = definition.trigger;
  let events = 0;
  let spend = { calls: 0, inputTokens: 0 };
  let backtest: RoutineBacktest;
  if (trigger.type === "schedule") {
    const run = await scheduleBacktest(db, definition, ownerId, startDate, trigger.cron);
    backtest = run.result;
    events = run.events;
    if (definition.checks.length) {
      backtest.note = "The checks in your words were not tried on past days.";
    }
  } else {
    let past: PastEvent[] = [];
    let object: string | null = null;
    if (trigger.type === "record" || trigger.type === "fieldChanged") {
      object = trigger.object;
      past = await recordEvents(db, trigger, since, timezone);
    } else if (trigger.type === "syncEvent") {
      object = "activity";
      past = await syncEvents(db, trigger.event, since, timezone);
    } else if (trigger.type === "dateRelative") {
      object = trigger.object;
      for (let i = 0; i < BACKTEST_DAYS; i++) {
        const date = addDaysToDate(startDate, i);
        const target = addDaysToDate(date, -trigger.offsetDays);
        const ids = await recordsOnDate(db, trigger.object, trigger.field, target, 50);
        past.unshift(...ids.map((id) => ({ date, id })));
      }
    }
    events = past.length;
    if (object) {
      const run = await eventBacktest(db, judge, definition, ownerId, object, past, startDate, now);
      backtest = run.result;
      spend = run.judge;
    } else {
      backtest = emptyResult();
    }
  }
  if (!events || (definition.exists && !backtest.fired)) {
    backtest.flags.push({
      code: "no_data",
      text: "Nothing in the last 30 days would have set this off, so I can't show how often it would message you.",
    });
  }
  const gated = Boolean(definition.conditions || definition.exists || definition.checks.length);
  if (backtest.fired > BROAD_MESSAGES) {
    backtest.flags.push({
      code: "broad",
      text: `That is about ${Math.round(backtest.fired / BACKTEST_DAYS)} messages a day, which is a lot. A narrower check would keep it useful.`,
    });
  } else if (trigger.type !== "schedule" && !gated) {
    backtest.flags.push({
      code: "broad",
      text: "This has no check, so it would message you about every one of these.",
    });
  }
  return { backtest, judge: spend };
}
