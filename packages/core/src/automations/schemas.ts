// Input/output schemas of the automation.* and notification.* operations (ADR 0130, ADR 0132).
// Shared by the engine (handlers in operations/automation.ts, operations/notification.ts) and the
// UI, so both build against one contract.
import { z } from "zod";
import { NOTIFICATION_TYPE_NAMES, notificationLinkSchema } from "../notifications/types.ts";
import { RUN_STATUSES } from "./types.ts";

export const automationIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]{1,29}\.[a-z][a-zA-Z0-9]{0,39}$/)
  .describe("Automation id: <extension>.<automation>, e.g. deals.wonOnboarding");
export const runIdSchema = z.string().regex(/^arn_[0-9A-Z]{26}$/);

/** A node of the host-rendered step diagram (ADR 0131). */
export const diagramNodeSchema = z.object({
  kind: z.enum(["trigger", "condition", "do", "notify", "sleep", "waitForEvent"]),
  /** "Trigger", "Step 1 · create", "Condition", "Step 3 · wait". */
  heading: z.string(),
  /** Plain text of the node, e.g. "Deal · stage changed → stage type won". */
  text: z.string(),
  /** Inline code parts, rendered as <code> in order where `{code}` appears in text. */
  code: z.array(z.string()).default([]),
  /** Muted detail, e.g. task titles. */
  detail: z.string().nullable().default(null),
  /** Risk badge, e.g. "write ×3". */
  risk: z.string().nullable().default(null),
  stepName: z.string().nullable().default(null),
});
export type DiagramNode = z.infer<typeof diagramNodeSchema>;

/** The plain-English summary as segments: `strong` segments render highlighted (<b>). */
export const summarySchema = z.object({
  segments: z.array(z.object({ text: z.string(), strong: z.boolean().default(false) })),
  /** The same as plain text. */
  text: z.string(),
});
export type AutomationSummary = z.infer<typeof summarySchema>;

export const automationPermissionsSchema = z.object({
  read: z.array(z.string()),
  write: z.array(z.string()),
  notify: z.boolean(),
  operations: z.array(z.string()),
  /** e.g. extension:deals */
  principal: z.string(),
});

export const automationRailsViewSchema = z.object({
  maxRunsPerMinute: z.number(),
  maxWritesPerHour: z.number(),
  debounceSeconds: z.number(),
  cascadeDepth: z.number(),
  selfRetrigger: z.literal(false),
});

export const automationStatusSchema = z.enum(["active", "disabled", "paused", "killed", "removed"]);

export const automationListItemSchema = z.object({
  id: z.string(),
  extensionId: z.string(),
  extensionLabel: z.string().nullable(),
  key: z.string(),
  label: z.string(),
  description: z.string(),
  triggerType: z.string(),
  triggerObject: z.string().nullable(),
  /** One line, e.g. "When a Deal's stage changes to won". */
  triggerText: z.string(),
  status: automationStatusSchema,
  pausedReason: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastRunStatus: z.enum(RUN_STATUSES).nullable(),
  /** Runs in the last 7 days, and failed ones among them. */
  runs7d: z.number(),
  errors7d: z.number(),
  /** Manual trigger: the button label, and whether it is a bulk action. */
  manual: z.object({ label: z.string(), object: z.string(), bulk: z.boolean() }).nullable(),
});
export type AutomationListItem = z.infer<typeof automationListItemSchema>;

