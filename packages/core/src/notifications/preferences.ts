// Notification delivery settings (stage 6b, ADR 0172): per-person preferences (which types also
// go out by email or Slack DM, and the daily digest), the admin delivery settings (the org
// connections email and Slack go out through, escalation of unread approvals, the digest hour) and
// the admin channel routes (deal won → #sales). Every reader tolerates a missing or broken value:
// it falls back to "deliver nothing externally", never to something louder.
import type { CoreDatabase } from "@crm/db";
import type { Kysely } from "kysely";
import { z } from "zod";
import { jsonList } from "../records/common.ts";
import {
  EXTERNAL_CHANNELS,
  type ExternalChannelId,
  NOTIFICATION_TYPE_NAMES,
  NOTIFICATION_TYPES,
  type NotificationPreferences,
  type NotificationType,
} from "./types.ts";

export const NOTIFICATION_DELIVERY_SETTING = "notification_delivery";
export const NOTIFICATION_ROUTES_SETTING = "notification_routes";
/** The delivery cron's own bookkeeping (cursors, the digest day): one row, written by the cron. */
export const NOTIFICATION_DELIVERY_STATE_SETTING = "notification_delivery_state";

// --- Per-person preferences ---------------------------------------------------------------------

export const externalChannelSchema = z.enum(EXTERNAL_CHANNELS);

/** Stored `core_notification_preference.channels`: type → external channels. */
export const preferenceChannelsSchema = z.partialRecord(
  z.enum(NOTIFICATION_TYPE_NAMES),
  // Repeats are dropped when saved.
  z.array(externalChannelSchema).max(10),
);

export interface UserNotificationPreferences {
  /** Per type, the external channels chosen (in-app is always on). */
  channels: NotificationPreferences;
  /** A daily email digest of unread notifications and pending approvals. */
  digest: boolean;
}

export const DEFAULT_PREFERENCES: UserNotificationPreferences = { channels: {}, digest: false };

