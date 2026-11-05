// External notification delivery (stage 6b, ADR 0172): what ros-runner's minute cron does with
// committed notifications. One tick:
//
// 1. New notices: core_notifications rows past a keyset cursor (created_at, id), lagging 30 s
//    behind now so rows of batches still committing are not skipped, read through
//    core_notifications_created_idx. Each goes to the external channels its recipient chose for
//    its type (`routeNotification`), on the org connection the admin picked per channel.
// 2. Escalation: "Approvals waiting" notices still unread `escalationMinutes` after they were
//    written go out on `escalationChannels`, unless the notice already went out externally by
//    preference or its change set has nothing pending any more. Escalations are not notices, so
//    an escalation is never escalated (cost audit U8).
// 3. The daily digest (ADR 0206), from `digestHour` in the automation timezone: changes others
//    made to the person's records, tasks due, approvals waiting and unread notices, in the app
//    (on unless turned off; only when there is news) and by email (when asked for and email is
//    configured), with an optional AI overview. Runs even with no channel configured.
//
// Every send is claimed in the ledger first (`n:<notificationId>:<channel>`,
// `esc:<notificationId>:<channel>`, `digest:<date>:<userId>`), so a repeated tick never sends
// twice (the digest's claim covers its in-app copy, its email and its one model call). A failed or pending send never touches the in-app row. Notices that link to an activity
// that is private (or gone) are never delivered externally or digested: synced email and meetings
// marked private stay in the CRM (ADR 0052). The cursors and the digest day live in one settings
// row, written at most once per tick and only when it changed.
import type { CoreDatabase } from "@relationship-os/db";
import { type Kysely, sql } from "kysely";
import type { ModelRunner } from "../ai/client.ts";
import { zonedTime } from "../automations/cron.ts";
import { loadAutomationSettings } from "../automations/registry.ts";
import { newId } from "../ids.ts";
import { notificationHref } from "../operations/notification.ts";
import { roleHasPermission } from "../principals.ts";
import { jsonList } from "../records/common.ts";
import {
  type CallIntegration,
  type ChannelTarget,
  emailChannel,
  resolveChannelTarget,
  sendEmail,
  slackChannel,
} from "./channels.ts";
import {
  DIGEST_ITEMS,
  type DigestComposer,
  type DigestInput,
  type DigestItem,
  digestHasNews,
  digestMarkdown,
  digestOverview,
  plainDigest,
} from "./digest.ts";
import {
  changesFor,
  dueBound,
  loadRecentChanges,
  type RecentChanges,
  tasksDueFor,
} from "./digest-content.ts";
import { claimDelivery, type DeliveryKind, type DeliveryResult, settleDelivery } from "./ledger.ts";
import {
  type DeliverySettings,
  type DeliveryState,
  deliveryStateStatement,
  loadDeliverySettings,
  loadDeliveryState,
  loadPreferences,
  type UserNotificationPreferences,
} from "./preferences.ts";
import {
  type DeliveryOutcome,
  EXTERNAL_CHANNELS,
  type ExternalChannelId,
  NOTIFICATION_TYPES,
  type NotificationChannel,
  type NotificationLink,
  type NotificationRecord,
  type NotificationType,
  notificationLinkSchema,
  routeNotification,
} from "./types.ts";

/** How far behind now the new-notice pass reads (rows of batches still committing). */
export const DELIVERY_LAG_MS = 30_000;
/** Rows per read, and reads per pass per tick. */
export const DELIVERY_BATCH = 100;
export const DELIVERY_MAX_BATCHES = 5;
/** Digest recipients per tick; the rest follow on the next ticks. */
export const DIGEST_USERS_PER_TICK = 50;

export interface DeliveryDeps {
  db: Kysely<CoreDatabase>;
  now: Date;
  /** The app's public origin (`https://crm.example.com`), for absolute links; null: no links. */
  appOrigin: string | null;
  callIntegration: CallIntegration;
  /** The digest email's composer. Default: plainDigest. */
  composeDigest?: DigestComposer;
  /** Model roles for the digest's AI overview (`summarise`); none: the plain digest. */
  models?: ModelRunner | null;
  /** Preloaded settings (tests). */
  settings?: DeliverySettings;
}

