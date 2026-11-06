// The A2UI catalogue (ADR 0346, docs/stages/assets/17/a2ui-catalogue.md): every component a card
// may use, its props schema, the catalogue version it arrived in, who may send it, and its text
// fallback. A host renders only these, with its own components; anything else falls back to text.
//
// Adding a component is a catalogue change: a definition here with `since` set to a new
// A2UI_CATALOGUE_VERSION, a renderer in each host's component map, a sample in samples.ts and a
// fallback. Stage 12 to 16 components are listed in RESERVED_COMPONENTS until those stages build
// them; a card naming one falls back to text.
import { z } from "zod";
import {
  actionSchema,
  actionsSchema,
  type Fact,
  factSchema,
  formFieldSchema,
  hrefSchema,
  line,
  operationNameSchema,
  prose,
  type RecordRef,
  recordRefSchema,
  submitSchema,
  toneSchema,
} from "./schema.ts";

/** The catalogue version this package renders. Plugins declare the version they target. */
export const A2UI_CATALOGUE_VERSION = 1;

export const CATALOGUE_GROUPS = [
  "layout",
  "primitives",
  "records",
  "tasks",
  "deals",
  "calendar",
  "charts",
  "forms",
  "host",
] as const;
export type CatalogueGroup = (typeof CATALOGUE_GROUPS)[number];

/** What a component's fallback can use: the text of its children, already made. */
export interface FallbackHelpers {
  children: string[];
}

export interface ComponentDefinition<P extends z.ZodType = z.ZodType> {
  type: string;
  group: CatalogueGroup;
  /** The catalogue version it arrived in. */
  since: number;
  /** Only the host may send it (approvals, read-backs, memory, plugin and connection cards). */
  hostOnly?: boolean;
  /** It holds other components in `children`. */
  container?: boolean;
  /** One line for the model (the show_card tool lists them). */
  description: string;
  props: P;
  /** The plain-text version of the component, stored with the message (ADR 0346). */
  fallback(props: z.output<P>, helpers: FallbackHelpers): string;
}

function define<const T extends string, P extends z.ZodType>(
  definition: ComponentDefinition<P> & { type: T },
): ComponentDefinition<P> & { type: T } {
  return definition;
}

// --- Fallback helpers ------------------------------------------------------------------------

const joinLines = (...lines: (string | false | null | undefined)[]) =>
  lines.filter((l): l is string => typeof l === "string" && l.trim().length > 0).join("\n");
const facts = (items: readonly Fact[]) =>
  items.map((f) => `${f.label}: ${f.record?.label ?? f.value}`).join(" · ");
const numbered = (items: readonly string[]) => items.map((t, i) => `${i + 1}. ${t}`).join("\n");
const bullets = (items: readonly string[]) => items.map((t) => `- ${t}`).join("\n");
const record = (r: RecordRef) => (r.subtitle ? `${r.label} (${r.subtitle})` : r.label);
const buttons = (actions: readonly { label: string }[] | undefined) =>
  actions?.length ? `Buttons: ${actions.map((a) => a.label).join(", ")}` : null;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// --- Layout ----------------------------------------------------------------------------------

const children = z.array(z.unknown()).max(20).default([]);

const card = define({
  type: "card",
  group: "layout",
  since: 1,
  container: true,
  description: "A card: title, optional subtitle and badge, children, up to 4 buttons",
  props: z.object({
    title: line().optional(),
    subtitle: z.string().max(200).optional(),
    icon: z.string().max(40).optional().describe("A hint for the host's icon, e.g. task, deal"),
    badge: z.object({ text: line(40), tone: toneSchema.default("neutral") }).optional(),
    tone: z.enum(["default", "pending", "ok", "blocked"]).default("default"),
    children,
    actions: actionsSchema.optional(),
  }),
  fallback: (p, h) =>
    joinLines(
      p.title && (p.badge ? `${p.title} [${p.badge.text}]` : p.title),
      p.subtitle,
      ...h.children,
      buttons(p.actions),
    ),
});

const stack = define({
  type: "stack",
  group: "layout",
  since: 1,
  container: true,
  description: "Components one under another, without a frame",
  props: z.object({ children }),
  fallback: (_p, h) => joinLines(...h.children),
});

// --- Primitives ------------------------------------------------------------------------------

const text = define({
  type: "text",
  group: "primitives",
  since: 1,
  description: "A paragraph of Markdown (emphasis, links to records)",
  props: z.object({ text: prose(4_000).min(1), muted: z.boolean().optional() }),
  fallback: (p) => p.text,
});

const heading = define({
  type: "heading",
  group: "primitives",
  since: 1,
  description: "A small heading inside a card",
  props: z.object({ text: line() }),
  fallback: (p) => p.text,
});

const divider = define({
  type: "divider",
  group: "primitives",
  since: 1,
  description: "A line between parts of a card",
  props: z.object({}),
  fallback: () => "---",
});

const keyValue = define({
  type: "keyValue",
  group: "primitives",
  since: 1,
  description: "Label and value pairs (Owner: Maya, Stage: Proposal)",
  props: z.object({ items: z.array(factSchema).min(1).max(12) }),
  fallback: (p) => p.items.map((f) => `${f.label}: ${f.record?.label ?? f.value}`).join("\n"),
});

