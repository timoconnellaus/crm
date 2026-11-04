// The host-generated plain-English summary and step diagram (ADR 0131): deterministic, no AI,
// rendered from an automation's declared trigger, conditions and steps. Used on the automation
// page, in automation.get, and on the approval screen for an extension change.
//
// The summary reads as sentences with one subject, "it":
//   <trigger>[, if <conditions>], it <clause>[, <clause>] and <clause>.
//   After <wait>, [if <condition>, ]it <clause>….
// Clauses come from step intents (writes, notifies; reads only for steps without effects), in
// order. A recipient mentioned twice in a row becomes "them". Objects, fields, values, counts,
// durations and recipients are `strong` segments (highlighted in the UI, like the reference
// design's <b>).
import type {
  AutomationManifest,
  ExtensionManifest,
  NotifyIntent,
  Recipient,
  ValueMatch,
  ViewFilter,
  WriteIntent,
} from "@crm/sdk";
import { durationMs } from "@crm/sdk";
import { getObject } from "../fields/index.ts";
import type { AutomationSummary, DiagramNode } from "./schemas.ts";

/** Labels the summary needs, resolved by the caller from the field registry. */
export interface SummaryContext {
  /** `deals.deal` → { label: "Deal", plural: "Deals" }; null when unknown. */
  objectLabel(object: string): { label: string; plural: string } | null;
  /** A field's label, e.g. `expectedClose` → "expected close"; null when unknown. */
  fieldLabel(object: string, field: string): string | null;
  /** Labels of a select field's options (value → label), for from/to values. */
  optionLabel?(object: string, field: string, value: string): string | null;
  /** The automation timezone, e.g. "Australia/Sydney". */
  timezone: string;
}

type Step = AutomationManifest["steps"][number];
type DoStep = Extract<Step, { kind?: "do" }>;
type Trigger = AutomationManifest["trigger"];
type Segment = AutomationSummary["segments"][number];

// ---------------------------------------------------------------------------------------------
// Words

const DAY_MS = 86_400_000;
const UNITS: [string, number][] = [
  ["week", 7 * DAY_MS],
  ["day", DAY_MS],
  ["hour", 3_600_000],
  ["minute", 60_000],
  ["second", 1_000],
];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "3 days", "1 week", "90 minutes": the largest unit the duration is a whole number of. */
export function durationText(duration: number | string): string {
  let ms: number;
  try {
    ms = durationMs(duration as never);
  } catch {
    return String(duration);
  }
  if (ms === 0) return "0 seconds";
  for (const [unit, size] of UNITS) {
    if (ms % size === 0) return plural(ms / size, unit);
  }
  return plural(ms, "millisecond");
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** Lower-cases a label unless a word in it is an acronym ("ID", "ARR"). */
const lower = (text: string) =>
  text
    .split(" ")
    .map((word) => (/^[A-Z0-9]{2,}$/.test(word) ? word : word.toLowerCase()))
    .join(" ");
const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");
const humanise = (name: string) =>
  lower(name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " "));

