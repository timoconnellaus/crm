// One realistic card per catalogue component: what hosts' render tests and galleries draw, so a
// new component cannot land without a sample (the package's tests check that every type has one).
import type { ComponentType } from "./catalogue.ts";
import { A2UI_CATALOGUE_VERSION } from "./catalogue.ts";
import type { A2uiDocument, A2uiNode } from "./document.ts";

const ade = {
  object: "person",
  id: "per_01KA8ZQ7Y2V3N4M5P6R7S8T9W0",
  label: "Ade Okafor",
  subtitle: "Head of Operations",
};
const kestrel = {
  object: "organisation",
  id: "org_01KA8ZQ7Y2V3N4M5P6R7S8T9W1",
  label: "Kestrel Energy",
  subtitle: "kestrel.energy",
};
const deal = {
  object: "deals.deal",
  id: "deals_deal_01KA8ZQ7Y2V3N4M5P6R7S8T9W2",
  label: "Brightwater renewal 2027",
  subtitle: "Brightwater Health",
};
const open = (label: string, href: string) => ({ kind: "open", label, href });
const operation = (label: string, name: string, input: Record<string, unknown> = {}) => ({
  kind: "operation",
  label,
  operation: name,
  input,
});

export const SAMPLES: Record<ComponentType, A2uiNode> = {
  card: {
    type: "card",
    title:
      "Kestrel Energy renewal notes with a long title that has to wrap or cut in a narrow panel",
    subtitle: "Updated today",
    badge: { text: "Pending", tone: "warning" },
    children: [
      { type: "text", text: "Tom confirmed the **larger site** and a January start." },
      { type: "keyValue", items: [{ label: "Owner", value: "Maya Chen" }] },
    ],
    actions: [open("Open", "/organisations/org_1"), operation("Create task", "task.create")],
  },
  stack: {
    type: "stack",
    children: [
      { type: "heading", text: "This week" },
      { type: "text", text: "Three calls and a renewal.", muted: true },
    ],
  },
  text: { type: "text", text: "Your **second** task is due [tomorrow](/tasks)." },
  heading: { type: "heading", text: "Next steps" },
  divider: { type: "divider" },
  keyValue: {
    type: "keyValue",
    items: [
      { label: "Owner", value: "Maya Chen" },
      { label: "Stage", value: "Proposal" },
      { label: "Organisation", value: "Kestrel Energy", record: kestrel },
      {
        label: "Email",
        value: "a.very.long.address.for.ade.okafor@brightwater-health.example.com",
      },
    ],
  },
  badge: { type: "badge", text: "Overdue", tone: "danger" },
  recordChip: { type: "recordChip", record: ade },
  list: {
    type: "list",
    ordered: true,
    items: [
      { text: "Send the renewal order form", secondary: "Due Fri 7 Nov" },
      { text: "Book the SSO workshop with Raj", record: ade },
    ],
  },
  table: {
    type: "table",
    columns: [
      { key: "name", label: "Name" },
      { key: "stage", label: "Stage" },
      { key: "value", label: "Value", align: "end" },
      { key: "owner", label: "Owner" },
      { key: "close", label: "Expected close" },
    ],
    rows: [
      {
        name: "Harbour & Finch rollout",
        stage: "Proposal",
        value: 32000,
        owner: "Sam Ortiz",
        close: "15 Dec 2026",
      },
      {
        name: "Fernhill Foods trial",
        stage: "Negotiation",
        value: 24500,
        owner: "Maya Chen",
        close: "30 Jan 2027",
      },
    ],
    viewAll: { label: "View all", href: "/x/deals.deal" },
  },
  actions: {
    type: "actions",
    actions: [
      operation("Create follow-up tasks", "task.create"),
      { kind: "reply", label: "Show me more", text: "Show me more" },
      {
        ...operation("Delete", "person.delete", { id: ade.id }),
        style: "destructive",
        confirm: "Confirm: delete Ade Okafor",
      },
      open("Open", "/tasks"),
    ],
  },
  link: { type: "link", label: "Open Kestrel Energy", href: "/organisations/org_1" },
  image: { type: "image", src: "/favicon.ico", alt: "The app's icon", width: 48 },
  progress: {
    type: "progress",
    label: "Importing contacts",
    value: 120,
    max: 480,
    detail: "120 of 480 rows",
  },
  emptyState: {
    type: "emptyState",
    title: "Nothing due today",
    text: "You are clear until Monday.",
    action: open("Open Tasks", "/tasks"),
  },
  recordCard: {
    type: "recordCard",
    record: ade,
    facts: [
      { label: "Email", value: "ade.okafor@brightwater.health" },
      { label: "Owner", value: "Maya Chen" },
      { label: "Organisation", value: "Kestrel Energy", record: kestrel },
    ],
    actions: [open("Open", "/people/per_1"), operation("Create task", "task.create")],
  },
  recordList: {
    type: "recordList",
    title: "People at Kestrel Energy",
    columns: ["Name", "Role", "Last activity"],
    rows: [
      { record: { ...ade, subtitle: undefined }, values: ["Head of Operations", "Today"] },
      {
        record: { object: "person", id: "per_2", label: "Nora Webb" },
        values: ["Finance", "3 days ago"],
      },
    ],
    total: 14,
    bulkActions: [operation("Tag all", "person.updateMany")],
    viewAll: "/people",
  },
  recordDiff: {
    type: "recordDiff",
    title: "Update Kestrel Energy expansion",
    record: deal,
    changes: [
      { field: "Stage", before: "Qualified", after: "Proposal" },
      { field: "Value", before: "$86,000", after: "$92,500" },
      { field: "Next step", before: null, after: "Send the order form" },
    ],
    actions: [operation("Apply", "record.update", { id: deal.id })],
  },
  searchResults: {
    type: "searchResults",
    query: "energy renewals",
    groups: [
      {
        label: "Organisations",
        hits: [{ record: kestrel, snippet: "Energy retailer, 640 employees", matchedBy: "text" }],
      },
      {
        label: "Deals",
        hits: [{ record: deal, snippet: "Renewal for next year", matchedBy: "meaning" }],
      },
    ],
    refine: { kind: "reply", label: "Only deals", text: "Only the deals, please" },
  },
  relatedRecords: {
    type: "relatedRecords",
    title: "Related to Kestrel Energy",
    record: kestrel,
    groups: [
      { label: "People", records: [ade, { object: "person", id: "per_2", label: "Nora Webb" }] },
      { label: "Deals", records: [deal] },
    ],
  },
  taskList: {
    type: "taskList",
    title: "Due this week",
    tasks: [
      {
        id: "tsk_1",
        title: "Send renewal order form with a title long enough that it must be cut off",
        dueLabel: "Due Fri 7 Nov",
        record: { object: "organisation", id: "org_2", label: "Brightwater Health" },
      },
      {
        id: "tsk_2",
        title: "Chase Kestrel NDA",
        dueLabel: "Due Mon 3 Nov",
        overdue: true,
        record: kestrel,
      },
      {
        id: "tsk_3",
        title: "Call back Lena Fischer",
        done: true,
        assignee: { id: "usr_1", name: "Maya Chen" },
      },
    ],
    total: 4,
    viewAll: "/tasks",
  },
  taskCard: {
    type: "taskCard",
    task: {
      id: "tsk_1",
      title: "Send renewal order form",
      dueLabel: "Due Fri 7 Nov",
      record: kestrel,
      assignee: { id: "usr_1", name: "Maya Chen" },
      notes: "Ade wants the January start date on it.",
    },
  },
  timeline: {
    type: "timeline",
    record: kestrel,
    entries: [
      {
        kind: "email",
        title: "Re: site count for January",
        when: "Today",
        text: "Confirmed 14 sites.",
      },
      { kind: "call", title: "Call with Tom Becker", when: "Thu 30 Oct" },
      { kind: "note", title: "Prefers calls before 10", when: "Mon 27 Oct" },
    ],
    actions: [{ kind: "reply", label: "Log a follow-up", text: "Log a follow-up on Kestrel" }],
  },
  emailPreview: {
    type: "emailPreview",
    subject: "Re: site count for January",
    from: { name: "Tom Becker", email: "tom@kestrel.energy" },
    when: "Today, 9:14 am",
    snippet: "Thanks Maya. We can confirm 14 sites, and a start in the second week of January.",
    actions: [open("Open thread", "/activity"), operation("Create task", "task.create")],
  },
  emailDraft: {
    type: "emailDraft",
    to: [{ name: "Tom Becker", email: "tom@kestrel.energy" }],
    cc: [{ name: "Maya Chen" }],
    subject: "Your January rollout",
    body: "Hi Tom,\n\nThanks for confirming the site count. I've attached the updated order form.\n\nMaya",
    attachments: ["kestrel-order-form.pdf"],
    send: { operation: "email.send", input: { connectionId: "con_1" } },
  },
  logger: {
    type: "logger",
    kind: "call",
    record: kestrel,
    subject: "Call with Tom Becker",
  },
  dealCard: {
    type: "dealCard",
    deal,
    value: "$48,000",
    stage: "Proposal",
    stageIndex: 3,
    stageCount: 5,
    facts: [
      { label: "In stage", value: "12 days" },
      { label: "Close date", value: "Mon 15 Dec" },
      { label: "Last activity", value: "Today, email from Ade" },
    ],
    actions: [
      operation("Move to Negotiation", "x.deals.moveStage"),
      open("Open", "/x/deals.deal/1"),
    ],
  },
  dealList: {
    type: "dealList",
    title: "Quiet for 14+ days",
    summary: "3 deals · $142,500",
    deals: [
      {
        deal: { ...deal, label: "Harbour & Finch rollout" },
        detail: "Proposal · 21 days since activity",
        value: "$32,000",
      },
      {
        deal: { ...deal, label: "Kestrel Energy expansion" },
        detail: "Qualified · 15 days since activity",
        value: "$86,000",
      },
    ],
    actions: [
      {
        kind: "reply",
        label: "Create follow-up tasks",
        text: "Create follow-up tasks for these deals",
      },
    ],
  },
  pipelineSnapshot: {
    type: "pipelineSnapshot",
    title: "New business",
    summary: "23 open · $642,000",
    stages: [
      { label: "Qualified", count: 9, value: 210000, valueLabel: "$210k" },
      { label: "Proposal", count: 8, value: 255000, valueLabel: "$255k" },
      { label: "Negotiation", count: 6, value: 177000, valueLabel: "$177k" },
    ],
    open: "/x/deals.deal",
  },
  stageMoveConfirm: {
    type: "stageMoveConfirm",
    deal,
    from: "Proposal",
    to: "Negotiation",
    fields: [
      { name: "values.expectedClose", label: "Expected close", kind: "date", required: true },
      { name: "values.nextStep", label: "Next step", kind: "text" },
    ],
    submit: {
      label: "Move deal",
      operation: "record.update",
      input: { id: deal.id },
      done: "Deal moved",
    },
  },
  meetingCard: {
    type: "meetingCard",
    title: "Kestrel rollout review",
    when: "Thu 6 Nov, 2:00 pm",
    where: "Google Meet",
    attendees: [ade, { object: "person", id: "per_2", label: "Nora Webb" }],
    records: [kestrel, deal],
    joinUrl: "https://meet.google.com/abc-defg-hij",
    actions: [{ kind: "reply", label: "Prep me", text: "Prep me for this meeting" }],
  },
  meetingPrep: {
    type: "meetingPrep",
    title: "Kestrel rollout review",
    when: "Thu 6 Nov, 2:00 pm",
    attendees: [ade],
    records: [kestrel],
    summary: "Tom confirmed 14 sites. The open question is the January start.",
    checked: true,
    recent: ["Email from Tom Becker today", "Call on Thu 30 Oct"],
    open: ["Brightwater renewal 2027, Proposal, $48,000", "Task: send order form"],
    actions: [operation("Create task", "task.create")],
  },
  availabilitySlots: {
    type: "availabilitySlots",
    title: "Free times with Tom",
    slots: [
      { start: "2026-11-07T00:00:00Z", label: "Fri 7 Nov, 11:00 am" },
      { start: "2026-11-10T02:00:00Z", label: "Mon 10 Nov, 1:00 pm" },
      { start: "2026-11-11T04:30:00Z", label: "Tue 11 Nov, 3:30 pm" },
    ],
    pick: { operation: "task.create", input: { title: "Meeting with Tom" }, field: "dueAt" },
  },
  kpi: {
    type: "kpi",
    title: "Won this quarter",
    value: 128000,
    previous: 96000,
    format: "currency",
    currency: "AUD",
    open: "/dashboards",
  },
  chart: {
    type: "chart",
    title: "Deals by stage",
    chart: "bar",
    rows: [
      { stage: "Qualified", deals: 9 },
      { stage: "Proposal", deals: 8 },
      { stage: "Negotiation", deals: 6 },
    ],
    x: "stage",
    y: "deals",
    open: "/dashboards",
  },
  leaderboard: {
    type: "leaderboard",
    title: "Top owners by won value",
    rows: [
      { label: "Maya Chen", value: 84000 },
      { label: "Sam Ortiz", value: 44000 },
    ],
    format: "currency",
    currency: "AUD",
  },
  recordForm: {
    type: "recordForm",
    title: "New deal",
    object: "deals.deal",
    fields: [
      {
        name: "values.name",
        label: "Name",
        kind: "text",
        required: true,
        value: "Lumen Labs pilot",
      },
      {
        name: "values.organisation",
        label: "Organisation",
        kind: "record",
        object: "organisation",
        value: "org_3",
        valueLabel: "Lumen Labs",
      },
      { name: "values.value", label: "Value", kind: "money", value: 18000 },
      {
        name: "values.stage",
        label: "Stage",
        kind: "select",
        value: "qualified",
        options: [
          { value: "qualified", label: "Qualified" },
          { value: "proposal", label: "Proposal" },
        ],
      },
    ],
    submit: {
      label: "Create deal",
      operation: "record.create",
      input: { object: "deals.deal" },
      done: "Deal created",
    },
  },
  form: {
    type: "form",
    title: "Weekly digest",
    text: "When should it go out?",
    fields: [
      { name: "time", label: "Time", kind: "text", placeholder: "8:00 am" },
      { name: "day", label: "Day", kind: "date" },
      { name: "owner", label: "Send to", kind: "user", valueLabel: "Maya Chen", value: "usr_1" },
      { name: "note", label: "Note", kind: "textarea" },
      { name: "count", label: "Deals to show", kind: "number", value: 5 },
      { name: "quiet", label: "Skip quiet weeks", kind: "checkbox", value: true },
    ],
    submit: { label: "Save", operation: "settings.update", done: "Saved" },
  },
  choice: {
    type: "choice",
    question: "Which pipeline do you mean?",
    options: [{ label: "New business" }, { label: "Renewals", reply: "The renewals pipeline" }],
  },
  confirm: {
    type: "confirm",
    title: "Delete Kestrel Energy?",
    consequences: ["14 people lose their organisation", "It stays in Trash for 30 days"],
    confirm: {
      ...operation("Delete", "organisation.delete", { id: kestrel.id }),
      style: "destructive",
    },
  },
  fileUpload: {
    type: "fileUpload",
    title: "Add your contacts CSV",
    record: kestrel,
    accept: ".csv",
    href: "/import",
  },
  approval: {
    type: "approval",
    changeSetId: "aps_sample",
    actionIds: ["apa_sample"],
    title: "Update Kestrel Energy expansion",
    youAsked: "Move Kestrel to proposal at the new price",
  },
  routineReadBack: {
    type: "routineReadBack",
    summary: "Every weekday at 8am I'll send you the deals that went quiet.",
    trigger: "Weekdays at 8:00 am",
    gates: [
      { kind: "plain", text: "At least one deal has no activity for 14 days" },
      { kind: "jev", text: "The deal is still worth chasing" },
    ],
    backtest: {
      days: 30,
      fired: 18,
      examples: [
        { text: "Mon 3 Nov: 3 deals", passed: true },
        { text: "Sat 1 Nov: weekend", passed: false },
      ],
    },
    actions: [
      operation("Turn on", "settings.update"),
      { kind: "reply", label: "Edit", text: "Change it" },
    ],
  },
  routineList: {
    type: "routineList",
    routines: [
      {
        id: "rtn_1",
        name: "Morning briefing",
        status: "on",
        lastRun: "Today, 8:00 am",
        nextRun: "Tomorrow, 8:00 am",
        actions: [operation("Pause", "settings.update")],
      },
      { id: "rtn_2", name: "Stale deals", status: "paused", lastRun: "Mon 3 Nov" },
    ],
  },
  whyThis: {
    type: "whyThis",
    routine: "Morning briefing",
    trigger: "it is a weekday at 8:00 am",
    checks: [{ text: "3 deals have no activity for 14 days", passed: true }],
    jev: { text: "This is worth sending today", passed: true },
    actions: [operation("Pause routine", "settings.update")],
  },
  memorySaved: {
    type: "memorySaved",
    line: "Prefers calls before 10",
    actions: [operation("Undo", "settings.update")],
  },
  conditionalMemoryReadBack: {
    type: "conditionalMemoryReadBack",
    condition: "on an organisation with more than 500 employees",
    line: "Loop in Sam before quoting",
    actions: [operation("Confirm", "settings.update")],
  },
  pluginInstall: {
    type: "pluginInstall",
    name: "Pipeline hygiene",
    publisher: "Relationship OS",
    adds: [
      { kind: "Skill", label: "Stale deal review" },
      { kind: "Routine", label: "Monday pipeline check" },
    ],
    scopes: ["Read deals", "Create tasks"],
    needs: ["Deals"],
    actions: [operation("Install", "settings.update")],
  },
  pluginUpdate: {
    type: "pluginUpdate",
    name: "Pipeline hygiene",
    upstream: ["Adds a renewals check"],
    yours: ["Changed the threshold to 21 days"],
    merged: [
      { kind: "same", text: "threshold:" },
      { kind: "remove", text: "  days: 14" },
      { kind: "add", text: "  days: 21" },
    ],
    actions: [operation("Apply", "settings.update")],
  },
  connectionNeeded: {
    type: "connectionNeeded",
    service: "Gmail",
    reason: "This needs your Gmail to read the thread.",
    status: "missing",
    connect: open("Connect", "/settings/integrations"),
  },
  agentConnectionRequest: {
    type: "agentConnectionRequest",
    from: "Sam Ortiz",
    rules: ["Share availability", "Add tasks when I ask"],
    actions: [operation("Accept", "settings.update")],
  },
  agentRequest: {
    type: "agentRequest",
    from: "Sam",
    request: "Create a task for the Acme follow-up",
    rule: "Tasks from Sam's assistant need your OK",
    actions: [operation("Accept", "settings.update")],
  },
  agentJob: { type: "agentJob", jobId: "job_01", title: "Account research" },
  agentGrant: {
    type: "agentGrant",
    jobId: "job_01",
    title: "Account research",
    brief: "Research the 20 organisations in Q4 target list and fill in industry and website.",
    can: ["Fill empty fields on these 20 organisations, up to 60 changes", "Until 6:00 pm today"],
    aside: ["Changing a value that's already filled in", "Anything else, like emails or deleting"],
    budget: "Up to 200 steps, 30 minutes and $2.00.",
  },
  changeReview: {
    type: "changeReview",
    changeSetId: "chs_01",
    title: "Account research",
    text: "These replace values already on the record, so they need you.",
  },
  agentLogEntry: {
    type: "agentLogEntry",
    direction: "sent",
    with: "Sam Ortiz",
    shared: "Your free times next week",
    rule: "Share availability",
    verdict: { allowed: true, text: "Only times were shared" },
    when: "Today, 10:02 am",
    open: "/assistant",
  },
};

/** A sample as a whole card. */
export function sampleDocument(type: ComponentType): A2uiDocument {
  return { a2ui: A2UI_CATALOGUE_VERSION, root: SAMPLES[type] };
}
