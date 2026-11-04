// Automations (ADR 0028, ADR 0130, ADR 0131): `defineAutomation` declares a trigger, optional
// declarative conditions, the steps it takes (with their intents: what they read, write, notify
// and wait for) and a `run` handler shaped like a Cloudflare Workflow. The host renders the
// plain-English summary and step diagram from the declarations alone (no AI), evaluates the
// conditions before it starts a run, and runs `run` durably on Cloudflare Workflows: every
// `step.do` executes in a Dynamic Worker as actor `automation` under the extension principal.
//
// The declarations are the contract the diagram, the summary and the approval screen show, so the
// runtime holds `run` to them: every `step.do` / `step.sleep` / `step.waitForEvent` name must be a
// declared step of the matching kind. Effects a step did not declare are still gated at run time
// (and flagged in the run history), never silently allowed.
import { z } from "zod";
import type { ExtensionContext, FilterOp, StageType, ViewFilter } from "./contract.ts";

// ---------------------------------------------------------------------------------------------
// Durations

/** `"3 days"`, `"90 minutes"`, `"1 week"`, or milliseconds. */
export type Duration =
  | number
  | `${number} ${"second" | "seconds" | "minute" | "minutes" | "hour" | "hours" | "day" | "days" | "week" | "weeks"}`;

const UNIT_MS: Record<string, number> = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
};

/** Milliseconds in a duration. Throws on a malformed one. */
export function durationMs(duration: Duration): number {
  if (typeof duration === "number") {
    if (!Number.isFinite(duration) || duration < 0) throw new Error("Durations are >= 0 ms");
    return duration;
  }
  const match = /^\s*(\d+(?:\.\d+)?)\s+(second|minute|hour|day|week)s?\s*$/.exec(duration);
  if (!match) throw new Error(`"${duration}" is not a duration like "3 days" or "90 minutes"`);
  return Math.round(Number(match[1]) * (UNIT_MS[match[2] as string] as number));
}

// ---------------------------------------------------------------------------------------------
// Triggers

/** Record lifecycle events every core and extension object emits after commit. */
export const RECORD_EVENTS = ["created", "updated", "deleted", "restored"] as const;
export type RecordEventType = (typeof RECORD_EVENTS)[number];

/**
 * A value a `fieldChanged` trigger compares a field's before / after value with: a literal, one
 * of several literals, or (for an object's stage relation) the type of the stage.
 */
export type ValueMatch =
  | string
  | number
  | boolean
  | null
  | { in: readonly (string | number | boolean | null)[] }
  | { stageType: StageType };

/**
 * What starts a run. Inbound webhooks and sync events arrive with integrations (stage 6b) as
 * further trigger types; the host dispatches each kind of event to its own trigger source.
 */
export type AutomationTrigger =
  | {
      /** A record of `object` was created, updated, deleted (to Trash) or restored. */
      type: "record";
      /** Core (`person`, `organisation`, `task`, `activity`) or `<extension>.<object>`. */
      object: string;
      on: readonly RecordEventType[];
      /**
       * Also fire for records changed by bulk operations (imports, `*Many`, backfills). Off by
       * default: one import must not start thousands of runs (cost audit U3).
       */
      includeBulk?: boolean;
    }
  | {
      /** A field of a record of `object` changed, optionally from / to given values. */
      type: "fieldChanged";
      object: string;
      field: string;
      from?: ValueMatch;
      to?: ValueMatch;
      includeBulk?: boolean;
    }
  | {
      /**
       * A cron expression (5 fields: minute hour day-of-month month day-of-week), evaluated in
       * the deployment's automation timezone (Settings → Automations). The finest granularity
       * is the host's cron tick (one minute).
       */
      type: "schedule";
      cron: string;
    }
  | {
      /**
       * `offsetDays` days after (positive) or before (negative) a date field of each live record
       * of `object`; 0 is the day itself. Evaluated once a day, in the automation timezone.
       */
      type: "dateRelative";
      object: string;
      field: string;
      offsetDays: number;
    }
  | {
      /**
       * A person starts it from a record page (a button) or for selected records on a list (a
       * bulk action, when `bulk` is true).
       */
      type: "manual";
      object: string;
      /** The button's label, e.g. "Send renewal reminder". */
      label: string;
      bulk?: boolean;
    }
  | {
      /** A pending action was decided in the Approvals inbox. */
      type: "approvalDecided";
      /** Default `any`. */
      decision?: "approved" | "rejected" | "any";
      /** Only actions of this operation (e.g. `record.update`). */
      operation?: string;
      /** Only actions touching records of this object. */
      object?: string;
    };

