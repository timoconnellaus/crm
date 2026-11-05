// The daily digest's content (stage 6b ADR 0172, stage 7b ADR 0206): for one person, the changes
// others made to records they own or are assigned in the last 24 hours, their tasks due today or
// overdue, the approvals waiting (for people who can approve) and their unread notices. Each
// section is capped and every item links into the app.
//
// The same facts become two messages: `plainDigest` (the email, plain text with absolute links)
// and `digestMarkdown` (the in-app notification body, Markdown with app paths). Composing the
// email is a seam (`DigestComposer`). The optional AI overview is one `summarise` call made by the
// delivery cron (`digestOverview`); it is labelled AI-generated wherever it shows, and on any
// error, or without AI, the digest goes out without it.
import type { ModelMessage, ModelRunner } from "../ai/client.ts";
import { NOTIFICATION_TYPES, type NotificationType } from "./types.ts";

export interface DigestItem {
  type: NotificationType;
  title: string;
  body: string | null;
  /** Absolute URL in the app, when the notice links somewhere and the app origin is known. */
  url: string | null;
  /** The app path, when the notice links somewhere. */
  href?: string | null;
  createdAt: string;
}

/** One record of the person's that others changed (several changes to it are one entry). */
export interface DigestChange {
  /** Registry name: `person`, `organisation`, `task`, `deals.deal`, … */
  object: string;
  objectLabel: string;
  id: string;
  title: string;
  /** What happened, newest first, without repeats: `update`, `create`, `delete`, … */
  actions: string[];
  /** Labels of the fields changed (empty for a create or delete). */
  fields: string[];
  /** Who changed it: a person's name, "AI assistant", "An automation", "A connected app". */
  by: string[];
  /** How many changes (audit rows) it had. */
  count: number;
  /** The latest change. */
  at: string;
  href: string | null;
  url: string | null;
}

/** A task assigned to the person, due today or overdue. */
export interface DigestTask {
  id: string;
  title: string;
  /** `YYYY-MM-DD` or an ISO timestamp, as stored. */
  dueAt: string;
  overdue: boolean;
  href: string | null;
  url: string | null;
}

export interface DigestInput {
  recipient: { userId: string; name: string | null; email: string };
  /** The local date (automation timezone) the digest is for. */
  date: string;
  /** Records the person owns or is assigned that others changed (at most DIGEST_SECTION_ITEMS). */
  changes?: DigestChange[];
  /** Every such record found (changes may be fewer). */
  changesTotal?: number;
  /** Open tasks assigned to the person, due today or overdue (at most DIGEST_SECTION_ITEMS). */
  tasks?: DigestTask[];
  /** Every such task, counted up to DIGEST_COUNT_CAP. */
  tasksTotal?: number;
  /** Unread notices from the last 24 hours, newest first (at most DIGEST_ITEMS). */
  items: DigestItem[];
  /** Every unread notice from the last 24 hours (items may be fewer). */
  unreadTotal: number;
  /** Pending actions in the approvals inbox (0 for someone who cannot approve). */
  pendingApprovals: number;
  /** The approvals inbox, absolute, when the app origin is known. */
  approvalsUrl: string | null;
  /** A one or two sentence AI overview (the `summarise` role), or null. Labelled when shown. */
  overview?: string | null;
}

export interface DigestMessage {
  subject: string;
  text: string;
}

/** Turns a digest's facts into an email. */
export type DigestComposer = (input: DigestInput) => DigestMessage | Promise<DigestMessage>;

/** Unread notices listed (the email had 20 before stage 7b; the in-app digest lists 10). */
export const DIGEST_ITEMS = 20;
/** Changed records and tasks listed per section. */
export const DIGEST_SECTION_ITEMS = 10;
/** Counts stop here ("100+"). */
export const DIGEST_COUNT_CAP = 100;
/** The overview's longest kept form, in characters. */
export const DIGEST_OVERVIEW_CHARS = 400;

export const AI_OVERVIEW_LABEL = "AI-generated overview";

/** "1 task", "3 tasks"; with `capped`, a count that reached DIGEST_COUNT_CAP reads "100+". */
function plural(n: number, one: string, many: string, capped = false): string {
  return `${capped && n >= DIGEST_COUNT_CAP ? `${DIGEST_COUNT_CAP}+` : n} ${n === 1 ? one : many}`;
}

const oneLine = (text: string, max = 200) => text.replace(/\s+/g, " ").trim().slice(0, max);

/** "updated by Bob (Email, Stage)", "created by AI assistant", "3 changes by Bob and Ann". */
export function describeChange(change: DigestChange): string {
  const by = change.by.length ? change.by.join(" and ") : "someone";
  const what =
    change.count > 1
      ? `${change.count} changes`
      : change.actions[0]
        ? `${change.actions[0]}d` // create → created, update → updated, delete → deleted, …
        : "changed";
  const fields = change.fields.length
    ? ` (${change.fields.slice(0, 5).join(", ")}${change.fields.length > 5 ? ", …" : ""})`
    : "";
  return `${what} by ${by}${fields}`;
}

