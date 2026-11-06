// First-party plugins (ADR 0347), shipped with each release. Bump a plugin's version when it
// changes: the update path treats the next release like any other new version.
import { type PluginManifest, pluginManifestSchema } from "@relationship-os/agent-plugins";

const WEEK_CARD = `
export default async function (input, { crm, timezone }) {
  const mine = await crm.call("task.listMine", { timezone });
  const due = [...mine.buckets.overdue, ...mine.buckets.today];
  if (!due.length) {
    return {
      a2ui: 1,
      root: { type: "emptyState", title: "All caught up", text: "Nothing overdue or due today." },
    };
  }
  const day = new Intl.DateTimeFormat("en-AU", {
    timeZone: timezone, weekday: "short", day: "numeric", month: "short",
  });
  return {
    a2ui: 1,
    root: {
      type: "taskList",
      title: "To follow through on",
      tasks: due.slice(0, 20).map((task) => ({
        id: task.id,
        title: task.title.slice(0, 300),
        overdue: mine.buckets.overdue.includes(task),
        ...(task.dueAt ? { dueAt: task.dueAt, dueLabel: "Due " + day.format(new Date(task.dueAt)) } : {}),
      })),
      total: due.length,
      viewAll: "/tasks",
    },
  };
}
`;

const FOLLOW_THROUGH = pluginManifestSchema.parse({
  id: "follow-through",
  name: "Follow-through",
  version: "1.0.0",
  publisher: "Relationship OS",
  description:
    "Keeps promises from slipping: a Monday list of what is overdue, a way to plan the week, and a saved view of your open tasks.",
  whatsNew: ["First release."],
  access: {
    operations: ["task.listMine"],
    words: ["Read your tasks", "Message you in your chat"],
  },
  items: [
    {
      kind: "skill",
      key: "plan-week",
      label: "Plan my week",
      description: "What matters this week, from your tasks and open deals",
      body: {
        name: "followThrough.planWeek",
        description: "Plan the person's week from their tasks and what is open",
        instructions:
          "Read the person's tasks and anything due this week.\nGroup what you find into must do, should do and could wait.\nKeep it to a few short lines.\nIf you find nothing useful, say so in one line.",
      },
    },
    {
      kind: "producer",
      key: "week-card",
      label: "To follow through on",
      description: "Builds the Monday card straight from your tasks",
      body: {
        name: "followThrough.weekCard",
        description: "What you have overdue or due today, with Complete and Snooze.",
        source: WEEK_CARD,
      },
    },
    {
      kind: "routine",
      key: "monday-list",
      label: "Monday follow-through",
      description: "Mondays at 8:00 am, when something is overdue",
      body: {
        name: "Monday follow-through",
        what: "send you what is overdue or due today",
        trigger: { type: "schedule", cron: "0 8 * * 1" },
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
        ],
        message: { kind: "producer", producer: "followThrough.weekCard", input: {} },
      },
    },
    {
      kind: "savedView",
      key: "recent-people",
      label: "People added recently",
      description: "Your newest contacts, to follow up while it is fresh",
      body: {
        spec: {
          type: "table",
          object: "person",
          sort: { field: "createdAt", direction: "desc" },
        },
      },
    },
    {
      kind: "quickAction",
      key: "plan-week-action",
      label: "Plan my week",
      description: "Ask your assistant to plan the week",
      body: { action: "ask", prompt: "Plan my week" },
    },
    {
      kind: "assistantPreset",
      key: "starter",
      label: "A starter for your assistant",
      description: "Offered to you to read first",
      body: {
        shortcuts: ["When I say follow through, I mean what I promised someone and have not done"],
        style: ["Keep follow-up messages to three short sentences"],
      },
    },
  ],
});

const MEETING_PREP = pluginManifestSchema.parse({
  id: "meeting-prep",
  name: "Meeting prep",
  version: "1.0.0",
  publisher: "Relationship OS",
  description:
    "A brief before each external meeting: who is coming, what was said last, and what is open with them.",
  whatsNew: ["First release."],
  access: {
    operations: [],
    connections: ["calendar"],
    words: ["Read people, organisations and activity you can see", "Read your calendar"],
  },
  items: [
    {
      kind: "skill",
      key: "brief",
      label: "Prepare a meeting brief",
      description: "Attendees, recent activity and what is open",
      body: {
        name: "meetingPrep.brief",
        description: "A short brief for a meeting: who is coming, what was said last, what is open",
        instructions:
          "List attendees and their roles.\nSay what was last discussed with them.\nShow open deals and tasks.\nKeep it under 300 words.",
      },
    },
    {
      kind: "routine",
      key: "morning-briefs",
      label: "Brief before meetings",
      description: "Weekdays at 7:30 am, when you have a meeting that day",
      body: {
        name: "Brief before meetings",
        what: "send you a short brief for today's meetings",
        trigger: { type: "schedule", cron: "30 7 * * 1-5" },
        exists: [
          {
            object: "activity",
            label: "You have a meeting today",
            filter: {
              and: [
                { field: "type", op: "eq", value: "meeting" },
                { field: "occurredAt", op: "gte", value: { $relative: "today" } },
                { field: "occurredAt", op: "lt", value: { $relative: "tomorrow" } },
              ],
            },
          },
        ],
        message: { kind: "skill", skill: "meetingPrep.brief" },
      },
    },
    {
      kind: "connectionNeed",
      key: "calendar",
      label: "Your calendar",
      body: {
        service: "calendar",
        vendors: ["google", "microsoft"],
        level: "personal",
        reason: "It reads your meetings to build each brief. Only you can sign in to your calendar.",
      },
    },
  ],
});

export const FIRST_PARTY_PLUGINS: readonly PluginManifest[] = [FOLLOW_THROUGH, MEETING_PREP];
