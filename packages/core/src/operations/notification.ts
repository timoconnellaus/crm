// notification.* operations (ADR 0029, ADR 0132): send an in-app notification, and the current
// user's inbox (list, unread count, mark read). Every read and update is scoped to ctx.user: no
// one reads or marks another person's notifications.
import type { CoreDatabase } from "@relationship-os/db";
import { type Kysely, sql } from "kysely";
import { NOTIFICATION_OPERATION_SCHEMAS, type NotificationItem } from "../automations/schemas.ts";
import { ValidationError } from "../errors.ts";
import { notifyStatements } from "../notifications/send.ts";
import {
  NOTIFICATION_TYPES,
  type NotificationLink,
  type NotificationType,
  notificationLinkSchema,
} from "../notifications/types.ts";
import { defineOperation } from "../operation.ts";
import { jsonList } from "../records/common.ts";

const S = NOTIFICATION_OPERATION_SCHEMAS;

/** Types notification.send may send; the rest are written by the host itself. */
export const SENDABLE_NOTIFICATION_TYPES: readonly NotificationType[] = [
  "automation.message",
  "system.message",
];

/** The unread count stops at this (the bell shows "99+" well before). */
export const UNREAD_COUNT_CAP = 1000;

const enc = encodeURIComponent;

/** Where a notification's link goes in the app (apps/app/src/routes). */
export function notificationHref(link: NotificationLink | null): string | null {
  if (!link) return null;
  switch (link.kind) {
    case "record":
      if (link.object === "person") return `/people/${enc(link.id)}`;
      if (link.object === "organisation") return `/organisations/${enc(link.id)}`;
      if (link.object === "task") return "/tasks";
      if (link.object === "activity") return "/activity";
      return `/x/${enc(link.object)}/${enc(link.id)}`;
    case "approval":
      return `/approvals?set=${enc(link.changeSetId)}`;
    case "automationRun":
      return `/automations/${enc(link.automationId)}?run=${enc(link.runId)}`;
    case "automation":
      return `/automations/${enc(link.automationId)}`;
  }
}

interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  source: string;
  read_at: string | null;
  created_at: string;
}