const badge = define({
  type: "badge",
  group: "primitives",
  since: 1,
  description: "A status pill: stage, priority, pending, overdue",
  props: z.object({ text: line(40), tone: toneSchema.default("neutral") }),
  fallback: (p) => `[${p.text}]`,
});

const recordChip = define({
  type: "recordChip",
  group: "primitives",
  since: 1,
  description: "A person, organisation or deal as a clickable chip",
  props: z.object({ record: recordRefSchema }),
  fallback: (p) => record(p.record),
});

const list = define({
  type: "list",
  group: "primitives",
  since: 1,
  description: "A plain or numbered list",
  props: z.object({
    ordered: z.boolean().optional(),
    items: z
      .array(
        z.object({
          text: line(400),
          secondary: z.string().max(200).optional(),
          record: recordRefSchema.optional(),
        }),
      )
      .min(1)
      .max(30),
  }),
  fallback: (p) => {
    const items = p.items.map((i) => (i.secondary ? `${i.text} (${i.secondary})` : i.text));
    return p.ordered ? numbered(items) : bullets(items);
  },
});

const cell = z.union([z.string().max(300), z.number(), z.null()]);

const table = define({
  type: "table",
  group: "primitives",
  since: 1,
  description: "A small table (at most 20 rows), sortable columns, View all link",
  props: z.object({
    columns: z
      .array(
        z.object({
          key: line(80),
          label: line(80),
          align: z.enum(["start", "end"]).optional(),
        }),
      )
      .min(1)
      .max(6),
    rows: z.array(z.record(z.string(), cell)).max(20),
    viewAll: z.object({ label: line(60).default("View all"), href: hrefSchema }).optional(),
  }),
  fallback: (p) =>
    joinLines(
      p.columns.map((c) => c.label).join(" | "),
      numbered(p.rows.map((r) => p.columns.map((c) => String(r[c.key] ?? "")).join(" | "))),
    ),
});

const actions = define({
  type: "actions",
  group: "primitives",
  since: 1,
  description: "Up to 4 buttons; each calls an operation, opens a page or sends a reply",
  props: z.object({ actions: actionsSchema.min(1) }),
  fallback: (p) => buttons(p.actions) ?? "",
});

const link = define({
  type: "link",
  group: "primitives",
  since: 1,
  description: "A link to a record, view, dashboard or allowed external URL",
  props: z.object({ label: line(120), href: hrefSchema }),
  fallback: (p) => `${p.label} (${p.href})`,
});

const image = define({
  type: "image",
  group: "primitives",
  since: 1,
  description: "An image from the app's own storage (a path starting with /)",
  props: z.object({
    src: z
      .string()
      .max(500)
      .regex(/^\/(?!\/)/, "images come from the app's own storage"),
    alt: line(200),
    width: z.number().int().min(16).max(800).optional(),
  }),
  fallback: (p) => `[Image: ${p.alt}]`,
});

const progress = define({
  type: "progress",
  group: "primitives",
  since: 1,
  description: "A long-running job's progress",
  props: z.object({
    label: line(),
    value: z.number().min(0),
    max: z.number().positive().default(100),
    status: z.enum(["running", "done", "failed", "stopped"]).default("running"),
    detail: z.string().max(200).optional(),
  }),
  fallback: (p) =>
    `${p.label}: ${p.value} of ${p.max}${p.status === "running" ? "" : ` (${p.status})`}${p.detail ? `. ${p.detail}` : ""}`,
});

const emptyState = define({
  type: "emptyState",
  group: "primitives",
  since: 1,
  description: "Nothing to show, with one suggested action",
  props: z.object({
    title: line(),
    text: z.string().max(400).optional(),
    action: actionSchema.optional(),
  }),
  fallback: (p) => joinLines(p.title, p.text, p.action && `Suggested: ${p.action.label}`),
});

// --- Records and data ------------------------------------------------------------------------

const recordCard = define({
  type: "recordCard",
  group: "records",
  since: 1,
  description: "A person, organisation, deal or custom record: key facts and owner",
  props: z.object({
    record: recordRefSchema,
    facts: z.array(factSchema).max(10).default([]),
    actions: actionsSchema.optional(),
  }),
  fallback: (p) =>
    joinLines(record(p.record), p.facts.length ? facts(p.facts) : null, buttons(p.actions)),
});

const recordList = define({
  type: "recordList",
  group: "records",
  since: 1,
  description: "A filtered set of records with 2 or 3 columns, bulk actions and View all",
  props: z.object({
    title: line(),
    columns: z.array(line(80)).min(1).max(3),
    rows: z
      .array(z.object({ record: recordRefSchema, values: z.array(z.string().max(200)).max(3) }))
      .max(20),
    total: z.number().int().min(0).optional(),
    bulkActions: actionsSchema.optional(),
    viewAll: hrefSchema.optional(),
  }),
  fallback: (p) =>
    joinLines(
      `${p.title} (${plural(p.total ?? p.rows.length, "record")})`,
      numbered(p.rows.map((r) => [r.record.label, ...r.values].join(" | "))),
      buttons(p.bulkActions),
    ),
});

