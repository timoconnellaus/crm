// The 10 "automate this…" prompts of the stage 5 automations eval (docs/stages/05-automations.md,
// criterion 9). For each one an MCP client model writes an extension with an automation over MCP
// and proposes it. After a person approves the proposals, the grader holds each automation to:
//
//   1. `extension_check` passes on the working copy;
//   2. `automation.test` on the case's seeded record (nothing written) reports the expected writes,
//      notifications and waits, and that the trigger matched;
//   3. the host summary (`automation.get` → summary.text, generated from the declarations, no AI)
//      states the intent: deterministic keyword groups, plus an LLM judge with a rubric.
//
// Extension ids are unique per run: `idBase` + the run's generated word, as in evals/extensions.

/** Trigger types the SDK's defineAutomation knows (packages/sdk/src/automation.ts). */
export type TriggerType =
  | "record"
  | "fieldChanged"
  | "schedule"
  | "dateRelative"
  | "manual"
  | "approvalDecided";

/**
 * The record a case is tested on, created by the grader before any automation is authored (so the
 * eval's own automations never fire on it). `self` stands for the eval user's id; `stageType`
 * puts a deal in the first stage of that type; `daysFromToday` sets a date field relative to the
 * run's date.
 */
export interface SeedSpec {
  object: "person" | "organisation" | "deals.deal";
  values: Record<string, unknown>;
  /** Fields set to the eval user's id (e.g. a deal's `owner`). */
  self?: string[];
  stageType?: "open" | "won" | "lost";
  /** Date fields set to today + N days (YYYY-MM-DD). */
  daysFromToday?: Record<string, number>;
}

export interface ExpectedTest {
  /** Exact counts of records the test run would create or change, by object. */
  writes: Record<string, number>;
  /** How many notifications it would send. */
  notifications: number;
  /**
   * Who they go to: `owner` (the seeded record's owner, the eval user) or `admins` (the eval
   * user is an admin). Either way the eval user must be among the recipients.
   */
  notify?: "owner" | "admins";
  /** Durable waits (sleep / waitForEvent) the run would take, skipped in test mode. */
  waits: number;
}

export interface AutomationCase {
  id: string;
  title: string;
  covers: string[];
  idBase: string;
  /** What the user asks for. */
  request: string;
  /** The intent the host summary must state, for the judge (one sentence). */
  intent: string;
  /** Trigger types that implement the request. */
  triggers: TriggerType[];
  seed: SeedSpec | null;
  expect: ExpectedTest;
  /** Each group must match the host summary at least once (case-insensitive patterns). */
  keywords: RegExp[][];
}

/** The extension id the model is told to use: `idBase` + the run's word, lower case. */
export function extensionIdFor(c: AutomationCase, slug: string): string {
  return `${c.idBase}${slug.toLowerCase().replace(/[^a-z0-9]/g, "")}`.slice(0, 30);
}

/** The user message: the request, the extension id to use, and that it ends up proposed. */
export function promptText(c: AutomationCase, extensionId: string): string {
  return (
    `Automate this: ${c.request}\n\nDo it with one automation (defineAutomation) in a CRM ` +
    `extension whose id is \`${extensionId}\`. Declare its steps and their intents (writes, ` +
    "notifies, waits) so the host can summarise it. Make sure it passes check, then propose it " +
    "for approval."
  );
}

const DEAL = /\bdeals?\b/i;
const OWNER = /\bowner/i;
const ADMINS = /\badmin/i;
const TASK = /\btasks?\b/i;
const NOTIFY = /notif/i;