function joinList(items: string[], conjunction = "and"): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${conjunction} ${items.at(-1)}`;
}

/** Builds segments; adjacent plain text merges. */
class Text {
  readonly segments: Segment[] = [];
  t(text: string): this {
    if (!text) return this;
    const last = this.segments.at(-1);
    if (last && !last.strong) last.text += text;
    else this.segments.push({ text, strong: false });
    return this;
  }
  b(text: string): this {
    if (text) this.segments.push({ text, strong: true });
    return this;
  }
  add(other: Text): this {
    for (const s of other.segments) s.strong ? this.b(s.text) : this.t(s.text);
    return this;
  }
  get text(): string {
    return this.segments.map((s) => s.text).join("");
  }
  get empty(): boolean {
    return this.segments.length === 0;
  }
}

class Labels {
  constructor(private readonly ctx: SummaryContext) {}
  object(object: string): { label: string; plural: string } {
    const known = this.ctx.objectLabel(object);
    if (known) return known;
    const label = capitalise(humanise(object.split(".").at(-1) ?? object));
    return { label, plural: `${label}s` };
  }
  /** "deal", lower case, for "the deal's owner". */
  noun(object: string): string {
    return lower(this.object(object).label);
  }
  field(object: string | null, field: string): string {
    const label = object ? this.ctx.fieldLabel(object, field) : null;
    return label ? lower(label) : humanise(field);
  }
  option(object: string, field: string, value: string): string {
    return this.ctx.optionLabel?.(object, field, value) ?? value;
  }
  get timezone(): string {
    return this.ctx.timezone;
  }
}

// ---------------------------------------------------------------------------------------------
// Triggers

function scalarText(
  labels: Labels,
  object: string,
  field: string,
  value: string | number | boolean | null,
): string {
  if (value === null) return "empty";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string") return labels.option(object, field, value);
  return String(value);
}

/** "to a **won** stage", "to **Qualified**", "to **a** or **b**". */
function matchText(
  labels: Labels,
  object: string,
  field: string,
  match: ValueMatch,
  preposition: string,
): Text {
  const out = new Text().t(`${preposition} `);
  if (match !== null && typeof match === "object") {
    if ("stageType" in match)
      return out
        .t(`${article(match.stageType)} `)
        .b(match.stageType)
        .t(" stage");
    match.in.forEach((value, i) => {
      if (i > 0) out.t(i === match.in.length - 1 ? " or " : ", ");
      out.b(scalarText(labels, object, field, value));
    });
    return out;
  }
  if (match === null) return out.t("empty");
  return out.b(scalarText(labels, object, field, match));
}

const EVENT_WORDS: Record<string, string> = {
  created: "created",
  updated: "updated",
  deleted: "deleted",
  restored: "restored",
};

const pad = (n: number) => String(n).padStart(2, "0");
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A cron expression in words, for the common shapes; null for anything else. */
export function cronText(cron: string): string | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];
  const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : null);
  const m = num(minute);
  const h = num(hour);
  const everyMinutes = /^\*\/(\d+)$/.exec(minute);
  if (dom === "*" && month === "*" && dow === "*") {
    if (minute === "*" && hour === "*") return "Every minute";
    if (everyMinutes && hour === "*") return `Every ${everyMinutes[1]} minutes`;
    if (m !== null && hour === "*") return m === 0 ? "Every hour" : `Every hour at :${pad(m)}`;
  }
  if (m === null || h === null || month !== "*") return null;
  const at = `${pad(h)}:${pad(m)}`;
  if (dom === "*" && dow === "*") return `Every day at ${at}`;
  if (dom === "*") {
    if (dow === "1-5") return `Every weekday at ${at}`;
    const days = dow.split(",").map((d) => num(d));
    if (days.every((d) => d !== null && d >= 0 && d <= 7)) {
      return `Every ${joinList(days.map((d) => DAYS[(d as number) % 7] as string))} at ${at}`;
    }
    return null;
  }
  const day = num(dom);
  if (day !== null && dow === "*") return `On day ${day} of every month at ${at}`;
  return null;
}

/** The trigger as the start of a sentence: "When a **Deal**'s **stage** changes to …". */
function triggerPhrase(trigger: Trigger, labels: Labels): Text {
  const out = new Text();
  switch (trigger.type) {
    case "record": {
      const { label } = labels.object(trigger.object);
      const events = trigger.on.map((e) => EVENT_WORDS[e] ?? e);
      out
        .t(`When ${article(label)} `)
        .b(label)
        .t(" is ");
      events.forEach((event, i) => {
        if (i > 0) out.t(i === events.length - 1 ? " or " : ", ");
        out.b(event);
      });
      return out;
    }
    case "fieldChanged": {
      const { label } = labels.object(trigger.object);
      out
        .t(`When ${article(label)} `)
        .b(label)
        .t("'s ")
        .b(labels.field(trigger.object, trigger.field))
        .t(" changes");
      if (trigger.from !== undefined) {
        out.add(matchText(labels, trigger.object, trigger.field, trigger.from, " from"));
      }
      if (trigger.to !== undefined) {
        out.add(matchText(labels, trigger.object, trigger.field, trigger.to, " to"));
      }
      return out;
    }
    case "schedule": {
      const words = cronText(trigger.cron);
      if (words) out.b(words);
      else out.t("On the schedule ").b(trigger.cron);
      return out.t(` (${labels.timezone})`);
    }
    case "dateRelative": {
      const { label } = labels.object(trigger.object);
      const field = labels.field(trigger.object, trigger.field);
      const fieldWords = /\bdate\b/.test(field) ? field : `${field} date`;
      if (trigger.offsetDays === 0) out.t("On ");
      else
        out
          .b(plural(Math.abs(trigger.offsetDays), "day"))
          .t(trigger.offsetDays > 0 ? " after " : " before ");
      return out
        .t(`${article(label)} `)
        .b(label)
        .t("'s ")
        .b(fieldWords);
    }
    case "manual": {
      const { label, plural: many } = labels.object(trigger.object);
      out
        .t("When someone clicks ")
        .b(trigger.label)
        .t(` on ${article(label)} `)
        .b(label);
      if (trigger.bulk) out.t(" or on selected ").b(many);
      return out;
    }
    case "approvalDecided": {
      out.t("When a pending change");
      if (trigger.operation) out.t(" (").b(trigger.operation).t(")");
      if (trigger.object) out.t(" to ").b(labels.object(trigger.object).plural);
      const decision = trigger.decision ?? "any";
      out.t(" is ");
      if (decision === "any") out.b("approved").t(" or ").b("rejected");
      else out.b(decision);
      return out;
    }
  }
}

/** One line for lists: "When a Deal's stage changes to a won stage". */
export function triggerText(spec: AutomationManifest, ctx: SummaryContext): string {
  return triggerPhrase(spec.trigger, new Labels(ctx)).text;
}

// ---------------------------------------------------------------------------------------------
// Conditions

function relativeValue(value: unknown): string | null {
  if (value && typeof value === "object" && "$relative" in value) {
    const r = String((value as { $relative: unknown }).$relative);
    return r === "me" ? "you" : humanise(r);
  }
  return null;
}

function valueWords(labels: Labels, object: string, field: string, value: unknown): string {
  const relative = relativeValue(value);
  if (relative) return relative;
  if (value === null || value === undefined) return "empty";
  if (typeof value === "string") return labels.option(object, field, value);
  if (typeof value === "boolean") return value ? "yes" : "no";
  return typeof value === "number" ? String(value) : JSON.stringify(value);
}

const OP_WORDS: Record<string, string> = {
  eq: "is",
  neq: "is not",
  lt: "is before",
  lte: "is at most",
  gt: "is after",
  gte: "is at least",
  contains: "contains",
  not_contains: "does not contain",
  starts_with: "starts with",
  ends_with: "ends with",
};

/** "its **status** is **open** and its **value** is at least **1000**". */
function conditionText(filter: ViewFilter, object: string, labels: Labels): Text {
  const out = new Text();
  if ("and" in filter || "or" in filter) {
    const parts = "and" in filter ? filter.and : filter.or;
    const word = "and" in filter ? " and " : " or ";
    parts.forEach((part, i) => {
      if (i > 0) out.t(word);
      const nested = "and" in part || "or" in part;
      if (nested) out.t("(");
      out.add(conditionText(part, object, labels));
      if (nested) out.t(")");
    });
    return out;
  }
  out.t("its ").b(labels.field(object, filter.field)).t(" ");
  const value = (v: unknown) => valueWords(labels, object, filter.field, v);
  switch (filter.op) {
    case "is_null":
      return out.t("is empty");
    case "is_not_null":
      return out.t("is set");
    case "in":
    case "not_in": {
      const values = Array.isArray(filter.value) ? filter.value : [filter.value];
      out.t(filter.op === "in" ? "is " : "is not ");
      values.forEach((v, i) => {
        if (i > 0) out.t(i === values.length - 1 ? " or " : ", ");
        out.b(value(v));
      });
      return out;
    }
    case "between": {
      const [from, to] = Array.isArray(filter.value) ? filter.value : [filter.value, undefined];
      return out.t("is between ").b(value(from)).t(" and ").b(value(to));
    }
    default:
      return out.t(`${OP_WORDS[filter.op] ?? filter.op} `).b(value(filter.value));
  }
}

// ---------------------------------------------------------------------------------------------
// Steps

const recipientKey = (r: Recipient) => JSON.stringify(r);

/** "the deal's **owner**", "the owner's **manager**", "the **admins**". */
function recipientText(r: Recipient, trigger: string | null, labels: Labels): Text {
  const out = new Text();
  if (r === "admins") return out.t("the ").b("admins");
  if (r === "actor") return out.t("the ").b("person who started it");
  if ("userId" in r) return out.t("user ").b(r.userId);
  if ("field" in r) {
    return out
      .t(trigger ? `the ${labels.noun(trigger)}'s ` : "the ")
      .b(labels.field(trigger, r.field));
  }
  return out.t(`the ${labels.field(trigger, r.managerOf)}'s `).b("manager");
}

