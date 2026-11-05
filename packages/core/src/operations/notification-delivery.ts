// Notification delivery settings (stage 6b, ADR 0172): a person's own email / Slack preferences
// and daily digest, and the admin settings (the org connections email and Slack go out through,
// escalation of unread approvals, the digest hour, and channel routes such as deal won → #sales).
// Preferences are scoped to the calling person; the admin settings are human-admin only and
// audited (they decide what leaves the CRM). Delivery itself is ros-runner's minute cron.
import type { CoreDatabase } from "@relationship-os/db";
import type { Kysely } from "kysely";
import { z } from "zod";
import { ForbiddenError, ValidationError } from "../errors.ts";
import { getField, getObject } from "../fields/index.ts";
import { newId } from "../ids.ts";
import { CHANNEL_VENDORS, resolveChannelTarget } from "../notifications/channels.ts";
import {
  type DeliverySettings,
  deliverySettingsSchema,
  deliveryStateStatement,
  externalChannelSchema,
  loadDeliverySettings,
  loadDeliveryState,
  loadPreferences,
  loadRoutes,
  MAX_ROUTES,
  NOTIFICATION_DELIVERY_SETTING,
  NOTIFICATION_ROUTES_SETTING,
  type NotificationRoute,
  notificationRouteSchema,
  preferenceChannelsSchema,
  savePreferencesStatement,
  type UserNotificationPreferences,
} from "../notifications/preferences.ts";
import { UNROUTABLE_OBJECTS } from "../notifications/routes.ts";
import {
  EXTERNAL_CHANNELS,
  type ExternalChannelId,
  NOTIFICATION_TYPE_NAMES,
  NOTIFICATION_TYPES,
  type NotificationType,
} from "../notifications/types.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";

// --- Schemas ------------------------------------------------------------------------------------

const preferencesOutput = z.object({
  types: z.array(
    z.object({
      type: z.enum(NOTIFICATION_TYPE_NAMES),
      label: z.string(),
      category: z.string(),
      /** External channels chosen for this type (in-app is always on). */
      channels: z.array(externalChannelSchema),
    }),
  ),
  digest: z.boolean(),
  /** Whether an admin has set up each channel (choices for an unset channel wait for it). */
  available: z.object({ email: z.boolean(), slack: z.boolean() }),
});
type PreferencesOutput = z.infer<typeof preferencesOutput>;

const routeInputSchema = notificationRouteSchema.extend({
  id: z.string().min(1).max(64).optional(),
});

// --- Helpers ------------------------------------------------------------------------------------

function preferencesView(
  prefs: UserNotificationPreferences,
  settings: DeliverySettings,
): PreferencesOutput {
  return {
    types: NOTIFICATION_TYPE_NAMES.map((type) => ({
      type,
      label: NOTIFICATION_TYPES[type].label,
      category: NOTIFICATION_TYPES[type].category,
      channels: (prefs.channels[type] ?? []).filter((c): c is ExternalChannelId => c !== "inApp"),
    })),
    digest: prefs.digest,
    available: { email: settings.email !== null, slack: settings.slack !== null },
  };
}

/** Admin reads: a read permission (registry rule) plus the admin role, checked here. */
function requireAdmin(ctx: HandlerContext): void {
  if (ctx.user.role !== "admin") {
    throw new ForbiddenError("Only admins can see the notification delivery settings");
  }
}

function settingWrite(ctx: HandlerContext, key: string, value: unknown) {
  const json = JSON.stringify(value);
  ctx.write(
    ctx.db
      .insertInto("core_settings")
      .values({ key, value: json, updated_at: ctx.now, updated_by: ctx.user.id })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet({ value: json, updated_at: ctx.now, updated_by: ctx.user.id }),
      ),
  );
}

/** An org connection of an allowed vendor for the channel, with its sender / workspace bound. */
async function checkConnection(
  db: Kysely<CoreDatabase>,
  channel: ExternalChannelId,
  connectionId: string,
): Promise<void> {
  const row = await db
    .selectFrom("core_integration_connection")
    .select(["vendor", "scope"])
    .where("id", "=", connectionId)
    .executeTakeFirst();
  if (!row) {
    throw new ValidationError(`No connection ${connectionId}`, { field: channel });
  }
  if (!CHANNEL_VENDORS[channel].includes(row.vendor)) {
    throw new ValidationError(
      channel === "email"
        ? "Email notifications go out through an Email sending connection"
        : "Slack notifications go out through a Slack connection with posting",
      { field: channel, vendor: row.vendor },
    );
  }
  if (row.scope !== "org") {
    throw new ValidationError("Notifications go out through org connections only", {
      field: channel,
    });
  }
  const resolved = await resolveChannelTarget(db, channel, connectionId);
  if ("problem" in resolved) throw new ValidationError(resolved.problem, { field: channel });
}