export const cases: AutomationCase[] = [
  {
    id: "won-thank-you",
    title: "Won deal: a thank-you task and a notification for the owner",
    covers: ["fieldChanged", "stageType won", "write task", "notify field"],
    idBase: "wonthanks",
    request:
      "When a deal is won, create a task for the deal's owner to send the customer a thank-you " +
      "note, linked to the deal, and notify the owner.",
    intent:
      "When a deal's stage changes to a won stage, it creates one thank-you task for the deal's " +
      "owner and notifies the owner.",
    triggers: ["fieldChanged"],
    seed: {
      object: "deals.deal",
      values: { name: "Eval won deal", value: 12000 },
      self: ["owner"],
      stageType: "won",
    },
    expect: { writes: { task: 1 }, notifications: 1, notify: "owner", waits: 0 },
    keywords: [[DEAL], [/\bwon\b/i], [TASK], [OWNER]],
  },
  {
    id: "lost-deal-admins",
    title: "Lost deal: tell the admins",
    covers: ["fieldChanged", "stageType lost", "notify admins"],
    idBase: "lostalert",
    request: "When a deal is lost, notify the admins with the deal's name.",
    intent: "When a deal's stage changes to a lost stage, it notifies the admins.",
    triggers: ["fieldChanged"],
    seed: {
      object: "deals.deal",
      values: { name: "Eval lost deal", value: 5000, lostReason: "price" },
      self: ["owner"],
      stageType: "lost",
    },
    expect: { writes: {}, notifications: 1, notify: "admins", waits: 0 },
    keywords: [[DEAL], [/\blost\b/i], [ADMINS]],
  },
  {
    id: "new-person-welcome",
    title: "New person: a welcome-email task",
    covers: ["record created", "core object", "write task"],
    idBase: "welcome",
    request:
      "Whenever a new person is added, create a task to send them a welcome email, linked to " +
      "the person.",
    intent: "When a person is created, it creates one task to send them a welcome email.",
    triggers: ["record"],
    seed: { object: "person", values: { displayName: "Eval Welcome Person" } },
    expect: { writes: { task: 1 }, notifications: 0, waits: 0 },
    keywords: [[/\bpe(rson|ople)\b/i], [/creat|added|new/i], [TASK]],
  },
  {
    id: "org-check-in",
    title: "New organisation: check in after two days",
    covers: ["record created", "sleep", "write task"],
    idBase: "checkin",
    request:
      "When an organisation is created, wait 2 days and then create a task to check in with " +
      "them, linked to the organisation.",
    intent: "When an organisation is created, after 2 days it creates one check-in task.",
    triggers: ["record"],
    seed: { object: "organisation", values: { name: "Eval Check-in Ltd" } },
    expect: { writes: { task: 1 }, notifications: 0, waits: 1 },
    keywords: [[/organi[sz]ation/i], [/\b(2|two) days\b/i], [TASK]],
  },
  {
    id: "close-date-reminder",
    title: "A week before the expected close date: remind the owner",
    covers: ["dateRelative", "negative offset", "notify field"],
    idBase: "closesoon",
    request:
      "Seven days before a deal's expected close date, notify the deal's owner so they can " +
      "prepare.",
    intent: "7 days before a deal's expected close date, it notifies the deal's owner.",
    triggers: ["dateRelative"],
    seed: {
      object: "deals.deal",
      values: { name: "Eval closing deal", value: 8000 },
      self: ["owner"],
      stageType: "open",
      daysFromToday: { expectedClose: 7 },
    },
    expect: { writes: {}, notifications: 1, notify: "owner", waits: 0 },
    keywords: [[DEAL], [/expected ?close/i], [/\b(7|seven) days\b/i], [/before/i], [OWNER]],
  },
  {
    id: "big-deal-alert",
    title: "A deal over 50,000 is created: tell the admins",
    covers: ["record created", "conditions", "notify admins"],
    idBase: "bigdeal",
    request:
      "When a deal worth more than 50,000 is created, notify the admins. Smaller deals should " +
      "not notify anyone.",
    intent: "When a deal is created with a value over 50,000, it notifies the admins.",
    triggers: ["record"],
    seed: {
      object: "deals.deal",
      values: { name: "Eval big deal", value: 100000 },
      self: ["owner"],
      stageType: "open",
    },
    expect: { writes: {}, notifications: 1, notify: "admins", waits: 0 },
    keywords: [[DEAL], [/creat/i], [/50[,. ]?000|50k/i], [ADMINS]],
  },
  {
    id: "weekly-digest",
    title: "Every Monday at 9: a pipeline review reminder",
    covers: ["schedule", "cron", "notify admins"],
    idBase: "weekly",
    request: "Every Monday at 9am, send the admins a notification to review the pipeline.",
    intent: "Every Monday at 9:00 it notifies the admins to review the pipeline.",
    triggers: ["schedule"],
    seed: null,
    expect: { writes: {}, notifications: 1, notify: "admins", waits: 0 },
    keywords: [[/monday/i], [/\b9(:00)?\b|09:00|9 ?am/i], [ADMINS]],
  },
  {
    id: "manual-renewal-task",
    title: "A button on organisations: create a renewal task",
    covers: ["manual", "write task"],
    idBase: "renewbtn",
    request:
      'Add a button called "Create renewal task" on organisation pages that creates a task to ' +
      "discuss the renewal, linked to the organisation.",
    intent:
      "When someone clicks Create renewal task on an organisation, it creates one renewal task.",
    triggers: ["manual"],
    seed: { object: "organisation", values: { name: "Eval Renewals Pty" } },
    expect: { writes: { task: 1 }, notifications: 0, waits: 0 },
    keywords: [[/organi[sz]ation/i], [/renewal/i], [TASK], [/button|manual|click|run/i]],
  },
  {
    id: "rejected-change",
    title: "A change is rejected: tell the admins",
    covers: ["approvalDecided", "notify admins"],
    idBase: "rejected",
    request: "Whenever a change waiting for approval is rejected, notify the admins.",
    intent: "When a pending change is rejected in Approvals, it notifies the admins.",
    triggers: ["approvalDecided"],
    seed: null,
    expect: { writes: {}, notifications: 1, notify: "admins", waits: 0 },
    keywords: [[/reject/i], [/approv/i], [ADMINS]],
  },
  {
    id: "new-deal-kickoff",
    title: "New deal: two tasks, then a reminder a day later",
    covers: ["record created", "write ×2", "sleep", "notify field"],
    idBase: "kickoff",
    request:
      'When a deal is created, create two tasks for its owner, "Qualify the lead" and "Book a ' +
      'demo", linked to the deal. One day later, notify the owner to follow up.',
    intent:
      "When a deal is created, it creates 2 tasks for the deal's owner, and after 1 day it " +
      "notifies the owner.",
    triggers: ["record"],
    seed: {
      object: "deals.deal",
      values: { name: "Eval kickoff deal", value: 3000 },
      self: ["owner"],
      stageType: "open",
    },
    expect: { writes: { task: 2 }, notifications: 1, notify: "owner", waits: 1 },
    keywords: [[DEAL], [/creat/i], [/\b(2|two)\b/i], [TASK], [/\b(1|one) day\b/i], [OWNER, NOTIFY]],
  },
];
