// The email and Slack notification channels (stage 6b, ADR 0172). Fixed templates: the notice's
// title, its body and an absolute link into the app, as plain text. Each send is one
// `integration.call` on the admin-chosen org connection (`send` on an `email-send` sender,
// `dm` / `post` on a `slack-post` workspace), made by the caller's `callIntegration` as the
// system: the gatekeeper submits it as an outbound action the approval gate decides
// (`email.internal` is auto-approvable for colleagues, ADR 0114). A pending action is `pending`
// here, never an error.
import type { CoreDatabase } from "@relationship-os/db";
import type { Kysely } from "kysely";
import type {
  DeliveryOutcome,
  ExternalChannelId,
  NotificationChannel,
  NotificationDeliveryContext,
  NotificationRecord,
} from "./types.ts";

/** `integration.call` as the system on an org connection (the runner provides it). */
export type CallIntegration = NotificationDeliveryContext["callIntegration"];

/** Where a channel sends: an org connection and the bound resource (facet key) on it. */
export interface ChannelTarget {
  connectionId: string;
  resource: string;
}

/**
 * Bound resources a channel can send through, by URL pattern: the real gatekeepers, and the fake
 * provider's outbox and Slack workspace (development and tests only; they exist only when the fake
 * provider is on).
 */
export const CHANNEL_RESOURCE_PATTERNS: Record<ExternalChannelId, readonly string[]> = {
  email: ["email-send://sender/:address", "fake://outbox/:address"],
  slack: ["slack-post://workspace/:teamId", "fake://slack/:address"],
};

/** Connection vendors an admin may pick per channel. */
export const CHANNEL_VENDORS: Record<ExternalChannelId, readonly string[]> = {
  email: ["email-send", "fake"],
  slack: ["slack", "slack-post", "fake"],
};

/** The bound resource of `connectionId` a channel sends through, or why there is none. */
export async function resolveChannelTarget(
  db: Kysely<CoreDatabase>,
  channel: ExternalChannelId,
  connectionId: string,
): Promise<{ target: ChannelTarget } | { problem: string }> {
  const row = await db
    .selectFrom("core_integration_connection")
    .select(["id", "vendor", "scope", "status", "resources"])
    .where("id", "=", connectionId)
    .executeTakeFirst();
  if (!row) return { problem: `Connection ${connectionId} no longer exists` };
  if (row.scope !== "org") return { problem: "Notifications go out through org connections only" };
  if (row.status !== "active") return { problem: `The connection is ${row.status}` };
  let resources: { key?: unknown; pattern?: unknown }[] = [];
  try {
    const parsed = JSON.parse(row.resources) as unknown;
    if (Array.isArray(parsed)) resources = parsed as typeof resources;
  } catch {}
  const bound = resources.find(
    (r) =>
      typeof r.key === "string" &&
      typeof r.pattern === "string" &&
      CHANNEL_RESOURCE_PATTERNS[channel].includes(r.pattern),
  );
  if (!bound) {
    return {
      problem:
        channel === "email"
          ? "The connection has no sender address bound"
          : "The connection has no Slack posting workspace bound",
    };
  }
  return { target: { connectionId, resource: bound.key as string } };
}

const SUBJECT_MAX = 200;
const TEXT_MAX = 3500;

function oneLine(text: string, max: number): string {
  const line = text.replace(/[\r\n]+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The plain-text body of a notice: title, body, link. */
export function notificationText(
  notification: Pick<NotificationRecord, "title" | "body">,
  url: string | null,
): string {
  const parts = [notification.title];
  if (notification.body) parts.push(notification.body);
  if (url) parts.push(`Open in Relationship OS: ${url}`);
  return clip(parts.join("\n\n"), TEXT_MAX);
}

/** Slack mrkdwn: escape the three control characters, then the link as `<url|text>`. */
export function slackEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function slackText(notification: Pick<NotificationRecord, "title" | "body">, url: string | null) {
  const parts = [`*${slackEscape(oneLine(notification.title, SUBJECT_MAX))}*`];
  if (notification.body) parts.push(slackEscape(notification.body));
  if (url) parts.push(`<${url}|Open in Relationship OS>`);
  return clip(parts.join("\n"), TEXT_MAX);
}

/**
 * Pending when the call queued an outbound action for review, sent when it applied. Neither means
 * the gate denied it or its auto-apply failed: a failure.
 */
export function outcomeOf(result: { pending: unknown[]; applied: unknown[] }): DeliveryOutcome {
  if (result.pending.length) return { status: "pending" };
  if (result.applied.length) return { status: "sent" };
  throw new Error("The send was not applied: the approval policy denied it or applying it failed");
}

/** Sends one plain-text email through an email channel target. */
export async function sendEmail(
  call: CallIntegration,
  target: ChannelTarget,
  message: { to: string; subject: string; text: string },
): Promise<DeliveryOutcome> {
  const result = await call({
    connectionId: target.connectionId,
    resource: target.resource,
    method: "send",
    args: [
      { to: [message.to], subject: oneLine(message.subject, SUBJECT_MAX), text: message.text },
    ],
  });
  return outcomeOf(result);
}

/** Posts one message to a Slack channel through a Slack channel target. */
export async function postToSlack(
  call: CallIntegration,
  target: ChannelTarget,
  message: { channel: string; text: string },
): Promise<DeliveryOutcome> {
  const result = await call({
    connectionId: target.connectionId,
    resource: target.resource,
    method: "post",
    args: [{ channel: message.channel, text: clip(message.text, TEXT_MAX) }],
  });
  return outcomeOf(result);
}

/** Email: `[Relationship OS] <title>` to the recipient's address. */
export function emailChannel(target: ChannelTarget): NotificationChannel {
  return {
    id: "email",
    async deliver(notification, context) {
      if (!context.recipient.email) return { status: "skipped", detail: "No email address" };
      return sendEmail(context.callIntegration, target, {
        to: context.recipient.email,
        subject: `[Relationship OS] ${notification.title}`,
        text: notificationText(notification, context.url),
      });
    },
  };
}

/** Slack: a DM to the workspace member with the recipient's email address. */
export function slackChannel(target: ChannelTarget): NotificationChannel {
  return {
    id: "slack",
    async deliver(notification, context) {
      if (!context.recipient.email) return { status: "skipped", detail: "No email address" };
      const result = await context.callIntegration({
        connectionId: target.connectionId,
        resource: target.resource,
        method: "dm",
        args: [{ user: context.recipient.email, text: slackText(notification, context.url) }],
      });
      return outcomeOf(result);
    },
  };
}
