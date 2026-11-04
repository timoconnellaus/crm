// The `* * * * *` cron (ADR 0130): schedule triggers whose cron matches this minute in the
// automation timezone, and once a day (the first tick from 00:05 local) date-relative triggers.
// Idempotency keys are per period (`<minute>` for schedules, `<recordId>:<date>` for date-relative
// matches), so a repeated tick never starts a second run.
import {
  addDaysToDate,
  cronMatches,
  FAN_OUT_BUDGET,
  loadAutomationSettings,
  loadEnabledAutomations,
  type RunCandidate,
  recordsOnDate,
  zonedTime,
} from "@crm/core";
import { createCrmDb } from "@crm/db";
import { type DispatchEnv, type StartResult, startRuns } from "./dispatch.ts";

/** core_automation_counters row that marks the day's date-relative scan as done. */
export const DATE_RELATIVE_MARKER = "~dateRelative";

export async function runAutomationCron(
  env: DispatchEnv,
  at: Date = new Date(),
): Promise<{ schedule: StartResult | null; dateRelative: StartResult | null }> {
  const crm = createCrmDb(env.DB);
  const settings = await loadAutomationSettings(crm.query);
  if (settings.killSwitch) return { schedule: null, dateRelative: null };
  const local = zonedTime(at, settings.timezone);
  const iso = at.toISOString();

  let schedule: StartResult | null = null;
  const schedules = await loadEnabledAutomations(crm.query, ["schedule"]);
  const due: RunCandidate[] = schedules
    .filter((a) => a.spec.trigger.type === "schedule" && cronMatches(a.spec.trigger.cron, local))
    .map((a) => ({ automation: a, idempotencyKey: local.minuteKey, period: local.minuteKey }));
  if (due.length) {
    schedule = await startRuns(
      env,
      due,
      {
        depth: 0,
        chain: [],
        rootEventId: `schedule:${local.minuteKey}`,
        eventId: `schedule:${local.minuteKey}`,
        at: iso,
      },
      { now: at },
      settings,
    );
  }

  let dateRelative: StartResult | null = null;
  if (local.hour > 0 || local.minute >= 5) {
    const done = await crm.query
      .selectFrom("core_automation_counters")
      .select("hour")
      .where("automation_id", "=", DATE_RELATIVE_MARKER)
      .where("hour", "=", local.date)
      .executeTakeFirst();
    if (!done) {
      dateRelative = await runDateRelative(env, local.date, iso, settings);
      await crm.query
        .insertInto("core_automation_counters")
        .values({ automation_id: DATE_RELATIVE_MARKER, hour: local.date, runs: 1, writes: 0 })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
  }
  return { schedule, dateRelative };
}

/** Date-relative matches for `date` (local): records whose date field is `date - offsetDays`. */
export async function runDateRelative(
  env: DispatchEnv,
  date: string,
  at: string,
  settings?: Awaited<ReturnType<typeof loadAutomationSettings>>,
): Promise<StartResult> {
  const db = createCrmDb(env.DB).query;
  const automations = await loadEnabledAutomations(db, ["dateRelative"]);
  const candidates: RunCandidate[] = [];
  for (const a of automations) {
    const t = a.spec.trigger;
    if (t.type !== "dateRelative") continue;
    const target = addDaysToDate(date, -t.offsetDays);
    const ids = await recordsOnDate(db, t.object, t.field, target, FAN_OUT_BUDGET);
    for (const id of ids) {
      candidates.push({
        automation: a,
        idempotencyKey: `${id}:${date}`,
        record: { object: t.object, id },
        period: date,
      });
    }
  }
  return startRuns(
    env,
    candidates,
    {
      depth: 0,
      chain: [],
      rootEventId: `dateRelative:${date}`,
      eventId: `dateRelative:${date}`,
      at,
    },
    {},
    settings,
  );
}