/** "due today" or "overdue since 2031-01-01". */
export function describeDue(task: DigestTask): string {
  return task.overdue ? `overdue since ${task.dueAt.slice(0, 10)}` : "due today";
}

/** The counts line: "2 changes on your records, 1 task due, …". Empty when nothing to say. */
export function digestCounts(input: DigestInput): string[] {
  const counts: string[] = [];
  const changes = input.changesTotal ?? input.changes?.length ?? 0;
  const tasks = input.tasksTotal ?? input.tasks?.length ?? 0;
  if (changes) counts.push(`${plural(changes, "record", "records")} of yours changed`);
  if (tasks) counts.push(plural(tasks, "task due", "tasks due", true));
  if (input.pendingApprovals) {
    counts.push(
      `${plural(input.pendingApprovals, "change waiting", "changes waiting")} for approval`,
    );
  }
  if (input.unreadTotal) {
    counts.push(plural(input.unreadTotal, "unread notification", "unread notifications"));
  }
  return counts;
}

/** Whether the digest has anything beyond unread notices (what an in-app digest needs). */
export function digestHasNews(input: DigestInput): boolean {
  return Boolean(
    (input.changesTotal ?? input.changes?.length ?? 0) ||
      (input.tasksTotal ?? input.tasks?.length ?? 0) ||
      input.pendingApprovals,
  );
}

/** The fixed-template email: counts, the overview (labelled), then one line per item. */
export const plainDigest: DigestComposer = (input) => {
  const counts = digestCounts(input);
  const lines = [
    `Your Relationship OS digest for ${input.date}`,
    "",
    `${counts.join(", ") || "Nothing new"}.`,
  ];
  if (input.overview) lines.push("", `${AI_OVERVIEW_LABEL}: ${oneLine(input.overview, 600)}`);
  const changes = input.changes ?? [];
  if (changes.length) {
    lines.push("", "Changes on your records:");
    for (const c of changes) {
      lines.push(
        `- ${oneLine(c.title)} (${c.objectLabel}): ${describeChange(c)}${c.url ? ` (${c.url})` : ""}`,
      );
    }
    const more = (input.changesTotal ?? changes.length) - changes.length;
    if (more > 0) lines.push(`…and ${plural(more, "more", "more")}.`);
  }
  const tasks = input.tasks ?? [];
  if (tasks.length) {
    lines.push("", "Tasks due:");
    for (const t of tasks) {
      lines.push(`- ${oneLine(t.title)}: ${describeDue(t)}${t.url ? ` (${t.url})` : ""}`);
    }
    const more = (input.tasksTotal ?? tasks.length) - tasks.length;
    if (more > 0) lines.push(`…and ${plural(more, "more", "more")}.`);
  }
  if (input.pendingApprovals && input.approvalsUrl) {
    lines.push("", `Review approvals: ${input.approvalsUrl}`);
  }
  const groups = new Map<string, DigestItem[]>();
  for (const item of input.items) {
    const label = NOTIFICATION_TYPES[item.type]?.label ?? "Messages";
    groups.set(label, [...(groups.get(label) ?? []), item]);
  }
  for (const [label, items] of groups) {
    lines.push("", `${label}:`);
    for (const item of items) {
      lines.push(`- ${oneLine(item.title)}${item.url ? ` (${item.url})` : ""}`);
    }
  }
  const more = input.unreadTotal - input.items.length;
  if (more > 0) lines.push("", `…and ${plural(more, "more", "more")} in the CRM.`);
  return {
    subject: `[Relationship OS] Daily digest: ${counts.join(", ") || "nothing new"}`,
    text: lines.join("\n"),
  };
};

/**
 * Escapes inline Markdown in text placed mid-line (titles are user data; react-markdown renders
 * no raw HTML, so this only keeps a title from turning into emphasis or a link).
 */