function parseJson(text: string | null): unknown {
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toItem(row: NotificationRow): NotificationItem {
  const parsedLink = notificationLinkSchema.safeParse(parseJson(row.link));
  const link = parsedLink.success ? parsedLink.data : null;
  const source = parseJson(row.source);
  return {
    id: row.id,
    type: (Object.hasOwn(NOTIFICATION_TYPES, row.type)
      ? row.type
      : "system.message") as NotificationType,
    title: row.title,
    body: row.body,
    link,
    href: notificationHref(link),
    source:
      source && typeof source === "object" && !Array.isArray(source)
        ? (source as Record<string, unknown>)
        : {},
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

/** The user's unread count, capped; reads only core_notifications_unread_idx. */
export async function unreadCount(db: Kysely<CoreDatabase>, userId: string): Promise<number> {
  const result = await sql<{ n: number }>`SELECT count(*) AS n FROM (
      SELECT 1 FROM core_notifications INDEXED BY core_notifications_unread_idx
      WHERE user_id = ${userId} AND read_at IS NULL LIMIT ${UNREAD_COUNT_CAP})`.execute(db);
  return Number(result.rows[0]?.n ?? 0);
}

function encodeCursor(row: { created_at: string; id: string }): string {
  return `${row.created_at}~${row.id}`;
}

function decodeCursor(cursor: string): { at: string; id: string } {
  const [at, id] = cursor.split("~");
  if (!at || !id) throw new ValidationError("Invalid cursor", { field: "cursor" });
  return { at, id };
}

export const notificationSend = defineOperation({
  name: "notification.send",
  description:
    "Send an in-app notification (the bell and inbox) to users: by id ({ userId }), every admin " +
    "({ role: 'admin' }), the user in a user field of a record ({ field: 'owner', record }) or " +
    "that user's manager ({ managerOf: 'owner', record }; users have no manager field yet, so " +
    "this goes to the admins, and notes says so). Optionally link it to a record, approval or " +
    "automation run, and pass dedupeKey to send at most one per user per key. Returns the " +
    "recipients. Writes one notification per recipient; nothing is emailed.",
  input: S["notification.send"].input,
  output: S["notification.send"].output,
  permission: "records:write",
  risk: "write",
  mcp: { title: "Send a notification" },
  auditSummary: (output) => ({ sent: output.sent, userIds: output.userIds }),
  async handler(input, ctx) {
    const type: NotificationType =
      input.type ?? (ctx.actor === "automation" ? "automation.message" : "system.message");
    if (!SENDABLE_NOTIFICATION_TYPES.includes(type)) {
      throw new ValidationError(
        `Notifications of type ${type} are sent by the CRM itself; use automation.message or system.message`,
        { field: "type" },
      );
    }
    const plan = await notifyStatements(
      ctx.db,
      {
        to: input.to,
        type,
        title: input.title,
        body: input.body ?? null,
        link: input.link ?? null,
        ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
        source: {
          actor: ctx.actor,
          userId: ctx.user.id,
          ...(ctx.origin.automationId ? { automationId: ctx.origin.automationId } : {}),
          ...(ctx.origin.runId ? { runId: ctx.origin.runId } : {}),
        },
      },
      ctx.now,
      ctx.simulation ? { simulation: ctx.simulation } : {},
    );
    ctx.write(...plan.statements);
    return { sent: plan.userIds.length, userIds: plan.userIds, notes: plan.notes };
  },
});

export const notificationList = defineOperation({
  name: "notification.list",
  description:
    "Your notifications, newest first, one page at a time (unreadOnly for unread ones only), " +
    "with your unread count. Each has a title, optional body, what it links to and the app path " +
    "(href). Pass nextCursor back as cursor for the next page. Read-only.",
  input: S["notification.list"].input,
  output: S["notification.list"].output,
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    let query = ctx.db
      .selectFrom("core_notifications")
      .select(["id", "type", "title", "body", "link", "source", "read_at", "created_at"])
      .where("user_id", "=", ctx.user.id);
    if (input.unreadOnly) query = query.where("read_at", "is", null);
    if (input.cursor) {
      const { at, id } = decodeCursor(input.cursor);
      query = query.where((eb) =>
        eb.or([eb("created_at", "<", at), eb.and([eb("created_at", "=", at), eb("id", "<", id)])]),
      );
    }
    const rows = await query
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(input.limit + 1)
      .execute();
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      items: page.map(toItem),
      unread: await unreadCount(ctx.db, ctx.user.id),
      nextCursor: rows.length > input.limit && last ? encodeCursor(last) : null,
    };
  },
});

export const notificationUnreadCount = defineOperation({
  name: "notification.unreadCount",
  description:
    `How many of your notifications are unread (the bell's badge), counted up to ${UNREAD_COUNT_CAP}. ` +
    "Read-only.",
  input: S["notification.unreadCount"].input,
  output: S["notification.unreadCount"].output,
  permission: "records:read",
  risk: "read",
  mcp: { expose: false },
  async handler(_input, ctx) {
    return { unread: await unreadCount(ctx.db, ctx.user.id) };
  },
});

export const notificationMarkRead = defineOperation({
  name: "notification.markRead",
  description:
    "Mark your notifications read: some by id, or all of them (all: true). Only your own " +
    "notifications change; ids that are not yours or already read are ignored. Returns how " +
    "many changed.",
  input: S["notification.markRead"].input,
  output: S["notification.markRead"].output,
  permission: "records:read",
  // Changes only the caller's own inbox state, never records: never queued for review.
  risk: "write",
  bookkeeping: true,
  mcp: { idempotent: true },
  async handler(input, ctx) {
    let count = ctx.db
      .selectFrom("core_notifications")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("user_id", "=", ctx.user.id)
      .where("read_at", "is", null);
    let update = ctx.db
      .updateTable("core_notifications")
      .set({ read_at: ctx.now })
      .where("user_id", "=", ctx.user.id)
      .where("read_at", "is", null);
    if (input.ids) {
      const ids = [...new Set(input.ids)];
      count = count.where("id", "in", jsonList(ids));
      update = update.where("id", "in", jsonList(ids));
    }
    const row = await count.executeTakeFirst();
    const updated = Number(row?.n ?? 0);
    if (updated) ctx.write(update);
    return { updated };
  },
});

export const notificationOperations = [
  notificationSend,
  notificationList,
  notificationUnreadCount,
  notificationMarkRead,
] as const;