const recordDiff = define({
  type: "recordDiff",
  group: "records",
  since: 1,
  description: "What a change will do, before and after",
  props: z.object({
    title: line(),
    record: recordRefSchema.optional(),
    changes: z
      .array(
        z.object({
          field: line(80),
          before: z.string().max(400).nullable(),
          after: z.string().max(400).nullable(),
        }),
      )
      .min(1)
      .max(20),
    actions: actionsSchema.optional(),
  }),
  fallback: (p) =>
    joinLines(
      p.title,
      ...p.changes.map((c) => `${c.field}: ${c.before ?? "(empty)"} -> ${c.after ?? "(empty)"}`),
      buttons(p.actions),
    ),
});

const searchResults = define({
  type: "searchResults",
  group: "records",
  since: 1,
  description: "Search hits grouped by type, matched by meaning or by text",
  props: z.object({
    query: line(200),
    groups: z
      .array(
        z.object({
          label: line(80),
          hits: z
            .array(
              z.object({
                record: recordRefSchema,
                snippet: z.string().max(300).optional(),
                matchedBy: z.enum(["meaning", "text"]).optional(),
              }),
            )
            .max(10),
        }),
      )
      .max(6),
    refine: actionSchema.optional(),
  }),
  fallback: (p) =>
    joinLines(
      `Results for "${p.query}"`,
      ...p.groups.map((g) =>
        `${g.label}:\n${numbered(g.hits.map((h) => record(h.record)))}`.trimEnd(),
      ),
    ),
});

const relatedRecords = define({
  type: "relatedRecords",
  group: "records",
  since: 1,
  description: "Records linked to one record (people at an organisation, a person's deals)",
  props: z.object({
    title: line(),
    record: recordRefSchema.optional(),
    groups: z
      .array(z.object({ label: line(80), records: z.array(recordRefSchema).max(20) }))
      .min(1)
      .max(6),
  }),
  fallback: (p) =>
    joinLines(
      p.title,
      ...p.groups.map((g) => `${g.label}: ${g.records.map((r) => r.label).join(", ") || "none"}`),
    ),
});

// --- Tasks and activities --------------------------------------------------------------------

const taskItem = z.object({
  id: line(80),
  title: line(300),
  done: z.boolean().default(false),
  dueAt: z.string().max(40).optional().describe("ISO date or time"),
  dueLabel: z.string().max(80).optional().describe("How the due date reads: 'Due Fri 7 Nov'"),
  overdue: z.boolean().optional(),
  record: recordRefSchema.optional(),
  assignee: z.object({ id: line(80), name: line(120) }).optional(),
  notes: z.string().max(2_000).optional(),
});
export type TaskItem = z.infer<typeof taskItem>;

const taskLine = (t: TaskItem) =>
  [
    t.title,
    t.done ? "done" : (t.dueLabel ?? (t.dueAt ? `due ${t.dueAt}` : null)),
    t.overdue && !t.done ? "overdue" : null,
    t.record?.label,
  ]
    .filter(Boolean)
    .join(", ");

const taskList = define({
  type: "taskList",
  group: "tasks",
  since: 1,
  description: "Due or overdue tasks with checkboxes: Complete, Snooze, Reassign, Open",
  props: z.object({
    title: line(),
    tasks: z.array(taskItem).max(20),
    total: z.number().int().min(0).optional(),
    viewAll: hrefSchema.optional(),
  }),
  fallback: (p) =>
    joinLines(
      `${p.title} (${plural(p.total ?? p.tasks.length, "task")})`,
      numbered(p.tasks.map(taskLine)),
    ),
});

const taskCard = define({
  type: "taskCard",
  group: "tasks",
  since: 1,
  description: "One task with notes and its linked record: Complete, Edit, Snooze",
  props: z.object({ task: taskItem }),
  fallback: (p) => joinLines(`Task: ${taskLine(p.task)}`, p.task.notes),
});

const ACTIVITY_KINDS = ["note", "call", "email", "meeting", "task", "system"] as const;

const timeline = define({
  type: "timeline",
  group: "tasks",
  since: 1,
  description: "Recent notes, calls, emails and meetings on a record",
  props: z.object({
    title: line().default("Recent activity"),
    record: recordRefSchema.optional(),
    entries: z
      .array(
        z.object({
          kind: z.enum(ACTIVITY_KINDS),
          title: line(300),
          when: line(80).describe("How the time reads: 'Today', 'Thu 2 Oct'"),
          text: z.string().max(500).optional(),
        }),
      )
      .max(15),
    actions: actionsSchema.optional(),
  }),
  fallback: (p) =>
    joinLines(
      p.record ? `${p.title}: ${p.record.label}` : p.title,
      numbered(p.entries.map((e) => `${e.when}, ${e.kind}: ${e.title}`)),
      buttons(p.actions),
    ),
});

const person = z.object({
  name: line(120),
  email: z.string().max(200).optional(),
  record: recordRefSchema.optional(),
});

const emailPreview = define({
  type: "emailPreview",
  group: "tasks",
  since: 1,
  description: "A received email: subject, snippet, sender: Reply, Open thread, Create task",
  props: z.object({
    subject: line(300),
    from: person,
    when: line(80),
    snippet: z.string().max(600),
    actions: actionsSchema.optional(),
  }),
  fallback: (p) =>
    joinLines(`Email from ${p.from.name}, ${p.when}: ${p.subject}`, p.snippet, buttons(p.actions)),
});