/** Short recipient for the diagram: "owner", "owner's manager", "admins". */
function recipientShort(r: Recipient, trigger: string | null, labels: Labels): string {
  if (r === "admins") return "admins";
  if (r === "actor") return "the person who started it";
  if ("userId" in r) return `user ${r.userId}`;
  if ("field" in r) return labels.field(trigger, r.field);
  return `${labels.field(trigger, r.managerOf)}'s manager`;
}

const VERBS: Record<string, string> = { create: "creates", update: "updates", delete: "deletes" };

/** The words between the verb and the object in a step label: "Create onboarding tasks" → "onboarding". */
function qualifier(step: DoStep, write: WriteIntent, labels: Labels): string {
  if (!step.label) return "";
  const { label, plural: many } = labels.object(write.object);
  const words = step.label.trim().split(/\s+/);
  const nouns = new Set([lower(label), lower(many)]);
  const at = words.findIndex((w, i) => i > 0 && nouns.has(w.toLowerCase()));
  if (at <= 1) return "";
  const between = words.slice(1, at).filter((w) => !/^(a|an|the|\d+)$/i.test(w));
  return between.join(" ").toLowerCase();
}

interface Sentence {
  prefix: Text;
  clauses: Text[];
}

function writeClause(
  step: DoStep,
  write: WriteIntent,
  ctx: { trigger: string | null; labels: Labels; last: { person: string | null } },
): Text {
  const { labels, trigger } = ctx;
  const action = write.action ?? "create";
  const out = new Text().t(`${VERBS[action]} `);
  const { label, plural: many } = labels.object(write.object);
  const q = qualifier(step, write, labels);
  const noun = (n: number | undefined) => {
    const word = n === 1 ? lower(label) : lower(many);
    return q ? `${q} ${word}` : word;
  };
  if (write.count !== undefined) {
    out.b(
      write.count === 1
        ? `${article(q || label)} ${noun(1)}`
        : `${write.count} ${noun(write.count)}`,
    );
  } else if (action !== "create" && write.object === trigger) {
    out.t("the ").b(noun(1));
  } else {
    out.b(noun(undefined));
  }
  if (write.assignTo) {
    out.t(" for ").add(recipientText(write.assignTo, trigger, labels));
    ctx.last.person = recipientKey(write.assignTo);
  }
  return out;
}