function normaliseRoute(input: z.infer<typeof routeInputSchema>, index: number): NotificationRoute {
  const field = (name: string) => ({ field: `routes.${index}.${name}` });
  const object = getObject(input.object);
  if (!object) throw new ValidationError(`Unknown object "${input.object}"`, field("object"));
  if (UNROUTABLE_OBJECTS.includes(object.name)) {
    throw new ValidationError(
      `${object.label} records hold synced email and meetings: they are never posted to Slack`,
      field("object"),
    );
  }
  if (input.field !== undefined || input.from !== undefined || input.to !== undefined) {
    if (input.event !== "updated") {
      throw new ValidationError("A field change only applies to the updated event", field("field"));
    }
    if (!input.field) throw new ValidationError("from / to need a field", field("field"));
    if (!getField(object, input.field)) {
      throw new ValidationError(`${object.label} has no field "${input.field}"`, field("field"));
    }
    const stageTyped = [input.from, input.to].some(
      (m) => m !== null && typeof m === "object" && "stageType" in m,
    );
    if (stageTyped && !object.stages) {
      throw new ValidationError(`${object.label} has no stages`, field("to"));
    }
  }
  return {
    id: input.id ?? newId("notificationRoute"),
    label: input.label,
    object: object.name,
    event: input.event,
    ...(input.field !== undefined ? { field: input.field } : {}),
    ...(input.from !== undefined ? { from: input.from } : {}),
    ...(input.to !== undefined ? { to: input.to } : {}),
    channel: input.channel,
    enabled: input.enabled,
  };
}

// --- A person's preferences ---------------------------------------------------------------------

export const notificationPreferences = defineOperation({
  name: "notification.preferences",
  description:
    "Your notification preferences: for each notification type, whether it also reaches you by " +
    "email or Slack DM (in-app is always on), whether you get a daily email digest, and which " +
    "channels an admin has set up. Read-only.",
  input: z.object({}),
  output: preferencesOutput,
  permission: "records:read",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(_input, ctx) {
    const [prefs, settings] = await Promise.all([
      loadPreferences(ctx.db, [ctx.user.id]),
      loadDeliverySettings(ctx.db),
    ]);
    return preferencesView(prefs.get(ctx.user.id) ?? { channels: {}, digest: false }, settings);
  },
});

export const notificationSetPreferences = defineOperation({
  name: "notification.setPreferences",
  description:
    "Change your notification preferences: `channels` maps a notification type to the external " +
    "channels it should also reach you on (`email`, `slack`; an empty list means in-app only; " +
    "types you leave out keep their setting), and `digest` turns the daily email digest on or " +
    "off. Only your own preferences change.",
  input: z.object({
    channels: preferenceChannelsSchema.optional(),
    digest: z.boolean().optional(),
  }),
  output: preferencesOutput,
  permission: "records:read",
  // Changes only the caller's own delivery choices, never records: never queued for review.
  risk: "write",
  bookkeeping: true,
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const [prefs, settings] = await Promise.all([
      loadPreferences(ctx.db, [ctx.user.id]),
      loadDeliverySettings(ctx.db),
    ]);
    const current = prefs.get(ctx.user.id) ?? { channels: {}, digest: false };
    const channels = { ...current.channels };
    for (const [type, chosen] of Object.entries(input.channels ?? {})) {
      const unique = [...new Set(chosen ?? [])];
      if (unique.length) channels[type as NotificationType] = unique;
      else delete channels[type as NotificationType];
    }
    const next: UserNotificationPreferences = { channels, digest: input.digest ?? current.digest };
    ctx.write(savePreferencesStatement(ctx.db, ctx.user.id, next, ctx.now));
    return preferencesView(next, settings);
  },
});

// --- Admin: delivery settings -------------------------------------------------------------------

export const notificationDeliverySettings = defineOperation({
  name: "notification.deliverySettings",
  description:
    "The org's notification delivery settings (admins): the org connection email notifications " +
    "and digests go out through (`email`, an Email sending connection) and the one Slack DMs and " +
    "channel posts go out through (`slack`), how many minutes an unread 'Approvals waiting' " +
    "notice waits before it escalates (0: never) and on which channels, and the local hour of " +
    "the daily digest. `problems` lists set connections that cannot be used, and why. Read-only.",
  input: z.object({}),
  output: deliverySettingsSchema.extend({ problems: z.array(z.string()) }),
  permission: "records:read",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(_input, ctx) {
    requireAdmin(ctx);
    const settings = await loadDeliverySettings(ctx.db);
    const problems: string[] = [];
    for (const channel of EXTERNAL_CHANNELS) {
      const id = settings[channel];
      if (!id) continue;
      const resolved = await resolveChannelTarget(ctx.db, channel, id);
      if ("problem" in resolved) problems.push(`${channel}: ${resolved.problem}`);
    }
    return { ...settings, problems };
  },
});