const emailDraft = define({
  type: "emailDraft",
  group: "tasks",
  since: 1,
  description:
    "An AI-written draft, editable inline; Send is an operation that goes through outbound approval",
  props: z.object({
    to: z.array(person).min(1).max(50),
    cc: z.array(person).max(50).default([]),
    subject: line(300),
    body: prose(10_000),
    attachments: z.array(line(200)).max(10).default([]),
    /** Send: the operation, with the edited subject and body merged into its input. */
    send: z.object({
      operation: operationNameSchema,
      input: z.record(z.string(), z.unknown()).default({}),
      subjectField: z.string().max(80).default("subject"),
      bodyField: z.string().max(80).default("body"),
    }),
    actions: actionsSchema.max(2).optional(),
  }),
  fallback: (p) =>
    joinLines(
      `Draft email to ${p.to.map((t) => t.name).join(", ")}${p.cc.length ? `, cc ${p.cc.map((c) => c.name).join(", ")}` : ""}`,
      `Subject: ${p.subject}`,
      p.body,
      p.attachments.length ? `Attachments: ${p.attachments.join(", ")}` : null,
    ),
});

const logger = define({
  type: "logger",
  group: "tasks",
  since: 1,
  description: "A quick form to log a call or a note on a record (activity.log)",
  props: z.object({
    kind: z.enum(["call", "note"]),
    record: recordRefSchema,
    subject: z.string().max(300).optional(),
    body: z.string().max(4_000).optional(),
  }),
  fallback: (p) =>
    joinLines(`Log a ${p.kind} on ${p.record.label}`, p.subject && `Subject: ${p.subject}`),
});

// --- Deals and pipeline ----------------------------------------------------------------------

const dealCard = define({
  type: "dealCard",
  group: "deals",
  since: 1,
  description: "A deal: stage track, value, close date, days in stage, last activity",
  props: z.object({
    deal: recordRefSchema,
    value: z.string().max(40).optional(),
    stage: line(80),
    stageIndex: z.number().int().min(1).max(20).optional(),
    stageCount: z.number().int().min(1).max(20).optional(),
    facts: z.array(factSchema).max(8).default([]),
    actions: actionsSchema.optional(),
  }),
  fallback: (p) =>
    joinLines(
      `Deal: ${record(p.deal)}${p.value ? `, ${p.value}` : ""}`,
      `Stage: ${p.stage}${p.stageIndex && p.stageCount ? ` (${p.stageIndex} of ${p.stageCount})` : ""}`,
      p.facts.length ? facts(p.facts) : null,
      buttons(p.actions),
    ),
});

const dealList = define({
  type: "dealList",
  group: "deals",
  since: 1,
  description: "Deals with plain facts (days since activity): follow-up tasks, Open, Snooze",
  props: z.object({
    title: line(),
    summary: z.string().max(120).optional(),
    deals: z
      .array(
        z.object({
          deal: recordRefSchema,
          value: z.string().max(40).optional(),
          detail: z.string().max(200).optional(),
        }),
      )
      .max(20),
    actions: actionsSchema.optional(),
  }),
  fallback: (p) =>
    joinLines(
      p.summary ? `${p.title} (${p.summary})` : p.title,
      numbered(p.deals.map((d) => [d.deal.label, d.detail, d.value].filter(Boolean).join(", "))),
      buttons(p.actions),
    ),
});

const pipelineSnapshot = define({
  type: "pipelineSnapshot",
  group: "deals",
  since: 1,
  description: "Counts and value per stage as mini bars",
  props: z.object({
    title: line(),
    summary: z.string().max(120).optional(),
    stages: z
      .array(
        z.object({
          label: line(80),
          count: z.number().int().min(0),
          value: z.number().min(0),
          valueLabel: z.string().max(40).optional(),
        }),
      )
      .min(1)
      .max(12),
    open: hrefSchema.optional(),
  }),
  fallback: (p) =>
    joinLines(
      p.summary ? `${p.title} (${p.summary})` : p.title,
      ...p.stages.map(
        (s) => `${s.label}: ${plural(s.count, "deal")}, ${s.valueLabel ?? String(s.value)}`,
      ),
    ),
});

const stageMoveConfirm = define({
  type: "stageMoveConfirm",
  group: "deals",
  since: 1,
  description: "Moving a deal to a stage, with the fields that stage requires",
  props: z.object({
    deal: recordRefSchema,
    from: line(80),
    to: line(80),
    fields: z.array(formFieldSchema).max(8).default([]),
    submit: submitSchema,
  }),
  fallback: (p) =>
    joinLines(
      `Move ${p.deal.label} from ${p.from} to ${p.to}`,
      p.fields.length ? `Needs: ${p.fields.map((f) => f.label).join(", ")}` : null,
    ),
});

// --- Calendar and meetings -------------------------------------------------------------------

const meeting = {
  title: line(),
  when: line(120),
  where: z.string().max(200).optional(),
  attendees: z.array(recordRefSchema).max(20).default([]),
  records: z.array(recordRefSchema).max(10).default([]),
  joinUrl: hrefSchema.optional(),
};

const meetingCard = define({
  type: "meetingCard",
  group: "calendar",
  since: 1,
  description: "A meeting: time, attendees, linked organisation and deals",
  props: z.object({ ...meeting, actions: actionsSchema.optional() }),
  fallback: (p) =>
    joinLines(
      `Meeting: ${p.title}, ${p.when}${p.where ? `, ${p.where}` : ""}`,
      p.attendees.length ? `With ${p.attendees.map((a) => a.label).join(", ")}` : null,
      buttons(p.actions),
    ),
});