export type AutomationTriggerType = AutomationTrigger["type"];
export const AUTOMATION_TRIGGER_TYPES = [
  "record",
  "fieldChanged",
  "schedule",
  "dateRelative",
  "manual",
  "approvalDecided",
] as const satisfies readonly AutomationTriggerType[];

// ---------------------------------------------------------------------------------------------
// Steps and their intents

/**
 * Who a notification goes to. `{ field }` is a `user` field of the trigger record (e.g. a deal's
 * `owner`); `{ managerOf }` is the manager of the user in that field, or the admins when the
 * deployment has no manager for them (the Deals README says so); `admins` is every admin.
 */
export type Recipient =
  | { field: string }
  | { managerOf: string }
  | { userId: string }
  | "admins"
  | "actor";

/** One kind of record a step creates or changes. */
export interface WriteIntent {
  /** Core or `<extension>.<object>`. */
  object: string;
  /** Default `create`. */
  action?: "create" | "update" | "delete";
  /** How many records, when fixed (e.g. 3 onboarding tasks). Omitted: "one or more". */
  count?: number;
  /** Titles of the records created, when fixed: shown in the diagram. */
  titles?: readonly string[];
  /** For tasks: who they are assigned to. */
  assignTo?: Recipient;
  /** Linked to the trigger record. Default true for tasks and activities. */
  linkedToTrigger?: boolean;
}

/** A notification a step sends (through `notification.send`). */
export interface NotifyIntent {
  to: Recipient;
  /** The title as written, with `{record}` standing for the trigger record's title. */
  message: string;
}

interface StepBase {
  /** Unique within the automation, camelCase: what `run` passes to `step.*`. */
  name: string;
  /** Short label for the diagram ("Create onboarding tasks"). Default: the name, humanised. */
  label?: string;
}

/**
 * A declared step. `do` steps run extension code; `sleep` and `waitForEvent` are durable waits;
 * a `condition` is a branch `run` takes in code, declared so the diagram shows it (the steps
 * after it run only when it holds).
 */
export type AutomationStep =
  | (StepBase & {
      kind?: "do";
      /** Objects it reads. */
      reads?: readonly string[];
      writes?: readonly WriteIntent[];
      notifies?: readonly NotifyIntent[];
      /** Further operations it calls (e.g. `query.sql`), for the permissions summary. */
      calls?: readonly string[];
    })
  | (StepBase & { kind: "sleep"; duration: Duration })
  | (StepBase & {
      kind: "waitForEvent";
      /** The event type `step.waitForEvent` waits for. */
      event: string;
      /** Default 7 days. */
      timeout?: Duration;
    })
  | (StepBase & {
      kind: "condition";
      /** The question, e.g. "Any onboarding task still open?". */
      label: string;
      /**
       * The condition as the summary says it after "if", e.g. "any of those tasks are still
       * open". Default: the label, lower-cased, without its question mark.
       */
      clause?: string;
    });

/** What happens when a person rejects a change a run queued for approval. Default `stop`. */
export type OnRejected = "stop" | "continue" | { notify: Recipient; message?: string };

/** Per-automation limits, within the host's maxima (Settings shows both). */
export interface AutomationRails {
  /** Default 60. Above it the automation auto-pauses and admins are notified. */
  maxRunsPerMinute?: number;
  /** Default 500 writes an hour across all its runs. */
  maxWritesPerHour?: number;
  /** Seconds within which `updated` events for one record coalesce into one run. */
  debounceSeconds?: number;
}

// ---------------------------------------------------------------------------------------------
// The run handler