export const notificationUpdateDeliverySettings = defineOperation({
  name: "notification.updateDeliverySettings",
  description:
    "Change the org's notification delivery settings (human admins only, audited): `email` / " +
    "`slack` pick the org connection each channel goes out through (null turns the channel " +
    "off), `escalationMinutes` and `escalationChannels` set when and where unread approval " +
    "notices escalate, `digestHour` the local hour of the daily digest. Fields you leave out " +
    "keep their value. Each send is an outbound action: enable auto-approval of the internal " +
    "kinds (outbound.setAutoApprove) or every notice waits for review.",
  input: deliverySettingsSchema.partial(),
  output: deliverySettingsSchema,
  permission: "settings:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const before = await loadDeliverySettings(ctx.db);
    const after: DeliverySettings = {
      ...before,
      ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
    };
    after.escalationChannels = [...new Set(after.escalationChannels)];
    for (const channel of EXTERNAL_CHANNELS) {
      const id = input[channel];
      if (id && id !== before[channel]) await checkConnection(ctx.db, channel, id);
    }
    settingWrite(ctx, NOTIFICATION_DELIVERY_SETTING, after);
    // Turning delivery on starts from now: the backlog written while it was off stays in-app.
    if (!before.email && !before.slack && (after.email || after.slack)) {
      const state = await loadDeliveryState(ctx.db);
      ctx.write(
        deliveryStateStatement(
          ctx.db,
          {
            ...state,
            notify: { at: ctx.now, id: "" },
            escalate: { at: ctx.now, id: "" },
          },
          ctx.now,
        ),
      );
    }
    ctx.recordChange({
      object: "settings",
      id: NOTIFICATION_DELIVERY_SETTING,
      action: "update",
      before: { ...before },
      after: { ...after },
    });
    return after;
  },
});

// --- Admin: channel routes ----------------------------------------------------------------------

export const notificationRoutes = defineOperation({
  name: "notification.routes",
  description:
    "The org's Slack channel routes (admins): each posts a short message with a link to a " +
    "Slack channel when a record of an object is created, updated or deleted, optionally only " +
    "when a field changes (`field`, with `from` / `to` values or `{ stageType: 'won' }` for a " +
    "stage move). Read-only.",
  input: z.object({}),
  output: z.object({ routes: z.array(notificationRouteSchema) }),
  permission: "records:read",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(_input, ctx) {
    requireAdmin(ctx);
    return { routes: await loadRoutes(ctx.db) };
  },
});

export const notificationSetRoutes = defineOperation({
  name: "notification.setRoutes",
  description:
    `Replace the org's Slack channel routes (human admins only, audited; at most ${MAX_ROUTES}). ` +
    "Each route: `label` (e.g. 'Deal won'), `object`, `event` (created, updated or deleted), " +
    "optional `field` with `from` / `to` (a value, { in: [...] } or { stageType }), the Slack " +
    "`channel` (#sales) and `enabled`. Routes without an id get one. Activities (synced email " +
    "and meetings) cannot be routed. Posts go through the Slack connection of the delivery " +
    "settings.",
  input: z.object({ routes: z.array(routeInputSchema).max(MAX_ROUTES) }),
  output: z.object({ routes: z.array(notificationRouteSchema) }),
  permission: "settings:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const before = await loadRoutes(ctx.db);
    const routes = input.routes.map(normaliseRoute);
    const ids = new Set<string>();
    for (const route of routes) {
      if (ids.has(route.id)) {
        throw new ValidationError(`Route id ${route.id} appears twice`, { field: "routes" });
      }
      ids.add(route.id);
    }
    settingWrite(ctx, NOTIFICATION_ROUTES_SETTING, routes);
    ctx.recordChange({
      object: "settings",
      id: NOTIFICATION_ROUTES_SETTING,
      action: "update",
      before: { routes: before },
      after: { routes },
    });
    return { routes };
  },
});

export const notificationDeliveryOperations = [
  notificationPreferences,
  notificationSetPreferences,
  notificationDeliverySettings,
  notificationUpdateDeliverySettings,
  notificationRoutes,
  notificationSetRoutes,
] as const;