const meetingPrep = define({
  type: "meetingPrep",
  group: "calendar",
  since: 1,
  description: "Meeting prep: attendees, summary, recent activity, open deals and tasks",
  props: z.object({
    ...meeting,
    summary: z.string().max(1_500).optional(),
    checked: z.boolean().optional().describe("The summary was checked against the records"),
    recent: z.array(line(300)).max(8).default([]),
    open: z.array(line(300)).max(8).default([]),
    actions: actionsSchema.optional(),
  }),
  fallback: (p) =>
    joinLines(
      `Prep for ${p.title}, ${p.when}`,
      p.attendees.length ? `With ${p.attendees.map((a) => a.label).join(", ")}` : null,
      p.summary && `Summary: ${p.summary}`,
      p.recent.length ? `Recent:\n${bullets(p.recent)}` : null,
      p.open.length ? `Open:\n${bullets(p.open)}` : null,
    ),
});

const availabilitySlots = define({
  type: "availabilitySlots",
  group: "calendar",
  since: 1,
  description: "A few free times; picking one calls an operation (an invite draft for approval)",
  props: z.object({
    title: line(),
    slots: z
      .array(z.object({ start: line(40), label: line(80) }))
      .min(1)
      .max(8),
    pick: z.object({
      operation: operationNameSchema,
      input: z.record(z.string(), z.unknown()).default({}),
      field: z.string().max(80).default("start"),
    }),
  }),
  fallback: (p) => joinLines(p.title, numbered(p.slots.map((s) => s.label))),
});

// --- Charts and numbers ----------------------------------------------------------------------

const numberFormat = {
  format: z.enum(["number", "currency", "percent"]).optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
};

const formatted = (value: number, f: { format?: string | undefined; currency?: string }) => {
  if (f.format === "currency") return `${f.currency ?? ""} ${value}`.trim();
  if (f.format === "percent") return `${value}%`;
  return String(value);
};

const kpi = define({
  type: "kpi",
  group: "charts",
  since: 1,
  description: "One number with the previous period (plain facts, no scores)",
  props: z.object({
    title: line(),
    value: z.number(),
    previous: z.number().optional(),
    ...numberFormat,
    open: hrefSchema.optional(),
  }),
  fallback: (p) =>
    `${p.title}: ${formatted(p.value, p)}${p.previous !== undefined ? ` (before: ${formatted(p.previous, p)})` : ""}`,
});

const chartRow = z.record(z.string(), z.union([z.string().max(200), z.number(), z.null()]));

const chart = define({
  type: "chart",
  group: "charts",
  since: 1,
  description: "A small bar, line, donut or funnel chart over rows, drawn like a dashboard widget",
  props: z.object({
    title: line(),
    chart: z.enum(["bar", "line", "donut", "funnel"]),
    rows: z.array(chartRow).min(1).max(50),
    x: line(80).describe("Category or time column (bar, line), label column (donut, funnel)"),
    y: z.union([line(80), z.array(line(80)).min(1).max(4)]),
    orientation: z.enum(["vertical", "horizontal"]).optional(),
    stacked: z.boolean().optional(),
    ...numberFormat,
    open: hrefSchema.optional().describe("Open in dashboard"),
  }),
  fallback: (p) => {
    const ys = Array.isArray(p.y) ? p.y : [p.y];
    return joinLines(
      `${p.title} (${p.chart} chart)`,
      ...p.rows.map((r) => `${r[p.x] ?? ""}: ${ys.map((y) => r[y] ?? "").join(", ")}`),
    );
  },
});

const leaderboard = define({
  type: "leaderboard",
  group: "charts",
  since: 1,
  description: "Top N by a measure",
  props: z.object({
    title: line(),
    rows: z
      .array(z.object({ label: line(200), value: z.number() }))
      .min(1)
      .max(20),
    ...numberFormat,
  }),
  fallback: (p) =>
    joinLines(p.title, numbered(p.rows.map((r) => `${r.label}: ${formatted(r.value, p)}`))),
});

// --- Forms and input -------------------------------------------------------------------------

const recordForm = define({
  type: "recordForm",
  group: "forms",
  since: 1,
  description:
    "Create or edit a record; submits as an operation (a change set where review applies)",
  props: z.object({
    title: line(),
    object: line(80),
    fields: z.array(formFieldSchema).min(1).max(12),
    submit: submitSchema,
  }),
  fallback: (p) =>
    joinLines(
      p.title,
      ...p.fields.map((f) => `${f.label}: ${f.valueLabel ?? f.value ?? ""}`.trimEnd()),
    ),
});

const form = define({
  type: "form",
  group: "forms",
  since: 1,
  description:
    "A form of text, number, date, select, user and record fields for skills and plugins",
  props: z.object({
    title: line(),
    text: z.string().max(400).optional(),
    fields: z.array(formFieldSchema).min(1).max(12),
    submit: submitSchema,
  }),
  fallback: (p) => joinLines(p.title, p.text, `Fields: ${p.fields.map((f) => f.label).join(", ")}`),
});