function parseJson(text: string | null | undefined): unknown {
  if (text == null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Parses a stored channels value, dropping unknown types and channels. */
export function parsePreferenceChannels(text: string | null | undefined): NotificationPreferences {
  const raw = parseJson(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: NotificationPreferences = {};
  for (const [type, channels] of Object.entries(raw as Record<string, unknown>)) {
    if (!Object.hasOwn(NOTIFICATION_TYPES, type) || !Array.isArray(channels)) continue;
    const valid = [
      ...new Set(
        channels.filter((c): c is ExternalChannelId =>
          (EXTERNAL_CHANNELS as readonly unknown[]).includes(c),
        ),
      ),
    ];
    if (valid.length) out[type as NotificationType] = valid;
  }
  return out;
}

/** Preferences of some people (primary-key reads); people who never chose get the defaults. */
export async function loadPreferences(
  db: Kysely<CoreDatabase>,
  userIds: readonly string[],
): Promise<Map<string, UserNotificationPreferences>> {
  const out = new Map<string, UserNotificationPreferences>();
  const unique = [...new Set(userIds)];
  for (let i = 0; i < unique.length; i += 100) {
    const rows = await db
      .selectFrom("core_notification_preference")
      .select(["user_id", "channels", "digest"])
      .where("user_id", "in", jsonList(unique.slice(i, i + 100)))
      .execute();
    for (const row of rows) {
      out.set(row.user_id, {
        channels: parsePreferenceChannels(row.channels),
        digest: row.digest === 1,
      });
    }
  }
  for (const id of unique) if (!out.has(id)) out.set(id, { ...DEFAULT_PREFERENCES, channels: {} });
  return out;
}

/** The statement that stores a person's preferences (for the operation's batch). */
export function savePreferencesStatement(
  db: Kysely<CoreDatabase>,
  userId: string,
  preferences: UserNotificationPreferences,
  now: string,
) {
  const channels = JSON.stringify(preferences.channels);
  const digest = preferences.digest ? 1 : 0;
  return db
    .insertInto("core_notification_preference")
    .values({ user_id: userId, channels, digest, updated_at: now })
    .onConflict((oc) => oc.column("user_id").doUpdateSet({ channels, digest, updated_at: now }));
}

// --- Admin delivery settings --------------------------------------------------------------------

/** Escalation off: 0. Otherwise between 5 minutes and a week. */
export const ESCALATION_MINUTES_MAX = 7 * 24 * 60;

export const deliverySettingsSchema = z.object({
  /** The org connection email goes out through (an `email-send` connection), or null: no email. */
  email: z.string().min(1).max(64).nullable(),
  /** The org connection Slack goes out through (a Slack connection with `slack-post`), or null. */
  slack: z.string().min(1).max(64).nullable(),
  /** Unread "Approvals waiting" notices escalate after this many minutes (0: never). */
  escalationMinutes: z
    .number()
    .int()
    .min(0)
    .max(ESCALATION_MINUTES_MAX)
    .refine((m) => m === 0 || m >= 5, "must be 0 (off) or at least 5 minutes"),
  /** Where escalations go. */
  escalationChannels: z.array(externalChannelSchema).max(10),
  /** The local hour (automation timezone) the daily digest goes out. */
  digestHour: z.number().int().min(0).max(23),
});
export type DeliverySettings = z.infer<typeof deliverySettingsSchema>;

export const DEFAULT_DELIVERY_SETTINGS: DeliverySettings = {
  email: null,
  slack: null,
  escalationMinutes: 30,
  escalationChannels: ["email"],
  digestHour: 8,
};

/** The admin delivery settings; a missing or broken value means "nothing configured". */
export async function loadDeliverySettings(db: Kysely<CoreDatabase>): Promise<DeliverySettings> {
  const row = await db
    .selectFrom("core_settings")
    .select("value")
    .where("key", "=", NOTIFICATION_DELIVERY_SETTING)
    .executeTakeFirst();
  return parseDeliverySettings(row?.value);
}

export function parseDeliverySettings(text: string | null | undefined): DeliverySettings {
  const raw = parseJson(text);
  const merged =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? { ...DEFAULT_DELIVERY_SETTINGS, ...(raw as object) }
      : DEFAULT_DELIVERY_SETTINGS;
  const parsed = deliverySettingsSchema.safeParse(merged);
  return parsed.success
    ? { ...parsed.data, escalationChannels: [...new Set(parsed.data.escalationChannels)] }
    : { ...DEFAULT_DELIVERY_SETTINGS, email: null, slack: null };
}

// --- Admin channel routes -----------------------------------------------------------------------

/** A value match on a changed field, as the `fieldChanged` trigger takes it. */
export const routeValueMatchSchema = z.union([
  z.string().max(500),
  z.number(),
  z.boolean(),
  z.null(),
  z.object({
    in: z.array(z.union([z.string().max(500), z.number(), z.boolean(), z.null()])).max(50),
  }),
  z.object({ stageType: z.string().min(1).max(40) }),
]);
export type RouteValueMatch = z.infer<typeof routeValueMatchSchema>;

export const ROUTE_EVENTS = ["created", "updated", "deleted"] as const;
export const MAX_ROUTES = 50;

export const notificationRouteSchema = z.object({
  /** `nrt_…`, assigned when a route is first saved. */
  id: z.string().min(1).max(64),
  /** Shown in the message and the settings list, e.g. "Deal won". */
  label: z.string().trim().min(1).max(120),
  /** The object whose records it watches (a core object or `<extension>.<object>`). */
  object: z.string().min(1).max(120),
  event: z.enum(ROUTE_EVENTS),
  /** `updated` only: the field whose change it watches (with `from` / `to`). */
  field: z.string().min(1).max(120).optional(),
  from: routeValueMatchSchema.optional(),
  to: routeValueMatchSchema.optional(),
  /** The Slack channel: `#sales`, `sales` or a channel id. */
  channel: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^#?[A-Za-z0-9_-][A-Za-z0-9._-]*$/, "must be a Slack channel name or id"),
  enabled: z.boolean(),
});
export type NotificationRoute = z.infer<typeof notificationRouteSchema>;

/** The routes; a broken value means no routes. Invalid entries are dropped one by one. */
export function parseRoutes(text: string | null | undefined): NotificationRoute[] {
  const raw = parseJson(text);
  if (!Array.isArray(raw)) return [];
  const out: NotificationRoute[] = [];
  for (const item of raw.slice(0, MAX_ROUTES)) {
    const parsed = notificationRouteSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export async function loadRoutes(db: Kysely<CoreDatabase>): Promise<NotificationRoute[]> {
  const row = await db
    .selectFrom("core_settings")
    .select("value")
    .where("key", "=", NOTIFICATION_ROUTES_SETTING)
    .executeTakeFirst();
  return parseRoutes(row?.value);
}

// --- The cron's bookkeeping ---------------------------------------------------------------------

/** Where the delivery cron is: a keyset cursor per pass, and the digest day. */
export interface DeliveryState {
  /** New notifications delivered up to here (created_at, id). */
  notify: { at: string; id: string } | null;
  /** Approval notices checked for escalation up to here. */
  escalate: { at: string; id: string } | null;
  /** The digest day being (or last) sent, and the last user done on it. */
  digest: { date: string; after: string | null; done: boolean } | null;
}

const cursorSchema = z.object({ at: z.string(), id: z.string() });
const stateSchema = z.object({
  notify: cursorSchema.nullable().catch(null),
  escalate: cursorSchema.nullable().catch(null),
  digest: z
    .object({ date: z.string(), after: z.string().nullable(), done: z.boolean() })
    .nullable()
    .catch(null),
});

export const EMPTY_DELIVERY_STATE: DeliveryState = { notify: null, escalate: null, digest: null };

export async function loadDeliveryState(db: Kysely<CoreDatabase>): Promise<DeliveryState> {
  const row = await db
    .selectFrom("core_settings")
    .select("value")
    .where("key", "=", NOTIFICATION_DELIVERY_STATE_SETTING)
    .executeTakeFirst();
  const parsed = stateSchema.safeParse(parseJson(row?.value) ?? {});
  return parsed.success
    ? { notify: parsed.data.notify, escalate: parsed.data.escalate, digest: parsed.data.digest }
    : { ...EMPTY_DELIVERY_STATE };
}

export function deliveryStateStatement(
  db: Kysely<CoreDatabase>,
  state: DeliveryState,
  now: string,
) {
  const value = JSON.stringify(state);
  return db
    .insertInto("core_settings")
    .values({ key: NOTIFICATION_DELIVERY_STATE_SETTING, value, updated_at: now, updated_by: null })
    .onConflict((oc) => oc.column("key").doUpdateSet({ value, updated_at: now }));
}