export const automationDetailSchema = automationListItemSchema.extend({
  version: z.string().nullable(),
  commit: z.string().nullable(),
  /** "written by Claude (MCP) · approved by Tim, 2 days ago" pieces. */
  provenance: z.object({
    author: z.string().nullable(),
    approvedBy: z.string().nullable(),
    approvedAt: z.string().nullable(),
    shipped: z.boolean(),
  }),
  spec: z.unknown(),
  summary: summarySchema,
  diagram: z.array(diagramNodeSchema),
  permissions: automationPermissionsSchema,
  rails: automationRailsViewSchema,
  onRejected: z.string(),
  runCount: z.number(),
  /** The latest test-mode report, if any. */
  lastTest: z.unknown().nullable(),
  killSwitch: z.boolean(),
  /**
   * Connections it declares and what each is bound to (ADR 0170). AutomationConnectionView
   * (operations/automation-binding.ts); empty for automations that need none.
   */
  connections: z.array(z.unknown()).default([]),
});
export type AutomationDetail = z.infer<typeof automationDetailSchema>;

export const runItemSchema = z.object({
  id: z.string(),
  automationId: z.string(),
  automationLabel: z.string(),
  status: z.enum(RUN_STATUSES),
  statusReason: z.string().nullable(),
  /** e.g. "Waiting (day 1 of 3)", "Failed step 1 · retried ✓". */
  outcomeText: z.string(),
  trigger: z.unknown(),
  record: z.object({ object: z.string(), id: z.string(), title: z.string().nullable() }).nullable(),
  test: z.boolean(),
  depth: z.number(),
  steps: z.array(z.unknown()),
  writes: z.number(),
  changeSetId: z.string().nullable(),
  waitUntil: z.string().nullable(),
  retryOf: z.string().nullable(),
  replayOf: z.string().nullable(),
  error: z.unknown().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type RunItem = z.infer<typeof runItemSchema>;

export const AUTOMATION_OPERATION_SCHEMAS = {
  "automation.list": {
    input: z.object({
      extensionId: z.string().optional(),
      /** Only automations with a manual trigger on this object (record buttons, bulk actions). */
      manualFor: z.string().optional(),
    }),
    output: z.object({ items: z.array(automationListItemSchema), killSwitch: z.boolean() }),
  },
  "automation.get": {
    input: z.object({ id: automationIdSchema }),
    output: automationDetailSchema,
  },
  "automation.test": {
    input: z
      .object({
        /** An installed automation. */
        id: automationIdSchema.optional(),
        /**
         * A proposed (not yet installed) automation: the extension.apply pending action that
         * extension.propose queued, and the automation's key in that extension (ADR 0133).
         */
        proposal: z
          .object({
            actionId: z
              .string()
              .startsWith("pac_")
              .max(64)
              .describe("The extension.apply pending action id (pac_…) from extension.propose"),
            key: z
              .string()
              .regex(/^[a-z][a-zA-Z0-9]{0,39}$/)
              .describe("The automation's key in the proposed extension's automations"),
          })
          .optional(),
        record: z.object({ object: z.string(), id: z.string() }).optional(),
      })
      .refine((v) => Boolean(v.id) !== Boolean(v.proposal), {
        message: "Pass exactly one of id (an installed automation) or proposal (a proposed one)",
      }),
    /** AutomationTestReport (types.ts). */
    output: z.object({ report: z.unknown() }),
  },
  "automation.enable": {
    input: z.object({ id: automationIdSchema }),
    output: z.object({ id: z.string(), status: automationStatusSchema }),
  },
  "automation.disable": {
    input: z.object({ id: automationIdSchema }),
    output: z.object({ id: z.string(), status: automationStatusSchema }),
  },
  "automation.runs": {
    input: z.object({
      id: automationIdSchema.optional(),
      /** Runs that touched this record (the per-record Automations section). */
      record: z.object({ object: z.string(), id: z.string() }).optional(),
      runId: runIdSchema.optional(),
      status: z.enum(RUN_STATUSES).optional(),
      includeTests: z.boolean().default(false),
      limit: z.number().int().min(1).max(200).default(50),
      cursor: z.string().optional(),
    }),
    output: z.object({ items: z.array(runItemSchema), nextCursor: z.string().nullable() }),
  },
  "automation.run": {
    input: z.object({
      id: automationIdSchema,
      object: z.string(),
      recordIds: z.array(z.string()).min(1).max(100),
    }),
    output: z.object({ runIds: z.array(z.string()), skipped: z.number() }),
  },
  "automation.retry": {
    input: z.object({ runId: runIdSchema }),
    output: z.object({ runId: z.string() }),
  },
  "automation.replay": {
    input: z.object({ runId: runIdSchema }),
    output: z.object({ runId: z.string() }),
  },
  "automation.cancel": {
    input: z.object({ runId: runIdSchema }),
    output: z.object({ runId: z.string() }),
  },
  "automation.explain": {
    input: z.object({ id: automationIdSchema }),
    /** The optional AI explanation (build role), labelled as AI-written; null without AI. */
    output: z.object({
      text: z.string().nullable(),
      model: z.string().nullable(),
      aiWritten: z.literal(true),
    }),
  },
  "automation.killSwitch": {
    input: z.object({ engaged: z.boolean() }),
    output: z.object({ engaged: z.boolean() }),
  },
  "automation.settings": {
    input: z.object({}),
    output: z.object({
      killSwitch: z.boolean(),
      timezone: z.string(),
      debounceSeconds: z.number(),
    }),
  },
  "automation.updateSettings": {
    input: z.object({
      timezone: z.string().min(1).max(64).optional(),
      debounceSeconds: z.number().int().min(0).max(3600).optional(),
    }),
    output: z.object({
      killSwitch: z.boolean(),
      timezone: z.string(),
      debounceSeconds: z.number(),
    }),
  },
} as const;

export const notificationItemSchema = z.object({
  id: z.string(),
  type: z.enum(NOTIFICATION_TYPE_NAMES),
  title: z.string(),
  body: z.string().nullable(),
  link: notificationLinkSchema.nullable(),
  /** Where the link goes in the app, e.g. /x/deals.deal/rec_… or /approvals/chs_…. */
  href: z.string().nullable(),
  source: z.record(z.string(), z.unknown()),
  readAt: z.string().nullable(),
  createdAt: z.string(),
});
export type NotificationItem = z.infer<typeof notificationItemSchema>;

export const recipientInputSchema = z.union([
  z.object({ userId: z.string() }).strict(),
  z.object({ role: z.literal("admin") }).strict(),
  /** The user in a `user` field of a record. */
  z
    .object({ field: z.string(), record: z.object({ object: z.string(), id: z.string() }) })
    .strict(),
  /** That user's manager; admins when the deployment has no manager for them. */
  z
    .object({ managerOf: z.string(), record: z.object({ object: z.string(), id: z.string() }) })
    .strict(),
]);

export const NOTIFICATION_OPERATION_SCHEMAS = {
  "notification.send": {
    input: z.object({
      to: z.array(recipientInputSchema).min(1).max(20),
      type: z.enum(NOTIFICATION_TYPE_NAMES).optional(),
      title: z.string().trim().min(1).max(200),
      body: z.string().max(2000).optional(),
      link: notificationLinkSchema.optional(),
      dedupeKey: z.string().max(200).optional(),
    }),
    output: z.object({
      sent: z.number(),
      userIds: z.array(z.string()),
      /** How recipients resolved, e.g. "no manager field: sent to admins". */
      notes: z.array(z.string()),
    }),
  },
  "notification.list": {
    input: z.object({
      unreadOnly: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(30),
      cursor: z.string().optional(),
    }),
    output: z.object({
      items: z.array(notificationItemSchema),
      unread: z.number(),
      nextCursor: z.string().nullable(),
    }),
  },
  "notification.unreadCount": {
    input: z.object({}),
    output: z.object({ unread: z.number() }),
  },
  "notification.markRead": {
    input: z
      .object({ ids: z.array(z.string()).min(1).max(100).optional(), all: z.boolean().optional() })
      .refine((v) => Boolean(v.ids) !== Boolean(v.all), "Pass ids or all"),
    output: z.object({ updated: z.number() }),
  },
} as const;