/** The event a run starts from, as `run` receives it. */
export interface AutomationEvent {
  /** `<extension>.<automation>` */
  automation: string;
  runId: string;
  trigger: AutomationTriggerType;
  /** The trigger record (record, fieldChanged, dateRelative, manual), as read when the run started. */
  record?: {
    object: string;
    id: string;
    data: Record<string, unknown> | null;
    /** The record's title when the run started (what `{record}` in a notification stands for). */
    title?: string | null;
  };
  /** record / fieldChanged: what changed. `diff` holds changed fields only. */
  change?: {
    action: RecordEventType;
    diff: Record<string, { before: unknown; after: unknown }>;
  };
  /** schedule / dateRelative: the period this run is for, e.g. `2026-11-05` or `2026-11-05T09:00`. */
  period?: string;
  /** manual: who started it, and every selected record for a bulk action. */
  manual?: { userId: string; recordIds: string[] };
  /** approvalDecided: the decided action. */
  approval?: {
    actionId: string;
    operation: string;
    decision: "approved" | "rejected";
    records: { object: string; id: string }[];
  };
  /** True in test mode: writes are simulated, waits are skipped. */
  test: boolean;
}

/** The Workflow-shaped step API `run` receives. */
export interface AutomationStepApi {
  /**
   * Runs `fn` once, durably: its result is stored, and a run resumed after a restart or a wait
   * gets the stored result instead of running it again. It is retried with backoff when it
   * throws. `name` must be a declared `do` step (an intent here is checked against it).
   */
  do<T>(name: string, fn: () => Promise<T> | T): Promise<T>;
  do<T>(
    name: string,
    intent: Omit<Extract<AutomationStep, { kind?: "do" }>, "name" | "kind">,
    fn: () => Promise<T> | T,
  ): Promise<T>;
  /** A durable wait (survives redeploys). Skipped, and shown, in test mode. */
  sleep(name: string, duration: Duration): Promise<void>;
  /** Waits for an event of the declared type; null on timeout. Skipped (null) in test mode. */
  waitForEvent<T = unknown>(name: string): Promise<T | null>;
}

/** `ctx` in `run`: the extension's host modules plus notifications. */
export interface AutomationContext extends ExtensionContext {
  /**
   * Sends an in-app notification through `notification.send` (the extension needs it in
   * `permissions.operations`). `{record}` in the title stands for the trigger record's title.
   */
  notify(
    to: Recipient | Recipient[],
    message: { title: string; body?: string; link?: "record" | "run" },
  ): Promise<{ sent: number }>;
}

export interface AutomationSpec<T extends AutomationTrigger = AutomationTrigger> {
  /** Name shown in the list and on the automation page, e.g. "Won deal → onboarding". */
  label: string;
  /** One or two sentences for people and models: what and why. */
  description: string;
  trigger: T;
  /**
   * Declarative conditions on the trigger record (the same filter language as views), checked
   * by the host before a run starts, and rendered in the summary.
   */
  conditions?: ViewFilter;
  /** Every step `run` may take, in order. */
  steps: readonly AutomationStep[];
  onRejected?: OnRejected;
  rails?: AutomationRails;
  run(event: AutomationEvent, step: AutomationStepApi, ctx: AutomationContext): Promise<unknown>;
}

export function defineAutomation<const T extends AutomationTrigger>(
  automation: AutomationSpec<T>,
): AutomationSpec<T> {
  return automation;
}

// ---------------------------------------------------------------------------------------------
// Manifest form (JSON: no handler). Stored in core_automations.spec.

const scalar = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);
export const valueMatchSchema = z.union([
  scalar,
  z.object({ in: z.array(scalar).min(1).max(50) }).strict(),
  z.object({ stageType: z.enum(["open", "won", "lost"]) }).strict(),
]);

const objectName = z.string().min(1).max(80);
const fieldName = z.string().min(1).max(80);

export const automationTriggerSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("record"),
      object: objectName,
      on: z.array(z.enum(RECORD_EVENTS)).min(1).max(4),
      includeBulk: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("fieldChanged"),
      object: objectName,
      field: fieldName,
      from: valueMatchSchema.optional(),
      to: valueMatchSchema.optional(),
      includeBulk: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal("schedule"), cron: z.string().min(9).max(100) }).strict(),
  z
    .object({
      type: z.literal("dateRelative"),
      object: objectName,
      field: fieldName,
      offsetDays: z.number().int().min(-365).max(365),
    })
    .strict(),
  z
    .object({
      type: z.literal("manual"),
      object: objectName,
      label: z.string().min(1).max(60),
      bulk: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("approvalDecided"),
      decision: z.enum(["approved", "rejected", "any"]).optional(),
      operation: z.string().max(100).optional(),
      object: objectName.optional(),
    })
    .strict(),
]);

