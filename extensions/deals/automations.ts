// The Deals automations (stage 5, ADR 0028). Each is listed under Automations and can be turned
// off with automation.disable (or the Pause button). They declare their steps and intents, so
// the host renders the summary and step diagram from them; `run` only takes declared steps.
import { CrmCallError, defineAutomation } from "@crm/sdk";

export const STALLED_DAYS = 14;
export const FOLLOW_UP_PREFIX = "Follow up:";
/** Stalled deals handled per daily run (oldest first); the rest wait for the next day. */
export const STALLED_BATCH = 100;
export const ONBOARDING_TASKS = ["Kick-off call", "Send welcome pack", "Set up account"] as const;

/**
 * Open deals with no change and no timeline activity for STALLED_DAYS days, that do not already
 * have an open follow-up task. Indexed: deals by (status, updatedAt); activity and task links by
 * (object_type, record_id).
 */
export const STALLED_SQL = `
SELECT d.id AS id, d.name AS name, d.owner AS owner
FROM crm_x_deals_deal d
WHERE d.status = 'open' AND d.updated_at < ?1
  AND NOT EXISTS (
    SELECT 1 FROM crm_activity_links l JOIN crm_activities a ON a.id = l.activity_id
    WHERE l.object_type = 'deals.deal' AND l.record_id = d.id AND a.occurred_at >= ?1)
  AND NOT EXISTS (
    SELECT 1 FROM crm_task_links tl JOIN crm_tasks t ON t.id = tl.task_id
    WHERE tl.object_type = 'deals.deal' AND tl.record_id = d.id AND t.status = 'open'
      AND t.title LIKE '${FOLLOW_UP_PREFIX}%')
ORDER BY d.updated_at
LIMIT ${STALLED_BATCH}`;

const DAY_MS = 86_400_000;
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The period a schedule run is for (`2026-11-05` or `2026-11-05T08:00`) as epoch ms. */
function periodMs(period: string | undefined): number {
  const parsed = period ? Date.parse(period.length === 10 ? `${period}T00:00:00Z` : period) : NaN;
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

export const stalledDeal = defineAutomation({
  label: "Stalled deal follow-up",
  description:
    `Every morning, an open deal with no changes or activity for ${STALLED_DAYS} days gets a ` +
    "follow-up task for its owner, unless it already has an open one.",
  trigger: { type: "schedule", cron: "0 8 * * *" },
  steps: [
    {
      name: "createFollowUps",
      label: "Create follow-up tasks for stalled deals",
      reads: ["deals.deal", "activity", "task"],
      calls: ["query.sql"],
      writes: [{ object: "task", titles: [`${FOLLOW_UP_PREFIX} <deal name>`] }],
    },
  ],
  async run(event, step, ctx) {
    // One step: a retry re-reads, so deals that already got their task are skipped.
    return step.do("createFollowUps", async () => {
      const since = new Date(periodMs(event.period) - STALLED_DAYS * DAY_MS).toISOString();
      const { rows } = await ctx.crm.call<{
        rows: { id: string; name: string; owner: string | null }[];
      }>("query.sql", { sql: STALLED_SQL, params: [since], maxRows: STALLED_BATCH });
      const created: string[] = [];
      for (const deal of rows) {
        const task = await ctx.crm.call<{ id?: string }>("task.create", {
          title: `${FOLLOW_UP_PREFIX} ${deal.name}`,
          notes: `No changes or activity on this deal for ${STALLED_DAYS} days.`,
          dueAt: isoDate(periodMs(event.period)),
          assigneeId: deal.owner,
          links: [{ object: "deals.deal", id: deal.id }],
        });
        if (task.id) created.push(task.id);
      }
      return { stalled: rows.length, created };
    });
  },
});

export const wonOnboarding = defineAutomation({
  label: "Won deal → onboarding",
  description:
    "When a deal is won, creates three onboarding tasks for its owner and tells them. Three days " +
    "later, if any are still open, tells the owner's manager (the admins, as users have no " +
    "manager field).",
  trigger: { type: "fieldChanged", object: "deals.deal", field: "stage", to: { stageType: "won" } },
  steps: [
    {
      name: "createTasks",
      label: "Create onboarding tasks",
      writes: [
        {
          object: "task",
          count: ONBOARDING_TASKS.length,
          titles: [...ONBOARDING_TASKS],
          assignTo: { field: "owner" },
          linkedToTrigger: true,
        },
      ],
    },
    {
      name: "notifyOwner",
      notifies: [{ to: { field: "owner" }, message: "Deal won 🎉 onboarding tasks created" }],
    },
    { name: "wait", kind: "sleep", duration: "3 days" },
    {
      name: "anyOpen",
      kind: "condition",
      label: "Any onboarding task still open?",
      clause: "any of those tasks are still open",
    },
    {
      name: "notifyManager",
      reads: ["task"],
      notifies: [{ to: { managerOf: "owner" }, message: "Onboarding not started for {record}" }],
    },
  ],
  async run(event, step, ctx) {
    const deal = event.record;
    if (!deal) return { skipped: "no deal" };
    const owner = typeof deal.data?.owner === "string" ? deal.data.owner : null;
    const taskIds = await step.do("createTasks", async () => {
      const ids: string[] = [];
      for (const title of ONBOARDING_TASKS) {
        // A task queued for approval comes back pending, without an id.
        const task = await ctx.crm.call<{ id?: string }>("task.create", {
          title,
          assigneeId: owner,
          links: [{ object: deal.object, id: deal.id }],
        });
        if (task.id) ids.push(task.id);
      }
      return ids;
    });
    await step.do("notifyOwner", () =>
      ctx.notify({ field: "owner" }, { title: "Deal won 🎉 onboarding tasks created" }),
    );
    await step.sleep("wait", "3 days");
    return step.do("notifyManager", async () => {
      let open = 0;
      for (const id of taskIds) {
        try {
          const task = await ctx.crm.call<{ status: string }>("task.get", { id });
          if (task.status === "open") open += 1;
        } catch (error) {
          // A deleted task no longer counts.
          if (!(error instanceof CrmCallError && error.code === "not_found")) throw error;
        }
      }
      if (open === 0) return { open, notified: false };
      await ctx.notify(
        { managerOf: "owner" },
        {
          title: "Onboarding not started for {record}",
          body: `${open} of ${taskIds.length} onboarding tasks are still open.`,
        },
      );
      return { open, notified: true };
    });
  },
});

export const closeDatePassed = defineAutomation({
  label: "Close date passed",
  description:
    "The day after an open deal's expected close date, reminds its owner to update the date or " +
    "close the deal.",
  trigger: { type: "dateRelative", object: "deals.deal", field: "expectedClose", offsetDays: 1 },
  conditions: { field: "status", op: "eq", value: "open" },
  steps: [
    {
      name: "notifyOwner",
      notifies: [
        { to: { field: "owner" }, message: "{record}: the expected close date has passed" },
      ],
    },
  ],
  async run(_event, step, ctx) {
    return step.do("notifyOwner", () =>
      ctx.notify(
        { field: "owner" },
        {
          title: "{record}: the expected close date has passed",
          body: "Update the expected close date, or move the deal to won or lost.",
        },
      ),
    );
  },
});

export const dealAutomations = { stalledDeal, wonOnboarding, closeDatePassed };