const choice = define({
  type: "choice",
  group: "forms",
  since: 1,
  description: "Single or multiple choice to answer the assistant (sends the choice as a reply)",
  props: z.object({
    question: z.string().max(300).optional(),
    multiple: z.boolean().optional(),
    options: z
      .array(z.object({ label: line(120), reply: z.string().max(500).optional() }))
      .min(1)
      .max(8),
  }),
  fallback: (p) => joinLines(p.question, numbered(p.options.map((o) => o.label))),
});

const confirm = define({
  type: "confirm",
  group: "forms",
  since: 1,
  description: "Yes or no, with the consequences spelled out (destructive actions)",
  props: z.object({
    title: line(),
    consequences: z.array(line(300)).min(1).max(8),
    confirm: actionSchema,
    cancelLabel: line(40).default("Cancel"),
  }),
  fallback: (p) =>
    joinLines(p.title, bullets(p.consequences), `Buttons: ${p.confirm.label}, ${p.cancelLabel}`),
});

const fileUpload = define({
  type: "fileUpload",
  group: "forms",
  since: 1,
  description: "Attach a file (a CSV for import, a document for a record)",
  props: z.object({
    title: line(),
    record: recordRefSchema.optional(),
    accept: z.string().max(200).optional(),
    /** Where the file goes: a page that takes it over (the import page), with the file picked there. */
    href: hrefSchema,
  }),
  fallback: (p) => joinLines(p.title, p.record && `For ${p.record.label}`),
});

// --- Assistant system flows (host-rendered) --------------------------------------------------

const approval = define({
  type: "approval",
  group: "host",
  since: 1,
  hostOnly: true,
  description: "A pending change set: diff, reason, the agent's reason; Approve, Reject, Review",
  props: z.object({
    changeSetId: line(80),
    actionIds: z.array(line(80)).max(100).optional(),
    title: z.string().max(200).optional(),
    youAsked: z.string().max(500).optional(),
  }),
  fallback: (p) =>
    joinLines(
      `Waiting for approval: ${p.title ?? `change set ${p.changeSetId}`}`,
      p.youAsked && `You asked: "${p.youAsked}"`,
    ),
});

const agentJob = define({
  type: "agentJob",
  group: "host",
  since: 1,
  hostOnly: true,
  description: "An agent's live progress card: what it has done, changes to review, Stop",
  props: z.object({ jobId: line(80), title: line(200) }),
  fallback: (p) => `Agent: ${p.title}`,
});

const agentGrant = define({
  type: "agentGrant",
  group: "host",
  since: 1,
  hostOnly: true,
  description: "What an agent asks to do, for the person to confirm before it starts",
  props: z.object({
    jobId: line(80),
    title: line(200),
    brief: z.string().max(2_000),
    /** What it can do without asking. */
    can: z.array(line(300)).max(12),
    /** What it will put aside for the person. */
    aside: z.array(line(300)).max(12),
    budget: line(300),
    /** The judge's note, when it has one. */
    note: z.string().max(300).optional(),
  }),
  fallback: (p) =>
    joinLines(
      `Before I start: ${p.title}`,
      p.brief,
      ...p.can.map((c) => `It can: ${c}`),
      ...p.aside.map((a) => `It will put aside: ${a}`),
      p.budget,
    ),
});

const changeReview = define({
  type: "changeReview",
  group: "host",
  since: 1,
  hostOnly: true,
  description: "An agent's staged changes as one diff: approve or reject each row, or all of them",
  props: z.object({
    changeSetId: line(80),
    title: line(200),
    /** Why these need the person. */
    text: z.string().max(400).optional(),
  }),
  fallback: (p) => joinLines(`Changes to review: ${p.title}`, p.text),
});

const gate = z.object({ kind: z.enum(["plain", "jev"]), text: line(300) });

const routineReadBack = define({
  type: "routineReadBack",
  group: "host",
  since: 1,
  hostOnly: true,
  description: "A routine read back for confirmation, with its backtest",
  props: z.object({
    title: line(120).optional(),
    summary: line(500),
    trigger: line(300),
    gates: z.array(gate).max(8).default([]),
    backtest: z
      .object({
        days: z.number().int().min(1),
        fired: z.number().int().min(0),
        /** One entry per day, oldest first: would it have sent anything that day? */
        fires: z.array(z.boolean()).max(31).optional(),
        examples: z
          .array(z.object({ text: line(300), passed: z.boolean() }))
          .max(6)
          .default([]),
      })
      .optional(),
    /** Plain warnings: no data to try it on, a very broad trigger. */
    notes: z.array(line(300)).max(4).default([]),
    actions: actionsSchema.optional(),
  }),
  fallback: (p) =>
    joinLines(
      p.title,
      p.summary,
      `When: ${p.trigger}`,
      ...p.gates.map((g) => `Only if: ${g.text}`),
      p.backtest && `Would have messaged you ${p.backtest.fired} times in ${p.backtest.days} days.`,
      ...p.notes,
      buttons(p.actions),
    ),
});

const routineList = define({
  type: "routineList",
  group: "host",
  since: 1,
  hostOnly: true,
  description: "Your routines with status, last run and next run",
  props: z.object({
    routines: z
      .array(
        z.object({
          id: line(80),
          name: line(200),
          status: z.enum(["on", "paused", "failing"]),
          lastRun: z.string().max(80).optional(),
          nextRun: z.string().max(80).optional(),
          actions: actionsSchema.optional(),
        }),
      )
      .max(30),
  }),
  fallback: (p) =>
    numbered(
      p.routines.map((r) =>
        [r.name, r.status, r.nextRun && `next ${r.nextRun}`].filter(Boolean).join(", "),
      ),
    ),
});

