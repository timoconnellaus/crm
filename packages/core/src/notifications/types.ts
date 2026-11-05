// Notifications (ADR 0029, ADR 0132): typed, per user, in-app in stage 5. Every notification has a
// type from NOTIFICATION_TYPES; stage 6b adds channels (email, Slack through gatekeepers) and user
// preferences that route each type to channels. Delivery goes through `routeNotification`, so 6b
// only registers channels and reads preferences.
import { z } from "zod";

export const NOTIFICATION_TYPES = {
  /** Sent by an automation step (ctx.notify / notification.send from extension code). */
  "automation.message": { label: "Automation messages", category: "automations" },
  /** An automation auto-paused (rate limit) or was paused by the kill switch. Admins. */
  "automation.paused": { label: "Automation paused", category: "automations" },
  /** An automation run failed after its retries. Admins. */
  "automation.failed": { label: "Automation run failed", category: "automations" },
  /** Changes are waiting for your approval (created while you were not looking). */
  "approval.pending": { label: "Approvals waiting", category: "approvals" },
  /** A change you (or your agent) asked for was approved or rejected. */
  "approval.decided": { label: "Approval decisions", category: "approvals" },
  /** Sent by a person or the system with notification.send. */
  "system.message": { label: "Messages", category: "system" },
  /**
   * The daily digest in the app (stage 7b, ADR 0206): changes on your records, tasks due,
   * approvals waiting. Written by the delivery cron, one per person per day; it has its own
   * email preference (`digest`), so it is never routed to a channel per type.
   */
  digest: { label: "Daily digest", category: "digest" },
} as const;
export type NotificationType = keyof typeof NOTIFICATION_TYPES;
export const NOTIFICATION_TYPE_NAMES = Object.keys(NOTIFICATION_TYPES) as [
  NotificationType,
  ...NotificationType[],
];

/**
 * Types a person may route to email or Slack one by one. The digest is not one of them: its
 * email copy is the `digest` preference, sent by the digest pass itself.
 */
export const ROUTABLE_NOTIFICATION_TYPES = NOTIFICATION_TYPE_NAMES.filter(
  (t) => t !== "digest",
) as [NotificationType, ...NotificationType[]];

/** What a notification opens. */
export const notificationLinkSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("record"), object: z.string().max(80), id: z.string().max(64) }),
  z.object({ kind: z.literal("approval"), changeSetId: z.string().max(64) }),
  z.object({
    kind: z.literal("automationRun"),
    automationId: z.string().max(120),
    runId: z.string().max(64),
  }),
  z.object({ kind: z.literal("automation"), automationId: z.string().max(120) }),
]);
export type NotificationLink = z.infer<typeof notificationLinkSchema>;

/** Channels a notification can be delivered on. In-app is the row itself (always on). */
export const NOTIFICATION_CHANNELS = ["inApp", "email", "slack"] as const;
export type NotificationChannelId = (typeof NOTIFICATION_CHANNELS)[number];
/** The external channels (stage 6b, ADR 0172): a person may choose them per type. */
export const EXTERNAL_CHANNELS = ["email", "slack"] as const;
export type ExternalChannelId = (typeof EXTERNAL_CHANNELS)[number];

/** A stored notification (core_notifications row, parsed). */
export interface NotificationRecord {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  body: string | null;
  link: NotificationLink | null;
  /** Who sent it: actor, automation id, run id. */
  source: { actor: string; automationId?: string; runId?: string; userId?: string };
  readAt: string | null;
  createdAt: string;
}

/**
 * A delivery channel. In-app is the core_notifications row itself (written in the operation's
 * batch). Stage 6b registers email / Slack channels that deliver through gatekeepers after commit.
 */
export interface NotificationChannel {
  id: NotificationChannelId;
  /**
   * Delivers one committed notification. External channels (6b) call `integration.call` on an
   * org `email-send` / `slack-post` connection through `context.callIntegration` (a system
   * caller): kind `email.internal` / `slack.dm`, an outbound action the approval queue gates.
   */
  deliver(
    notification: NotificationRecord,
    context: NotificationDeliveryContext,
  ): Promise<DeliveryOutcome>;
}

/**
 * What one external send came to: `sent` (applied, e.g. an auto-approved internal notice),
 * `pending` (an outbound action waiting in the approvals inbox) or `skipped` (nothing to send,
 * e.g. no address); a throw is `failed`.
 */
export interface DeliveryOutcome {
  status: "sent" | "pending" | "skipped";
  detail?: string;
}

/** What a channel gets besides the notification (6b fills it in after commit). */
export interface NotificationDeliveryContext {
  /** The recipient, as the channel needs them (email address; Slack ids come from the connection). */
  recipient: { userId: string; email: string | null; name: string | null };
  /** `integration.call` as the system caller; returns the call's output (or its pending action). */
  callIntegration(input: {
    connectionId: string;
    resource: string;
    method: string;
    args: unknown[];
  }): Promise<{ value: unknown; pending: unknown[]; applied: unknown[] }>;
  /** Absolute URL of the notification's link in the app, for the message body. */
  url: string | null;
}

/** A user's per-type channel choices (6b stores these; stage 5 has none). */
export type NotificationPreferences = Partial<Record<NotificationType, NotificationChannelId[]>>;

/** The channels a notification of `type` goes to for a user: in-app plus their choices. */
export function routeNotification(
  type: NotificationType,
  preferences: NotificationPreferences = {},
): NotificationChannelId[] {
  const chosen = type === "digest" ? undefined : preferences[type];
  return chosen?.length ? [...new Set<NotificationChannelId>(["inApp", ...chosen])] : ["inApp"];
}