function notifyClause(
  notify: NotifyIntent,
  ctx: { trigger: string | null; labels: Labels; last: { person: string | null } },
): Text {
  const key = recipientKey(notify.to);
  const out = new Text().t("notifies ");
  if (ctx.last.person === key) out.t("them");
  else out.add(recipientText(notify.to, ctx.trigger, ctx.labels));
  ctx.last.person = key;
  return out;
}

function stepClauses(
  step: DoStep,
  ctx: { trigger: string | null; labels: Labels; last: { person: string | null } },
): Text[] {
  const clauses: Text[] = [];
  for (const write of step.writes ?? []) clauses.push(writeClause(step, write, ctx));
  for (const notify of step.notifies ?? []) clauses.push(notifyClause(notify, ctx));
  if (clauses.length) return clauses;
  if (step.reads?.length) {
    const out = new Text().t("checks ");
    step.reads.forEach((object, i) => {
      if (i > 0) out.t(i === step.reads!.length - 1 ? " and " : ", ");
      out.b(ctx.labels.object(object).plural);
    });
    return [out];
  }
  return [new Text().t("runs ").b(step.label ?? humanise(step.name))];
}

/** Lower-cases the first letter and drops a question mark: "Any task open?" → "any task open". */
const clauseOf = (label: string) =>
  label.charAt(0).toLowerCase() + label.slice(1).replace(/\?\s*$/, "");