export interface DeliveryReport {
  notifications: DeliveryResult[];
  escalations: DeliveryResult[];
  digests: DeliveryResult[];
  /** Channel targets the admin set that cannot be used, and why. */
  problems: string[];
}

interface NotificationRow {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  source: string;
  read_at: string | null;
  created_at: string;
}

interface Recipient {
  id: string;
  name: string;
  email: string;
  role: "admin" | "member" | "viewer";
}

function parseJson(text: string | null): unknown {
  if (text == null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function toNotificationRecord(row: NotificationRow): NotificationRecord {
  const link = notificationLinkSchema.safeParse(parseJson(row.link));
  const source = parseJson(row.source);
  return {
    id: row.id,
    userId: row.user_id,
    type: (Object.hasOwn(NOTIFICATION_TYPES, row.type)
      ? row.type
      : "system.message") as NotificationType,
    title: row.title,
    body: row.body,
    link: link.success ? link.data : null,
    source:
      source && typeof source === "object" && !Array.isArray(source)
        ? (source as NotificationRecord["source"])
        : { actor: "system" },
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

/** The absolute URL of a notice's link, when the origin is known. */
export function absoluteUrl(
  appOrigin: string | null,
  link: NotificationLink | null,
): string | null {
  const href = notificationHref(link);
  if (!href || !appOrigin) return null;
  return `${appOrigin.replace(/\/+$/, "")}${href}`;
}

/**
 * May this notice leave the CRM? Not when it links to an activity that is private to its owner
 * (synced email or a meeting marked private) or no longer visible: crm_activities hides both.
 */
export async function disclosable(
  db: Kysely<CoreDatabase>,
  notification: Pick<NotificationRecord, "link">,
): Promise<boolean> {
  const link = notification.link;
  if (link?.kind !== "record" || link.object !== "activity") return true;
  const row = await db
    .selectFrom("crm_activities")
    .select("id")
    .where("id", "=", link.id)
    .executeTakeFirst();
  return Boolean(row);
}

/** Reads notices after `cursor`, up to `upTo`, in (created_at, id) order. */
async function noticesAfter(
  db: Kysely<CoreDatabase>,
  cursor: { at: string; id: string },
  upTo: string,
  limit: number,
  type?: NotificationType,
): Promise<NotificationRow[]> {
  let query = db
    .selectFrom("core_notifications")
    .select(["id", "user_id", "type", "title", "body", "link", "source", "read_at", "created_at"])
    .where("created_at", ">=", cursor.at)
    .where("created_at", "<=", upTo)
    .where((eb) => eb.or([eb("created_at", ">", cursor.at), eb("id", ">", cursor.id)]));
  if (type) query = query.where("type", "=", type);
  return query.orderBy("created_at").orderBy("id").limit(limit).execute();
}

async function loadRecipients(
  db: Kysely<CoreDatabase>,
  ids: readonly string[],
): Promise<Map<string, Recipient>> {
  const out = new Map<string, Recipient>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 100) {
    const rows = await db
      .selectFrom("core_user")
      .select(["id", "name", "email", "role"])
      .where("id", "in", jsonList(unique.slice(i, i + 100)))
      .where("kind", "=", "human")
      .where("deactivated_at", "is", null)
      .execute();
    for (const row of rows) out.set(row.id, row);
  }
  return out;
}

interface Targets {
  channels: Partial<Record<ExternalChannelId, NotificationChannel>>;
  email: ChannelTarget | null;
  problems: string[];
}

async function resolveTargets(
  db: Kysely<CoreDatabase>,
  settings: DeliverySettings,
): Promise<Targets> {
  const out: Targets = { channels: {}, email: null, problems: [] };
  for (const channel of EXTERNAL_CHANNELS) {
    const connectionId = settings[channel];
    if (!connectionId) continue;
    const resolved = await resolveChannelTarget(db, channel, connectionId);
    if ("problem" in resolved) {
      out.problems.push(`${channel}: ${resolved.problem}`);
      continue;
    }
    out.channels[channel] =
      channel === "email" ? emailChannel(resolved.target) : slackChannel(resolved.target);
    if (channel === "email") out.email = resolved.target;
  }
  return out;
}

/** One claimed send of a notice on a channel. */
async function deliverNotice(
  deps: DeliveryDeps,
  notice: NotificationRecord,
  recipient: Recipient,
  channel: NotificationChannel,
  kind: DeliveryKind,
  key: string,
  now: string,
): Promise<DeliveryResult> {
  const id = channel.id as ExternalChannelId;
  if (!(await claimDelivery(deps.db, { key, kind, channel: id, userId: recipient.id }, now))) {
    return { key, status: "duplicate" };
  }
  try {
    const outcome = await channel.deliver(notice, {
      recipient: { userId: recipient.id, email: recipient.email || null, name: recipient.name },
      callIntegration: deps.callIntegration,
      url: absoluteUrl(deps.appOrigin, notice.link),
    });
    return await settleDelivery(deps.db, key, outcome);
  } catch (error) {
    return settleDelivery(deps.db, key, error);
  }
}

/** Records a notice that may not leave the CRM, so it is not considered again. */
async function skipNotice(
  deps: DeliveryDeps,
  key: string,
  kind: DeliveryKind,
  channel: ExternalChannelId,
  userId: string,
  detail: string,
  now: string,
): Promise<DeliveryResult> {
  const claimed = await claimDelivery(
    deps.db,
    { key, kind, channel, userId, status: "skipped", detail },
    now,
  );
  return { key, status: claimed ? "skipped" : "duplicate", detail };
}

/** Pass 1: new notices, routed per preferences. */
async function deliverNew(
  deps: DeliveryDeps,
  targets: Targets,
  state: DeliveryState,
  report: DeliveryReport,
): Promise<void> {
  const nowIso = deps.now.toISOString();
  const upTo = new Date(deps.now.getTime() - DELIVERY_LAG_MS).toISOString();
  // First run (or first since a channel was configured): start at the lag line, no backlog.
  if (!state.notify) {
    state.notify = { at: upTo, id: "" };
    return;
  }
  for (let batch = 0; batch < DELIVERY_MAX_BATCHES; batch++) {
    const rows = await noticesAfter(deps.db, state.notify, upTo, DELIVERY_BATCH);
    if (!rows.length) return;
    const userIds = [...new Set(rows.map((r) => r.user_id))];
    const preferences = await loadPreferences(deps.db, userIds);
    const recipients = await loadRecipients(deps.db, userIds);
    const handle = async (row: NotificationRow) => {
      const recipient = recipients.get(row.user_id);
      if (!recipient) return;
      const notice = toNotificationRecord(row);
      const chosen = routeNotification(notice.type, preferences.get(row.user_id)?.channels).filter(
        (c): c is ExternalChannelId => c !== "inApp" && Boolean(targets.channels[c]),
      );
      if (!chosen.length) return;
      // Seen in the app already, or an approval nobody has to make any more: nothing to send.
      if (row.read_at !== null) return;
      if (notice.type === "approval.pending" && !(await stillPending(deps.db, notice.link, nowIso)))
        return;
      const allowed = await disclosable(deps.db, notice);
      for (const channel of chosen) {
        const key = `n:${notice.id}:${channel}`;
        report.notifications.push(
          allowed
            ? await deliverNotice(
                deps,
                notice,
                recipient,
                targets.channels[channel] as NotificationChannel,
                "notification",
                key,
                nowIso,
              )
            : await skipNotice(
                deps,
                key,
                "notification",
                channel,
                recipient.id,
                "Links to private content",
                nowIso,
              ),
        );
      }
    };
    for (const row of rows) {
      await handle(row);
      state.notify = { at: row.created_at, id: row.id };
    }
    if (rows.length < DELIVERY_BATCH) return;
  }
}

/** Whether the change set of an approval notice still has an action waiting. */
async function stillPending(
  db: Kysely<CoreDatabase>,
  link: NotificationLink | null,
  now: string,
): Promise<boolean> {
  if (link?.kind !== "approval") return false;
  const row = await db
    .selectFrom("core_pending_action")
    .select("id")
    .where("change_set_id", "=", link.changeSetId)
    .where("status", "=", "pending")
    .where("expires_at", ">", now)
    .limit(1)
    .executeTakeFirst();
  return Boolean(row);
}

/** Pass 2: unread "Approvals waiting" notices, escalated once per channel. */
async function escalate(
  deps: DeliveryDeps,
  settings: DeliverySettings,
  targets: Targets,
  state: DeliveryState,
  report: DeliveryReport,
): Promise<void> {
  const nowIso = deps.now.toISOString();
  const channels = settings.escalationChannels.filter((c) => targets.channels[c]);
  if (!settings.escalationMinutes || !channels.length) return;
  const upTo = new Date(deps.now.getTime() - settings.escalationMinutes * 60_000).toISOString();
  if (!state.escalate) {
    state.escalate = { at: upTo, id: "" };
    return;
  }
  for (let batch = 0; batch < DELIVERY_MAX_BATCHES; batch++) {
    const rows = await noticesAfter(
      deps.db,
      state.escalate,
      upTo,
      DELIVERY_BATCH,
      "approval.pending",
    );
    if (!rows.length) return;
    const candidates = rows.filter((r) => r.read_at === null);
    const recipients = await loadRecipients(
      deps.db,
      candidates.map((r) => r.user_id),
    );
    const handle = async (row: NotificationRow) => {
      const recipient = recipients.get(row.user_id);
      if (row.read_at !== null || !recipient) return;
      const notice = toNotificationRecord(row);
      // Already out by email or Slack because the person asked for it: no second nudge.
      const earlier = await deps.db
        .selectFrom("core_notification_delivery")
        .select("key")
        .where(
          "key",
          "in",
          EXTERNAL_CHANNELS.map((c) => `n:${notice.id}:${c}`),
        )
        .where("status", "in", ["sent", "pending", "sending"])
        .executeTakeFirst();
      if (earlier) return;
      if (!(await stillPending(deps.db, notice.link, nowIso))) return;
      const minutes = settings.escalationMinutes;
      const reminder: NotificationRecord = {
        ...notice,
        title: `Reminder: ${notice.title}`,
        body: `Still waiting for your approval after ${minutes} minutes. ${notice.body ?? ""}`.trim(),
      };
      for (const channel of channels) {
        report.escalations.push(
          await deliverNotice(
            deps,
            reminder,
            recipient,
            targets.channels[channel] as NotificationChannel,
            "escalation",
            `esc:${notice.id}:${channel}`,
            nowIso,
          ),
        );
      }
    };
    for (const row of rows) {
      await handle(row);
      state.escalate = { at: row.created_at, id: row.id };
    }
    if (rows.length < DELIVERY_BATCH) return;
  }
}

/** Pending actions in the approvals inbox (capped), for the digest. */
async function pendingApprovalCount(db: Kysely<CoreDatabase>, now: string): Promise<number> {
  const result = await sql<{ n: number }>`SELECT count(*) AS n FROM (
      SELECT 1 FROM core_pending_action WHERE status = 'pending' AND expires_at > ${now}
      LIMIT 1000)`.execute(db);
  return Number(result.rows[0]?.n ?? 0);
}

/** Pass 3: the daily digest (ADR 0172, ADR 0206). */
async function digest(
  deps: DeliveryDeps,
  settings: DeliverySettings,
  targets: Targets,
  state: DeliveryState,
  report: DeliveryReport,
): Promise<void> {
  const { timezone } = await loadAutomationSettings(deps.db);
  const local = zonedTime(deps.now, timezone);
  if (local.hour < settings.digestHour) return;
  if (state.digest?.date !== local.date) {
    state.digest = { date: local.date, after: null, done: false };
  }
  const day = state.digest;
  if (day.done) return;
  const nowIso = deps.now.toISOString();
  const since = new Date(deps.now.getTime() - 86_400_000).toISOString();
  // Everyone gets the in-app digest unless they turned it off, so the pass walks people by
  // primary key (at most 50 a tick, resumable), not the email-digest preference.
  let query = deps.db
    .selectFrom("core_user")
    .select(["id", "name", "email", "role"])
    .where("kind", "=", "human")
    .where("deactivated_at", "is", null);
  if (day.after) query = query.where("id", ">", day.after);
  const people = await query.orderBy("id").limit(DIGEST_USERS_PER_TICK).execute();
  const preferences = people.length
    ? await loadPreferences(
        deps.db,
        people.map((p) => p.id),
      )
    : new Map<string, UserNotificationPreferences>();
  const origin = deps.appOrigin ? deps.appOrigin.replace(/\/+$/, "") : null;
  const bound = dueBound(local.date, deps.now, local);
  let pending: number | null = null;
  let recent: RecentChanges | null = null;
  const compose = deps.composeDigest ?? plainDigest;
  for (const recipient of people as Recipient[]) {
    const userId = recipient.id;
    day.after = userId;
    const prefs = preferences.get(userId);
    const wantsInApp = prefs?.digestInApp ?? true;
    const wantsEmail = Boolean(prefs?.digest && targets.email && recipient.email);
    if (!wantsInApp && !wantsEmail) continue;

    recent ??= await loadRecentChanges(deps.db, since, nowIso);
    const changes = changesFor(recent, userId, origin);
    const tasks = await tasksDueFor(deps.db, userId, {
      localDate: local.date,
      bound,
      now: nowIso,
      appOrigin: origin,
    });
    const notices = await unreadNotices(deps, userId, since);
    const canApprove = roleHasPermission(recipient.role, "records:write");
    if (canApprove) pending ??= await pendingApprovalCount(deps.db, nowIso);
    const input: DigestInput = {
      recipient: { userId, name: recipient.name, email: recipient.email },
      date: day.date,
      changes: changes.changes,
      changesTotal: changes.total,
      tasks: tasks.tasks,
      tasksTotal: tasks.total,
      items: notices.items,
      unreadTotal: notices.total,
      pendingApprovals: canApprove ? (pending ?? 0) : 0,
      approvalsUrl: origin ? `${origin}/approvals` : null,
      overview: null,
    };
    // In the app only when there is news (unread notices are in the inbox already); by email
    // also for unread notices alone, as before.
    const inApp = wantsInApp && digestHasNews(input);
    const email = wantsEmail && (digestHasNews(input) || input.unreadTotal > 0);
    if (!inApp && !email) continue;

    // One claim per person per day covers both copies and the model call.
    const key = `digest:${day.date}:${userId}`;
    const channel = email ? "email" : "inApp";
    if (!(await claimDelivery(deps.db, { key, kind: "digest", channel, userId }, nowIso))) {
      report.digests.push({ key, status: "duplicate" });
      continue;
    }
    try {
      input.overview = await digestOverview(deps.models, input);
      if (inApp) {
        const message = digestMarkdown(input);
        await deps.db
          .insertInto("core_notifications")
          .orIgnore()
          .values({
            id: newId("notification"),
            user_id: userId,
            type: "digest",
            title: message.title,
            body: message.body,
            link: null,
            source: JSON.stringify({
              actor: "system",
              ...(input.overview ? { aiGenerated: true } : {}),
            }),
            dedupe_key: `digest:${day.date}`,
            read_at: null,
            created_at: nowIso,
          })
          .execute();
      }
      let outcome: DeliveryOutcome = { status: "sent", detail: "in-app" };
      if (email && targets.email) {
        const message = await compose(input);
        const sent = await sendEmail(deps.callIntegration, targets.email, {
          to: recipient.email,
          subject: message.subject,
          text: message.text,
        });
        const detail = [inApp ? "in-app" : null, sent.detail ?? null].filter(Boolean).join("; ");
        outcome = { status: sent.status, ...(detail ? { detail } : {}) };
      }
      report.digests.push(await settleDelivery(deps.db, key, outcome));
    } catch (error) {
      report.digests.push(await settleDelivery(deps.db, key, error));
    }
  }
  if (people.length < DIGEST_USERS_PER_TICK) day.done = true;
}

/** A person's unread notices of the last day that may be listed, and how many there are. */
async function unreadNotices(
  deps: DeliveryDeps,
  userId: string,
  since: string,
): Promise<{ items: DigestItem[]; total: number }> {
  const rows = await deps.db
    .selectFrom("core_notifications")
    .select(["id", "user_id", "type", "title", "body", "link", "source", "read_at", "created_at"])
    .where("user_id", "=", userId)
    .where("created_at", ">=", since)
    .where("read_at", "is", null)
    .where("type", "<>", "digest")
    .orderBy("created_at", "desc")
    .limit(DIGEST_ITEMS * 2)
    .execute();
  const unread = await sql<{ n: number }>`SELECT count(*) AS n FROM (
      SELECT 1 FROM core_notifications INDEXED BY core_notifications_user_idx
      WHERE user_id = ${userId} AND created_at >= ${since} AND read_at IS NULL
        AND type <> 'digest'
      LIMIT 1000)`.execute(deps.db);
  const items: DigestItem[] = [];
  let hidden = 0;
  for (const row of rows) {
    const notice = toNotificationRecord(row);
    if (!(await disclosable(deps.db, notice))) {
      hidden += 1;
      continue;
    }
    if (items.length < DIGEST_ITEMS) {
      items.push({
        type: notice.type,
        title: notice.title,
        body: notice.body,
        url: absoluteUrl(deps.appOrigin, notice.link),
        href: notificationHref(notice.link),
        createdAt: notice.createdAt,
      });
    }
  }
  return { items, total: Math.max(0, Number(unread.rows[0]?.n ?? 0) - hidden) };
}

/**
 * One delivery tick. While no channel is configured it runs only the digest pass (in-app), which
 * reads the settings, the cron state and the automation timezone and stops there outside the
 * digest window. Returns what it sent, for logs and tests.
 */
export async function runNotificationDelivery(deps: DeliveryDeps): Promise<DeliveryReport> {
  const report: DeliveryReport = { notifications: [], escalations: [], digests: [], problems: [] };
  const settings = deps.settings ?? (await loadDeliverySettings(deps.db));
  const targets: Targets =
    settings.email || settings.slack
      ? await resolveTargets(deps.db, settings)
      : { channels: {}, email: null, problems: [] };
  report.problems.push(...targets.problems);
  const external = Object.keys(targets.channels).length > 0;
  const state = await loadDeliveryState(deps.db);
  const before = JSON.stringify(state);
  const passes: [string, () => Promise<void>][] = [];
  if (external) {
    passes.push(["notifications", () => deliverNew(deps, targets, state, report)]);
    passes.push(["escalation", () => escalate(deps, settings, targets, state, report)]);
  }
  // The daily digest also goes in-app, so it runs with no channel configured (ADR 0206).
  passes.push(["digest", () => digest(deps, settings, targets, state, report)]);
  for (const [name, pass] of passes) {
    try {
      await pass();
    } catch (error) {
      // One pass failing (a D1 hiccup) must not stop the others; its cursor stays where the
      // last fully handled row left it.
      console.error(`notification delivery: ${name} pass failed`, error);
      report.problems.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (JSON.stringify(state) !== before) {
    await deliveryStateStatement(deps.db, state, deps.now.toISOString()).execute();
  }
  return report;
}