export const durationSchema = z.union([
  z.number().int().min(0),
  z.string().regex(/^\s*\d+(?:\.\d+)?\s+(second|minute|hour|day|week)s?\s*$/),
]);

export const recipientSchema = z.union([
  z.literal("admins"),
  z.literal("actor"),
  z.object({ field: fieldName }).strict(),
  z.object({ managerOf: fieldName }).strict(),
  z.object({ userId: z.string().min(1).max(64) }).strict(),
]);

const writeIntentSchema = z
  .object({
    object: objectName,
    action: z.enum(["create", "update", "delete"]).optional(),
    count: z.number().int().min(1).max(10_000).optional(),
    titles: z.array(z.string().max(200)).max(50).optional(),
    assignTo: recipientSchema.optional(),
    linkedToTrigger: z.boolean().optional(),
  })
  .strict();

const notifyIntentSchema = z
  .object({ to: recipientSchema, message: z.string().min(1).max(500) })
  .strict();

const stepName = z.string().min(1).max(60);
const stepLabel = z.string().min(1).max(120).optional();

export const automationStepSchema = z.union([
  z
    .object({
      name: stepName,
      label: stepLabel,
      kind: z.literal("do").optional(),
      reads: z.array(objectName).max(50).optional(),
      writes: z.array(writeIntentSchema).max(20).optional(),
      notifies: z.array(notifyIntentSchema).max(20).optional(),
      calls: z.array(z.string().max(100)).max(50).optional(),
    })
    .strict(),
  z
    .object({
      name: stepName,
      label: stepLabel,
      kind: z.literal("sleep"),
      duration: durationSchema,
    })
    .strict(),
  z
    .object({
      name: stepName,
      label: stepLabel,
      kind: z.literal("waitForEvent"),
      event: z.string().min(1).max(100),
      timeout: durationSchema.optional(),
    })
    .strict(),
  z
    .object({
      name: stepName,
      label: z.string().min(1).max(120),
      kind: z.literal("condition"),
      clause: z.string().min(1).max(200).optional(),
    })
    .strict(),
]);

const filterOpSchema = z.enum([
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "between",
  "in",
  "not_in",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "is_null",
  "is_not_null",
] as const satisfies readonly FilterOp[]);

export const automationConditionSchema: z.ZodType<ViewFilter> = z.lazy(() =>
  z.union([
    z.object({ field: fieldName, op: filterOpSchema, value: z.unknown().optional() }).strict(),
    z.object({ and: z.array(automationConditionSchema).min(1).max(20) }).strict(),
    z.object({ or: z.array(automationConditionSchema).min(1).max(20) }).strict(),
  ]),
) as z.ZodType<ViewFilter>;

export const onRejectedSchema = z.union([
  z.literal("stop"),
  z.literal("continue"),
  z.object({ notify: recipientSchema, message: z.string().max(500).optional() }).strict(),
]);

export const automationRailsSchema = z
  .object({
    maxRunsPerMinute: z.number().int().min(1).max(600).optional(),
    maxWritesPerHour: z.number().int().min(1).max(100_000).optional(),
    debounceSeconds: z.number().int().min(0).max(3600).optional(),
  })
  .strict();

export const automationManifestSchema = z.object({
  label: z.string().min(1).max(100),
  description: z.string().min(1).max(2000),
  trigger: automationTriggerSchema,
  conditions: automationConditionSchema.optional(),
  steps: z.array(automationStepSchema).min(1).max(50),
  onRejected: onRejectedSchema.optional(),
  rails: automationRailsSchema.optional(),
});
export type AutomationManifest = z.infer<typeof automationManifestSchema>;

// ---------------------------------------------------------------------------------------------
// The runtime protocol between the host (a Workflow) and the Dynamic Worker (ADR 0130)
//
// The host replays `run` from the start on every advance, with a journal of the steps already
// done; the SDK runtime returns stored results for those, runs the first new `step.do` and stops
// there (or stops at the first new sleep / wait, without running anything). The host wraps each
// advance in a Workflow `step.do`, so a finished advance is never repeated after a restart, and
// performs sleeps and waits as Workflow `step.sleep` / `step.waitForEvent`.