export function automationSummary(
  spec: AutomationManifest,
  context: SummaryContext,
): AutomationSummary {
  const labels = new Labels(context);
  const trigger =
    "object" in spec.trigger && spec.trigger.type !== "approvalDecided"
      ? spec.trigger.object
      : null;
  const ctx = { trigger, labels, last: { person: null as string | null } };
  const sentences: Sentence[] = [];
  let current: Sentence = { prefix: triggerPhrase(spec.trigger, labels).t(", "), clauses: [] };
  if (spec.conditions && trigger) {
    current.prefix
      .t("if ")
      .add(conditionText(spec.conditions, trigger, labels))
      .t(", ");
  }
  const close = (next: Text) => {
    sentences.push(current);
    current = { prefix: next, clauses: [] };
    ctx.last.person = null;
  };
  for (const step of spec.steps) {
    switch (step.kind) {
      case "sleep":
        close(new Text().t("After ").b(durationText(step.duration)).t(", "));
        break;
      case "waitForEvent":
        close(
          new Text()
            .t("After the ")
            .b(step.event)
            .t(" event (or ")
            .b(durationText(step.timeout ?? "7 days"))
            .t(" without it), "),
        );
        break;
      case "condition": {
        const clause = step.clause ?? clauseOf(step.label);
        if (current.clauses.length) close(new Text().t("Then, "));
        current.prefix.t(`if ${clause}, `);
        break;
      }
      default:
        current.clauses.push(...stepClauses(step, ctx));
    }
  }
  sentences.push(current);
  const out = new Text();
  sentences.forEach((sentence, i) => {
    if (i > 0) out.t(" ");
    out.add(sentence.prefix);
    if (!sentence.clauses.length) {
      out.t("it ends.");
      return;
    }
    out.t("it ");
    sentence.clauses.forEach((clause, j) => {
      if (j > 0) out.t(j === sentence.clauses.length - 1 ? " and " : ", ");
      out.add(clause);
    });
    out.t(".");
  });
  // A sentence may start with a lower-case word ("it", a count): capitalise the first letter.
  const first = out.segments[0];
  if (first) first.text = capitalise(first.text);
  return { segments: out.segments, text: out.text };
}

// ---------------------------------------------------------------------------------------------
// Diagram

function node(
  partial: Partial<DiagramNode> & Pick<DiagramNode, "kind" | "heading" | "text">,
): DiagramNode {
  return { code: [], detail: null, risk: null, stepName: null, ...partial };
}

function matchCode(match: ValueMatch): { text: string; code: string[] } {
  if (match !== null && typeof match === "object") {
    if ("stageType" in match) return { text: "stage type {code}", code: [match.stageType] };
    return { text: "one of {code}", code: [match.in.map((v) => String(v)).join(", ")] };
  }
  return { text: "{code}", code: [String(match)] };
}

