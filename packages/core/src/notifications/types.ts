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
} as const;
export type NotificationType = keyof typeof NOTIFICATION_TYPES;
export const NOTIFICATION_TYPE_NAMES = Object.keys(NOTIFICATION_TYPES) as [
  NotificationType,
  ...NotificationType[],
];

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

/** Channels a notification can be delivered on. Stage 5: in-app only; 6b adds email, slack. */
export const NOTIFICATION_CHANNELS = ["inApp"] as const;
export type NotificationChannelId = (typeof NOTIFICATION_CHANNELS)[number] | "email" | "slack";

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
  deliver(notification: NotificationRecord): Promise<void>;
}

/** A user's per-type channel choices (6b stores these; stage 5 has none). */
export type NotificationPreferences = Partial<Record<NotificationType, NotificationChannelId[]>>;

/** The channels a notification of `type` goes to for a user. Stage 5: always in-app. */
export function routeNotification(
  type: NotificationType,
  preferences: NotificationPreferences = {},
): NotificationChannelId[] {
  const chosen = preferences[type];
  return chosen?.length ? [...new Set<NotificationChannelId>(["inApp", ...chosen])] : ["inApp"];
}