export interface AutomationJournalEntry {
  name: string;
  kind: "do" | "sleep" | "waitForEvent";
  /** The step.do result, or the waitForEvent payload (null on timeout); null for a sleep. */
  value: unknown;
}

export interface AutomationRunRequest {
  /** The automation's key in `automations`. */
  automation: string;
  event: AutomationEvent;
  journal: AutomationJournalEntry[];
  /** `advance`: run one new step and stop. `test`: run to the end, skipping waits. */
  mode: "advance" | "test";
  version: string;
}

/** What one advance did. */
export type AutomationAdvance =
  /** Ran the step.do `name` (the host calls `operations` it made through codemode:crm). */
  | { kind: "do"; name: string; value: unknown }
  /** Stopped at a sleep: the host sleeps `ms`, journals it and advances again. */
  | { kind: "sleep"; name: string; ms: number }
  /** Stopped at a wait: the host waits for `event` up to `timeoutMs`. */
  | { kind: "waitForEvent"; name: string; event: string; timeoutMs: number }
  /** `run` returned. */
  | { kind: "done"; value: unknown };

/** One step as test mode reports it (every step, in order, waits included). */
export interface AutomationTestStep {
  name: string;
  kind: "do" | "sleep" | "waitForEvent";
  /** do: its result. sleep / waitForEvent: skipped, and how long it would wait. */
  value?: unknown;
  skippedMs?: number;
}

// ---------------------------------------------------------------------------------------------
// ctx.notify → notification.send

/** One recipient as `notification.send` takes it (core `recipientInputSchema`). */
export type NotificationRecipientInput =
  | { userId: string }
  | { role: "admin" }
  | { field: string; record: { object: string; id: string } }
  | { managerOf: string; record: { object: string; id: string } };

/** The `notification.send` input `ctx.notify(to, message)` makes for a run. */
export interface NotificationSendInput {
  to: NotificationRecipientInput[];
  type: "automation.message";
  title: string;
  body?: string;
  link?:
    | { kind: "record"; object: string; id: string }
    | { kind: "automationRun"; automationId: string; runId: string };
  dedupeKey: string;
}

/**
 * Turns `ctx.notify(to, message)` into a `notification.send` input for `event`'s run: field and
 * manager recipients point at the trigger record, `"actor"` is whoever started a manual run,
 * `{record}` in the title and body becomes the trigger record's title, and the dedupe key
 * (`<runId>:<key>`, key = `<step name>:<n>` with n counting notify calls within that step, so it is the same on every replay) makes a retried or replayed step send each
 * notification once. Shared by the runtime and the testing harness.
 */
export function notificationInput(
  event: AutomationEvent,
  to: Recipient | readonly Recipient[],
  message: { title: string; body?: string; link?: "record" | "run" },
  key: string,
): NotificationSendInput {
  const record = event.record;
  const recipients: readonly Recipient[] = Array.isArray(to) ? to : [to as Recipient];
  const resolved = recipients.map((recipient): NotificationRecipientInput => {
    if (recipient === "admins") return { role: "admin" };
    if (recipient === "actor") {
      const userId = event.manual?.userId;
      if (!userId)
        throw new Error('"actor" recipients need a manual trigger (a person started it)');
      return { userId };
    }
    if ("userId" in recipient) return { userId: recipient.userId };
    if (!record) {
      throw new Error(
        `A ${event.trigger} run has no trigger record, so ${JSON.stringify(recipient)} cannot be resolved`,
      );
    }
    const ref = { object: record.object, id: record.id };
    return "field" in recipient
      ? { field: recipient.field, record: ref }
      : { managerOf: recipient.managerOf, record: ref };
  });
  const title = record?.title ?? "the record";
  const fill = (text: string) => text.replaceAll("{record}", title);
  const wanted = message.link ?? (record ? "record" : undefined);
  const link =
    wanted === "run"
      ? { kind: "automationRun" as const, automationId: event.automation, runId: event.runId }
      : wanted === "record" && record
        ? { kind: "record" as const, object: record.object, id: record.id }
        : undefined;
  return {
    to: resolved,
    type: "automation.message",
    title: fill(message.title).slice(0, 200),
    ...(message.body === undefined ? {} : { body: fill(message.body) }),
    ...(link ? { link } : {}),
    dedupeKey: `${event.runId}:${key}`.slice(0, 200),
  };
}