function triggerNode(trigger: Trigger, labels: Labels): DiagramNode {
  const base = { kind: "trigger" as const, heading: "Trigger" };
  switch (trigger.type) {
    case "record":
      return node({
        ...base,
        text: `${labels.object(trigger.object).label} · ${trigger.on.map(() => "{code}").join(" or ")}`,
        code: [...trigger.on],
        detail: trigger.includeBulk ? "Includes bulk changes" : null,
      });
    case "fieldChanged": {
      let text = `${labels.object(trigger.object).label} · {code} changed`;
      const code = [trigger.field];
      for (const [word, match] of [
        [" from ", trigger.from],
        [" → ", trigger.to],
      ] as const) {
        if (match === undefined) continue;
        const m = matchCode(match);
        text += word + m.text;
        code.push(...m.code);
      }
      return node({
        ...base,
        text,
        code,
        detail: trigger.includeBulk ? "Includes bulk changes" : null,
      });
    }
    case "schedule":
      return node({
        ...base,
        text: `Schedule · {code} (${labels.timezone})`,
        code: [trigger.cron],
        detail: cronText(trigger.cron),
      });
    case "dateRelative": {
      const n = trigger.offsetDays;
      const when = n === 0 ? "on" : `${plural(Math.abs(n), "day")} ${n > 0 ? "after" : "before"}`;
      return node({
        ...base,
        text: `${labels.object(trigger.object).label} · ${when} {code}`,
        code: [trigger.field],
        detail: `Checked daily (${labels.timezone})`,
      });
    }
    case "manual":
      return node({
        ...base,
        text: `${labels.object(trigger.object).label} · button “${trigger.label}”`,
        detail: trigger.bulk ? "Also a bulk action on lists" : null,
      });
    case "approvalDecided": {
      const decision = trigger.decision ?? "any";
      const code = [trigger.operation, trigger.object].filter((c): c is string => Boolean(c));
      return node({
        ...base,
        text: `Approval · ${decision === "any" ? "decided" : decision}${
          trigger.operation ? " · {code}" : ""
        }${trigger.object ? " on {code}" : ""}`,
        code,
      });
    }
  }
}

function writeText(write: WriteIntent, trigger: string | null, labels: Labels): string {
  const { label, plural: many } = labels.object(write.object);
  const action = write.action ?? "create";
  const words =
    write.count !== undefined
      ? `${write.count} ${lower(write.count === 1 ? label : many)}`
      : action !== "create" && write.object === trigger
        ? `The ${lower(label)}`
        : capitalise(lower(many));
  const linked = write.linkedToTrigger ?? (write.object === "task" || write.object === "activity");
  let text = action === "create" ? words : `${capitalise(action)} ${words.replace(/^The/, "the")}`;
  if (linked && trigger && write.object !== trigger)
    text += ` linked to the ${labels.noun(trigger)}`;
  if (write.assignTo) text += `, assigned to ${recipientShort(write.assignTo, trigger, labels)}`;
  return text;
}

const VERB_HEADINGS: Record<string, string> = {
  create: "create",
  update: "update",
  delete: "delete",
};