const check = z.object({ text: line(300), passed: z.boolean() });

const whyThis = define({
  type: "whyThis",
  group: "host",
  since: 1,
  hostOnly: true,
  description: "Why a message came: the routine, its trigger and the checks that passed",
  props: z.object({
    routine: line(200),
    trigger: line(300),
    checks: z.array(check).max(8).default([]),
    jev: check.optional(),
    actions: actionsSchema.optional(),
  }),
  fallback: (p) =>
    joinLines(
      `Sent by "${p.routine}" because ${p.trigger}`,
      ...p.checks.map((c) => `${c.passed ? "Passed" : "Failed"}: ${c.text}`),
      p.jev && `Checked: ${p.jev.text}`,
    ),
});

const memorySaved = define({
  type: "memorySaved",
  group: "host",
  since: 1,
  hostOnly: true,
  description: "Saved to memory, with the line and its condition",
  props: z.object({
    line: line(500),
    condition: z.string().max(300).optional(),
    actions: actionsSchema.optional(),
  }),
  fallback: (p) => `Saved to memory: ${p.line}${p.condition ? ` (when ${p.condition})` : ""}`,
});

const conditionalMemoryReadBack = define({
  type: "conditionalMemoryReadBack",
  group: "host",
  since: 1,
  hostOnly: true,
  description: "A conditional memory read back for confirmation",
  props: z.object({
    condition: line(300),
    line: line(500),
    actions: actionsSchema.optional(),
  }),
  fallback: (p) => `When ${p.condition}: ${p.line}`,
});

const pluginInstall = define({
  type: "pluginInstall",
  group: "host",
  since: 1,
  hostOnly: true,
  description: "What a plugin adds, its scopes and the extensions it needs",
  props: z.object({
    name: line(120),
    publisher: z.string().max(120).optional(),
    adds: z
      .array(z.object({ kind: line(40), label: line(200) }))
      .max(20)
      .default([]),
    scopes: z.array(line(80)).max(10).default([]),
    needs: z.array(line(120)).max(10).default([]),
    actions: actionsSchema.optional(),
  }),
  fallback: (p) =>
    joinLines(
      `Install ${p.name}${p.publisher ? ` by ${p.publisher}` : ""}`,
      p.adds.length ? `Adds: ${p.adds.map((a) => `${a.label} (${a.kind})`).join(", ")}` : null,
      p.scopes.length ? `Access: ${p.scopes.join(", ")}` : null,
      p.needs.length ? `Needs: ${p.needs.join(", ")}` : null,
    ),
});

const pluginUpdate = define({
  type: "pluginUpdate",
  group: "host",
  since: 1,
  hostOnly: true,
  description: "A plugin update: upstream changes, your edits and the merged proposal",
  props: z.object({
    name: line(120),
    upstream: z.array(line(300)).max(10).default([]),
    yours: z.array(line(300)).max(10).default([]),
    merged: z
      .array(z.object({ kind: z.enum(["add", "remove", "same"]), text: z.string().max(300) }))
      .max(60)
      .default([]),
    actions: actionsSchema.optional(),
  }),
  fallback: (p) =>
    joinLines(
      `Update for ${p.name}`,
      p.upstream.length ? `Upstream:\n${bullets(p.upstream)}` : null,
      p.yours.length ? `Your edits:\n${bullets(p.yours)}` : null,
    ),
});

const connectionNeeded = define({
  type: "connectionNeeded",
  group: "host",
  since: 1,
  hostOnly: true,
  description: "This needs a connection (your Gmail), with its status",
  props: z.object({
    service: line(80),
    reason: line(300),
    status: z.enum(["missing", "connected", "error"]),
    connect: actionSchema.optional(),
  }),
  fallback: (p) => `${p.reason} (${p.service}: ${p.status})`,
});

const agentConnectionRequest = define({
  type: "agentConnectionRequest",
  group: "host",
  since: 1,
  hostOnly: true,
  description: "A colleague wants to connect assistants, with the proposed rules",
  props: z.object({
    from: line(120),
    rules: z.array(line(300)).min(1).max(10),
    actions: actionsSchema.optional(),
  }),
  fallback: (p) => joinLines(`${p.from} wants to connect assistants.`, bullets(p.rules)),
});

const agentRequest = define({
  type: "agentRequest",
  group: "host",
  since: 1,
  hostOnly: true,
  description: "A colleague's assistant asks for something",
  props: z.object({
    from: line(120),
    request: line(500),
    rule: z.string().max(300).optional(),
    actions: actionsSchema.optional(),
  }),
  fallback: (p) => `${p.from}'s assistant asks: ${p.request}`,
});

const agentLogEntry = define({
  type: "agentLogEntry",
  group: "host",
  since: 1,
  hostOnly: true,
  description: "What was shared with a colleague's assistant, under which rule, and the check",
  props: z.object({
    direction: z.enum(["sent", "received"]),
    with: line(120),
    shared: line(500),
    rule: z.string().max(300).optional(),
    verdict: z.object({ allowed: z.boolean(), text: line(300) }),
    when: line(80),
    open: hrefSchema.optional(),
  }),
  fallback: (p) =>
    `${p.when}: ${p.direction === "sent" ? "Shared with" : "Received from"} ${p.with}: ${p.shared} (${p.verdict.allowed ? "allowed" : "blocked"}: ${p.verdict.text})`,
});