export function escapeMarkdown(text: string): string {
  return oneLine(text).replace(/[\\`*_[\]<>]/g, "\\$&");
}

/** Percent-encodes what would end a Markdown link destination early (encodeURIComponent keeps
 * parentheses). */
const linkTarget = (href: string) =>
  href.replace(/[()\s]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0").toUpperCase()}`);

const mdLink = (text: string, href: string | null) =>
  href ? `[${escapeMarkdown(text)}](${linkTarget(href)})` : escapeMarkdown(text);

/** Unread notices listed in the in-app digest (the inbox has them all). */
export const DIGEST_INAPP_NOTICES = 5;

/**
 * The in-app digest notification: a title and a Markdown body with app paths. Sections are
 * `###` headings; the overview, when there is one, comes first and is labelled.
 */
export function digestMarkdown(input: DigestInput): { title: string; body: string } {
  const counts = digestCounts(input);
  const parts: string[] = [];
  if (input.overview) {
    parts.push(`_${AI_OVERVIEW_LABEL}:_ ${escapeMarkdown(oneLine(input.overview, 600))}`);
  }
  parts.push(`${counts.join(" · ") || "Nothing new"}.`);
  const changes = input.changes ?? [];
  if (changes.length) {
    const lines = changes.map(
      (c) =>
        `- ${mdLink(c.title, c.href)} (${escapeMarkdown(c.objectLabel)}): ${escapeMarkdown(describeChange(c))}`,
    );
    const more = (input.changesTotal ?? changes.length) - changes.length;
    if (more > 0) lines.push(`- …and ${plural(more, "more", "more")}`);
    parts.push(`### Changes on your records\n\n${lines.join("\n")}`);
  }
  const tasks = input.tasks ?? [];
  if (tasks.length) {
    const lines = tasks.map((t) => `- ${mdLink(t.title, t.href)}: ${describeDue(t)}`);
    const more = (input.tasksTotal ?? tasks.length) - tasks.length;
    if (more > 0) lines.push(`- …and ${plural(more, "more", "more")} in [Tasks](/tasks)`);
    parts.push(`### Tasks due\n\n${lines.join("\n")}`);
  }
  if (input.pendingApprovals) {
    parts.push(
      `### Approvals waiting\n\n- ${mdLink(
        `${plural(input.pendingApprovals, "change", "changes")} waiting for approval`,
        "/approvals",
      )}`,
    );
  }
  if (input.unreadTotal) {
    const shown = input.items.slice(0, DIGEST_INAPP_NOTICES);
    const lines = shown.map((i) => `- ${mdLink(i.title, i.href ?? null)}`);
    const more = input.unreadTotal - shown.length;
    if (more > 0)
      lines.push(
        `- …and ${plural(more, "more", "more")} in [Notifications](/notifications?unread=true)`,
      );
    parts.push(`### Unread notifications\n\n${lines.join("\n")}`);
  }
  return { title: `Your daily digest for ${input.date}`, body: parts.join("\n\n") };
}

// --- The AI overview ------------------------------------------------------------------------------

export const DIGEST_OVERVIEW_INSTRUCTIONS =
  "You write the opening of a CRM user's daily digest: one or two short, plain sentences saying " +
  "what most needs their attention today, using only the facts given. Address them as 'you'. No " +
  "greeting, no list, no Markdown, nothing that is not in the facts.";

/** The overview's input: one `- …` line per fact (titles, field names, counts; never bodies). */
export function digestFacts(input: DigestInput): string[] {
  const facts = [`- Date: ${input.date}`];
  for (const c of input.changes ?? []) {
    facts.push(
      `- Your ${c.objectLabel.toLowerCase()} "${oneLine(c.title, 120)}" was ${describeChange(c)}`,
    );
  }
  const moreChanges = (input.changesTotal ?? 0) - (input.changes?.length ?? 0);
  if (moreChanges > 0) facts.push(`- ${moreChanges} more of your records changed`);
  for (const t of input.tasks ?? []) {
    facts.push(`- Task "${oneLine(t.title, 120)}" is ${describeDue(t)}`);
  }
  const moreTasks = (input.tasksTotal ?? 0) - (input.tasks?.length ?? 0);
  if (moreTasks > 0) facts.push(`- ${moreTasks} more tasks are due`);
  if (input.pendingApprovals) facts.push(`- ${input.pendingApprovals} changes wait for approval`);
  if (input.unreadTotal) facts.push(`- ${input.unreadTotal} unread notifications`);
  for (const i of input.items.slice(0, 5)) facts.push(`- Unread: "${oneLine(i.title, 120)}"`);
  return facts;
}

export function digestOverviewMessages(input: DigestInput): ModelMessage[] {
  return [
    { role: "system", content: DIGEST_OVERVIEW_INSTRUCTIONS },
    { role: "user", content: `Facts:\n${digestFacts(input).join("\n")}` },
  ];
}

/**
 * One `summarise` call for the overview, or null without AI or on any error (the plain digest
 * goes out). The output is flattened to one line and capped; a short budget is enough.
 */
export async function digestOverview(
  models: ModelRunner | null | undefined,
  input: DigestInput,
): Promise<string | null> {
  if (!models) return null;
  try {
    const result = await models.run("summarise", digestOverviewMessages(input), { maxTokens: 160 });
    const text = result.text
      .replace(/[*_`#>]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return null;
    return text.length > DIGEST_OVERVIEW_CHARS
      ? `${text.slice(0, DIGEST_OVERVIEW_CHARS - 1).trimEnd()}…`
      : text;
  } catch (error) {
    console.warn("daily digest: AI overview failed, sending the plain digest", error);
    return null;
  }
}