export function automationDiagram(spec: AutomationManifest, ctx: SummaryContext): DiagramNode[] {
  const labels = new Labels(ctx);
  const trigger =
    "object" in spec.trigger && spec.trigger.type !== "approvalDecided"
      ? spec.trigger.object
      : null;
  const nodes: DiagramNode[] = [triggerNode(spec.trigger, labels)];
  if (spec.conditions && trigger) {
    nodes.push(
      node({
        kind: "condition",
        heading: "Condition",
        text: `Only if ${conditionText(spec.conditions, trigger, labels).text}`,
      }),
    );
  }
  const recordToken = trigger ? `{${labels.noun(trigger)}}` : "{record}";
  let n = 0;
  for (const step of spec.steps) {
    switch (step.kind) {
      case "sleep":
        n += 1;
        nodes.push(
          node({
            kind: "sleep",
            heading: `Step ${n} · wait`,
            text: `${durationText(step.duration)} (durable; survives redeploys)`,
            stepName: step.name,
          }),
        );
        break;
      case "waitForEvent":
        n += 1;
        nodes.push(
          node({
            kind: "waitForEvent",
            heading: `Step ${n} · wait`,
            text: `For event {code}, up to ${durationText(step.timeout ?? "7 days")} (durable; survives redeploys)`,
            code: [step.event],
            stepName: step.name,
          }),
        );
        break;
      case "condition":
        nodes.push(
          node({ kind: "condition", heading: "Condition", text: step.label, stepName: step.name }),
        );
        break;
      default: {
        n += 1;
        const writes = step.writes ?? [];
        const notifies = step.notifies ?? [];
        const actions = [...new Set(writes.map((w) => w.action ?? "create"))];
        const verb =
          writes.length === 0
            ? notifies.length
              ? "notify"
              : "run"
            : actions.length === 1
              ? (VERB_HEADINGS[actions[0] as string] as string)
              : "write";
        const parts = [
          ...writes.map((w) => writeText(w, trigger, labels)),
          ...notifies.map(
            (m) =>
              `${capitalise(recipientShort(m.to, trigger, labels))}: “${m.message.replaceAll("{record}", recordToken)}”`,
          ),
        ];
        const titles = writes
          .flatMap((w) => w.titles ?? [])
          .map((t) => t.replaceAll("{record}", recordToken));
        const extra = [
          step.reads?.length
            ? `reads ${step.reads.map((o) => labels.object(o).plural).join(", ")}`
            : null,
          step.calls?.length ? `calls ${step.calls.join(", ")}` : null,
        ].filter((x): x is string => x !== null);
        let text = parts.join("; ") || (step.label ?? capitalise(humanise(step.name)));
        if (titles.length) text += ":";
        const detail = titles.length
          ? titles.join(" · ")
          : parts.length && step.label
            ? [step.label, ...extra].join(" · ")
            : extra.join(" · ") || null;
        const risks: string[] = [];
        const writeCount = writes
          .filter((w) => (w.action ?? "create") !== "delete")
          .reduce<number | null>(
            (sum, w) => (sum === null || w.count === undefined ? null : sum + w.count),
            0,
          );
        if (writes.some((w) => (w.action ?? "create") !== "delete")) {
          risks.push(writeCount ? `write ×${writeCount}` : "write");
        }
        if (writes.some((w) => w.action === "delete")) risks.push("delete");
        nodes.push(
          node({
            kind: writes.length === 0 && notifies.length ? "notify" : "do",
            heading: `Step ${n} · ${verb}`,
            text,
            detail,
            risk: risks.length ? risks.join(" · ") : null,
            stepName: step.name,
          }),
        );
      }
    }
  }
  return nodes;
}

// ---------------------------------------------------------------------------------------------
// Context from a manifest (approval screens) and the field registry

/**
 * A SummaryContext over `manifest`'s own objects (labels, fields and select options), then the
 * field registry (core and installed objects), then humanised names.
 */
const CORE_PLURALS: Record<string, string> = {
  person: "People",
  organisation: "Organisations",
  activity: "Activities",
  task: "Tasks",
};

export function manifestSummaryContext(
  manifest: Pick<ExtensionManifest, "id" | "objects" | "fields"> | null,
  timezone = "UTC",
): SummaryContext {
  const own = (object: string) =>
    manifest && object.startsWith(`${manifest.id}.`)
      ? manifest.objects[object.slice(manifest.id.length + 1)]
      : undefined;
  const fieldOf = (object: string, field: string) =>
    own(object)?.fields[field] ?? manifest?.fields[object]?.[field];
  return {
    timezone,
    objectLabel(object) {
      const local = own(object);
      if (local) return { label: local.label, plural: local.plural };
      const registered = getObject(object);
      if (!registered) return null;
      const plural = registered.plural ?? CORE_PLURALS[object] ?? `${registered.label}s`;
      return { label: registered.label, plural };
    },
    fieldLabel(object, field) {
      const declared = fieldOf(object, field);
      if (declared) return declared.label;
      return getObject(object)?.fields.find((f) => f.name === field)?.label ?? null;
    },
    optionLabel(object, field, value) {
      return fieldOf(object, field)?.options?.find((o) => o.value === value)?.label ?? null;
    },
  };
}