// --- The catalogue ---------------------------------------------------------------------------

export const CATALOGUE = [
  card,
  stack,
  text,
  heading,
  divider,
  keyValue,
  badge,
  recordChip,
  list,
  table,
  actions,
  link,
  image,
  progress,
  emptyState,
  recordCard,
  recordList,
  recordDiff,
  searchResults,
  relatedRecords,
  taskList,
  taskCard,
  timeline,
  emailPreview,
  emailDraft,
  logger,
  dealCard,
  dealList,
  pipelineSnapshot,
  stageMoveConfirm,
  meetingCard,
  meetingPrep,
  availabilitySlots,
  kpi,
  chart,
  leaderboard,
  recordForm,
  form,
  choice,
  confirm,
  fileUpload,
  approval,
  routineReadBack,
  routineList,
  whyThis,
  memorySaved,
  conditionalMemoryReadBack,
  pluginInstall,
  pluginUpdate,
  connectionNeeded,
  agentConnectionRequest,
  agentRequest,
  agentLogEntry,
  agentJob,
  agentGrant,
  changeReview,
] as const;

export type CatalogueComponent = (typeof CATALOGUE)[number];
export type ComponentType = CatalogueComponent["type"];

/** The props of a component type, as validated (defaults applied). */
export type PropsOf<T extends ComponentType> = z.output<
  Extract<CatalogueComponent, { type: T }>["props"]
>;

/**
 * Stage 12 to 16 components (import, duplicates, leads, sequences). They join the catalogue with
 * those stages; until then a card naming one shows its text fallback.
 */
export const RESERVED_COMPONENTS = [
  "importMapping",
  "importProgress",
  "duplicateSuggestion",
  "leadCard",
  "sequenceCard",
] as const;

const BY_TYPE = new Map<string, ComponentDefinition>(
  CATALOGUE.map((c) => [c.type, c as unknown as ComponentDefinition]),
);

/** A component's definition, or undefined for a type the catalogue does not have. */
export function componentDefinition(type: string): ComponentDefinition | undefined {
  return BY_TYPE.get(type);
}

/** The catalogue in one line per component, without props (for people and logs). */
export function catalogueSummary(options: { includeHostOnly?: boolean } = {}): string {
  return CATALOGUE.filter((c) => options.includeHostOnly || !("hostOnly" in c && c.hostOnly))
    .map((c) => `- ${c.type}: ${c.description}`)
    .join("\n");
}

// --- The catalogue as the model reads it -----------------------------------------------------

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  enum?: unknown[];
  const?: unknown;
  additionalProperties?: JsonSchema | boolean;
};

/** A schema as a short shape: `{title, tasks:[{id, title, dueLabel?}], viewAll?}`. */
function shape(schema: JsonSchema, depth = 0): string {
  const branches = schema.anyOf ?? schema.oneOf;
  if (branches?.some((b) => b.properties?.kind)) return "Action";
  if (branches) return branches.map((b) => shape(b, depth)).join("|");
  if (schema.enum) return schema.enum.join("|");
  if (schema.const !== undefined) return String(schema.const);
  if (schema.type === "array") {
    return `[${schema.items ? shape(schema.items, depth + 1) : "any"}]`;
  }
  if (schema.type === "object" && schema.properties) {
    const keys = Object.keys(schema.properties);
    if (keys.includes("object") && keys.includes("id") && keys.includes("label")) return "Record";
    if (depth > 3) return "{…}";
    const fields = Object.entries(schema.properties).map(([key, value]) => {
      const optional = schema.required?.includes(key) ? "" : "?";
      return `${key}${optional}:${shape(value, depth + 1)}`;
    });
    return `{${fields.join(", ")}}`;
  }
  if (schema.type === "object") return "{…}";
  if (schema.type === "integer") return "number";
  return typeof schema.type === "string" ? schema.type : "any";
}

/**
 * What the model reads to write a card: the document's form, then each component it may send with
 * its props. Deterministic, because it sits in the cached prefix (ADR 0341).
 */
export function catalogueGuide(): string {
  const lines = CATALOGUE.filter((c) => !("hostOnly" in c && c.hostOnly)).map((c) => {
    const schema = z.toJSONSchema(c.props, { io: "input", unrepresentable: "any" }) as JsonSchema;
    const { children: _children, ...fields } = schema.properties ?? {};
    const props = shape({ type: "object", properties: fields, required: schema.required ?? [] });
    return `- ${c.type} ${"container" in c && c.container ? `${props} + children:[component]` : props}: ${c.description}`;
  });
  return [
    `A card is { "a2ui": ${A2UI_CATALOGUE_VERSION}, "root": component }, and a component is { "type": name, ...props }.`,
    'Action: { kind: "operation", label, operation, input, confirm?, done? } | { kind: "open", label, href } | { kind: "reply", label, text }.',
    "Record: { object, id, label, subtitle? }. Links are paths such as /people/per_… or https URLs.",
    "Components:",
    ...lines,
  ].join("\n");
}
