// integration.*, connection.* and outbound.* operations (stage 6a, ADRs 0050, 0051, 0110): the
// gatekeeper catalogue an admin enables, connections (personal and org-wide), their resources and
// sync, calling a connected gatekeeper's session as the caller, and which outbound action kinds
// may auto-apply. The integration host (ros-runner, one Durable Object per connection) is the
// authority for accounts and facets; these operations keep the D1 mirror the UI reads.

import type { CoreDatabase, CoreIntegrationConnectionTable } from "@relationship-os/db";
import type { Kysely, Selectable } from "kysely";
import { z } from "zod";
import { revokeBindingsPlan } from "../automations/bindings.ts";
import { ForbiddenError, NotFoundError, OperationError, ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { CATALOGUE, catalogueEntry, syncKindOf } from "../integrations/catalogue.ts";
import { pendingOutboundCounts } from "../integrations/outbound.ts";
import type { BoundResource, IntegrationRuntime } from "../integrations/runtime.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { roleHasPermission } from "../principals.ts";

// --- Schemas -----------------------------------------------------------------------------------

const connectionId = z.string().startsWith("con_").max(64).describe("Connection id (con_…)");
const vendorName = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,40}$/)
  .describe("Gatekeeper vendor, e.g. google");
export const SHARING_LEVELS = ["full", "metadata", "none"] as const;
const sharingLevel = z
  .enum(SHARING_LEVELS)
  .describe(
    "How synced mail and meetings are disclosed: full (content), metadata (subject, " +
      "participants, time) or none (don't sync)",
  );

const resourceSchema = z.object({
  key: z.string(),
  url: z.string(),
  pattern: z.string(),
  title: z.string(),
  tsType: z.string(),
  bindingName: z.string(),
  hookTsType: z.string().optional(),
  /** What the sync service reads from it, if anything. */
  syncKind: z.enum(["mail", "calendar"]).nullable(),
});

export const connectionSchema = z.object({
  id: z.string(),
  vendor: z.string(),
  vendorTitle: z.string(),
  scope: z.enum(["personal", "org"]),
  ownerUserId: z.string(),
  ownerName: z.string().nullable(),
  title: z.string(),
  accountLabel: z.string().nullable(),
  sharingLevel: z.enum(SHARING_LEVELS),
  status: z.enum(["connecting", "active", "expired", "error", "disconnected"]),
  error: z.string().nullable(),
  resources: z.array(resourceSchema),
  sync: z.record(z.string(), z.unknown()),
  /**
   * Outbound actions waiting for approval on this connection. Its gatekeepers simulate them,
   * so for an org connection every user's reads already reflect them: the UI shows a badge.
   */
  pendingOutbound: z.number(),
  /** The caller may call its sessions (owner of a personal connection, anyone for org). */
  usable: z.boolean(),
  /** The caller may rename, re-share, resync or disconnect it. */
  manageable: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  connectedAt: z.string().nullable(),
  lastSyncAt: z.string().nullable(),
});
export type ConnectionView = z.infer<typeof connectionSchema>;

const connectStartSchema = z.object({ url: z.string(), nonce: z.string() }).nullable();

// --- Helpers -----------------------------------------------------------------------------------

type ConnectionRow = Selectable<CoreIntegrationConnectionTable>;

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function requireIntegrations(ctx: HandlerContext): IntegrationRuntime {
  if (!ctx.integrations) {
    throw new OperationError(
      "config",
      "The integration host is not available here (ros-runner is not bound)",
    );
  }
  return ctx.integrations;
}

export async function loadIntegrationConnection(
  db: Kysely<CoreDatabase>,
  id: string,
): Promise<ConnectionRow> {
  const row = await db
    .selectFrom("core_integration_connection")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw new NotFoundError("connection", id);
  return row;
}

function isAdmin(ctx: HandlerContext): boolean {
  return roleHasPermission(ctx.user.role, "integrations:manage");
}

/** Personal: only its owner's actors. Org: every user's. */
export function canUse(ctx: Pick<HandlerContext, "user">, row: ConnectionRow): boolean {
  return row.scope === "org" || row.owner_user_id === ctx.user.id;
}

function canManage(ctx: HandlerContext, row: ConnectionRow): boolean {
  if (ctx.actor !== "human") return false;
  if (row.owner_user_id === ctx.user.id) return true;
  return row.scope === "org" && isAdmin(ctx);
}

function assertManage(ctx: HandlerContext, row: ConnectionRow): void {
  if (!canManage(ctx, row)) {
    throw new ForbiddenError(
      row.scope === "org"
        ? "Only an admin or the connection's owner can change an org connection"
        : "Only its owner can change a personal connection",
      { connectionId: row.id },
    );
  }
}

/** For calls into a connection's sessions: active, and usable by the caller. */
export function assertUsable(ctx: Pick<HandlerContext, "user">, row: ConnectionRow): void {
  if (!canUse(ctx, row)) {
    throw new ForbiddenError("That personal connection belongs to another user", {
      connectionId: row.id,
    });
  }
  if (row.status !== "active") {
    throw new ValidationError(`The connection "${row.title}" is ${row.status}, not active`, {
      connectionId: row.id,
      status: row.status,
    });
  }
}

function resourcesOf(row: ConnectionRow): BoundResource[] {
  return parseJson<BoundResource[]>(row.resources, []);
}

async function toViews(ctx: HandlerContext, rows: ConnectionRow[]): Promise<ConnectionView[]> {
  const counts = await pendingOutboundCounts(
    ctx.pipeline.crm,
    rows.map((r) => r.id),
    ctx.now,
  );
  const owners = rows.length
    ? await ctx.db
        .selectFrom("core_user")
        .select(["id", "name"])
        .where("id", "in", [...new Set(rows.map((r) => r.owner_user_id))])
        .execute()
    : [];
  const names = new Map(owners.map((o) => [o.id, o.name]));
  return rows.map((row) => ({
    id: row.id,
    vendor: row.vendor,
    vendorTitle: catalogueEntry(row.vendor)?.title ?? row.vendor,
    scope: row.scope,
    ownerUserId: row.owner_user_id,
    ownerName: names.get(row.owner_user_id) ?? null,
    title: row.title,
    accountLabel: row.account_label,
    sharingLevel: row.sharing_level,
    status: row.status,
    error: row.error,
    resources: resourcesOf(row).map((r) => ({ ...r, syncKind: syncKindOf(row.vendor, r.url) })),
    sync: parseJson<Record<string, unknown>>(row.sync, {}),
    pendingOutbound: counts.get(row.id) ?? 0,
    usable: canUse(ctx, row) && row.status === "active",
    manageable: canManage(ctx, row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    connectedAt: row.connected_at,
    lastSyncAt: row.last_sync_at,
  }));
}

async function view(ctx: HandlerContext, id: string): Promise<ConnectionView> {
  const [v] = await toViews(ctx, [await loadIntegrationConnection(ctx.db, id)]);
  if (!v) throw new NotFoundError("connection", id);
  return v;
}

async function enabledVendor(db: Kysely<CoreDatabase>, vendor: string) {
  return db
    .selectFrom("core_integration_vendor")
    .selectAll()
    .where("vendor", "=", vendor)
    .executeTakeFirst();
}

/** Resolves a resource by key or binding name (case-insensitive) on a connection. */
export function findResource(row: ConnectionRow, resource: string): BoundResource {
  const all = resourcesOf(row);
  const found =
    all.find((r) => r.key === resource) ??
    all.find((r) => r.bindingName.toLowerCase() === resource.toLowerCase());
  if (!found) {
    throw new OperationError(
      "not_found",
      `No resource ${resource} on this connection. Bound: ${all.map((r) => `${r.bindingName} (${r.key})`).join(", ") || "none"}`,
      { object: "resource", id: resource },
    );
  }
  return found;
}

// --- Catalogue ---------------------------------------------------------------------------------

const catalogueItemSchema = z.object({
  vendor: z.string(),
  title: z.string(),
  description: z.string(),
  connect: z.enum(["oauth", "auto"]),
  scopes: z.array(z.enum(["personal", "org"])),
  singleton: z.boolean(),
  syncs: z.array(z.enum(["mail", "calendar"])),
  companion: z.string().nullable(),
  devOnly: z.boolean(),
  enabled: z.boolean(),
  mode: z.enum(["off", "optional", "on"]).nullable(),
  /** False when this deployment has no `GATEKEEPER_<NAME>` binding for it. */
  available: z.boolean(),
});

export const integrationCatalogue = defineOperation({
  name: "integration.catalogue",
  description:
    "The gatekeepers this CRM ships (Google, Microsoft, Slack, MCP, email, ZoomInfo, web " +
    "search, inbound webhooks, …): what each does, whether an admin enabled it for this " +
    "deployment, whether it is deployed, and whether it syncs mail or calendars. Read-only.",
  input: z.object({}),
  output: z.object({ items: z.array(catalogueItemSchema) }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(_input, ctx) {
    const rows = await ctx.db.selectFrom("core_integration_vendor").selectAll().execute();
    const settings = new Map(rows.map((r) => [r.vendor, r]));
    let available: Set<string> | null = null;
    if (ctx.integrations) {
      try {
        available = new Set(await ctx.integrations.availableVendors());
      } catch {
        available = null;
      }
    }
    const items = CATALOGUE.filter(
      (entry) => !entry.devOnly || available?.has(entry.vendor) || settings.get(entry.vendor),
    ).map((entry) => {
      const row = settings.get(entry.vendor);
      return {
        vendor: entry.vendor,
        title: entry.title,
        description: entry.description,
        connect: entry.connect,
        scopes: [...entry.scopes],
        singleton: entry.singleton === true,
        syncs: (["mail", "calendar"] as const).filter((k) => entry.sync?.[k]?.length),
        companion: entry.companion ?? null,
        devOnly: entry.devOnly === true,
        enabled: row?.enabled === 1,
        mode: row?.mode ?? (entry.singleton ? "off" : null),
        available: available ? available.has(entry.vendor) : true,
      };
    });
    return { items };
  },
});

export const integrationSetVendor = defineOperation({
  name: "integration.setVendor",
  description:
    "Enable or disable a gatekeeper for this deployment. For web search, `mode` is off, " +
    "optional (each user turns it on for their own actors) or on (one org connection for " +
    "everyone). Admins only, and only a human. Disabling stops new connections; existing ones " +
    "keep working until disconnected.",
  input: z.object({
    vendor: vendorName,
    enabled: z.boolean(),
    mode: z.enum(["off", "optional", "on"]).optional(),
  }),
  output: catalogueItemSchema.pick({ vendor: true, enabled: true, mode: true }),
  permission: "integrations:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const entry = catalogueEntry(input.vendor);
    if (!entry) throw new NotFoundError("gatekeeper", input.vendor);
    if (input.mode && !entry.singleton) {
      throw new ValidationError("Only auto-provisioned singletons (web search) have a mode");
    }
    const mode = entry.singleton ? (input.mode ?? (input.enabled ? "on" : "off")) : null;
    const enabled = entry.singleton ? mode !== "off" : input.enabled;
    const before = await enabledVendor(ctx.db, input.vendor);
    ctx.write(
      ctx.db
        .insertInto("core_integration_vendor")
        .values({
          vendor: input.vendor,
          enabled: enabled ? 1 : 0,
          mode,
          updated_at: ctx.now,
          updated_by: ctx.user.id,
        })
        .onConflict((oc) =>
          oc.column("vendor").doUpdateSet({
            enabled: enabled ? 1 : 0,
            mode,
            updated_at: ctx.now,
            updated_by: ctx.user.id,
          }),
        ),
    );
    ctx.recordChange({
      object: "settings",
      id: `integration:${input.vendor}`,
      action: before ? "update" : "create",
      before: before ? { enabled: before.enabled === 1, mode: before.mode } : null,
      after: { enabled, mode },
    });
    return { vendor: input.vendor, enabled, mode };
  },
});

// --- Connections -------------------------------------------------------------------------------

export const connectionList = defineOperation({
  name: "connection.list",
  description:
    "Connections to gatekeepers: your personal ones and the org's. Each has its owner, " +
    "sharing level, status (and error), bound resources with the session type and binding " +
    "name agents code against, sync state, and how many outbound actions wait for approval. " +
    "`usable` says whether your actors may call it. Admins also see others' personal " +
    "connections (metadata only). Read-only.",
  input: z.object({
    scope: z.enum(["usable", "mine", "org", "all"]).default("usable"),
    includeDisconnected: z.boolean().default(false),
  }),
  output: z.object({ items: z.array(connectionSchema) }),
  permission: "records:read",
  risk: "read",
  mcp: { curated: true, idempotent: true, title: "List connections" },
  async handler(input, ctx) {
    let query = ctx.db.selectFrom("core_integration_connection").selectAll();
    if (!input.includeDisconnected) query = query.where("status", "<>", "disconnected");
    if (input.scope === "mine") {
      query = query.where("owner_user_id", "=", ctx.user.id).where("scope", "=", "personal");
    } else if (input.scope === "org") {
      query = query.where("scope", "=", "org");
    } else if (input.scope === "usable" || !isAdmin(ctx) || ctx.actor !== "human") {
      query = query.where((eb) =>
        eb.or([eb("scope", "=", "org"), eb("owner_user_id", "=", ctx.user.id)]),
      );
    }
    const rows = await query.orderBy("created_at").limit(500).execute();
    return { items: await toViews(ctx, rows) };
  },
});

export const connectionGet = defineOperation({
  name: "connection.get",
  description: "One connection with its resources, sync state and status. Read-only.",
  input: z.object({ id: connectionId }),
  output: connectionSchema,
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const row = await loadIntegrationConnection(ctx.db, input.id);
    if (!canUse(ctx, row) && !(isAdmin(ctx) && ctx.actor === "human")) {
      throw new NotFoundError("connection", input.id);
    }
    return view(ctx, input.id);
  },
});

export const connectionCreate = defineOperation({
  name: "connection.create",
  description:
    "Start connecting a gatekeeper: a personal connection (yours) or an org connection " +
    "(admins). OAuth gatekeepers return a connect URL and a nonce: open the URL in a popup; " +
    "its final page hands a ticket to /connect/handoff, which calls connection.completeConnect. " +
    "Auto-provisioned gatekeepers (web search, email sending, webhooks) are active at once. " +
    "People only.",
  input: z.object({
    vendor: vendorName,
    scope: z.enum(["personal", "org"]),
    title: z.string().trim().min(1).max(200).optional(),
    sharingLevel: sharingLevel.default("metadata"),
  }),
  output: z.object({ connection: connectionSchema, connect: connectStartSchema }),
  permission: "records:write",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const integrations = requireIntegrations(ctx);
    const entry = catalogueEntry(input.vendor);
    if (!entry) throw new NotFoundError("gatekeeper", input.vendor);
    const setting = await enabledVendor(ctx.db, input.vendor);
    if (setting?.enabled !== 1) {
      throw new ValidationError(`${entry.title} is not enabled for this CRM. Ask an admin.`, {
        vendor: input.vendor,
      });
    }
    if (!entry.scopes.includes(input.scope)) {
      throw new ValidationError(`${entry.title} cannot be a ${input.scope} connection`);
    }
    if (entry.singleton) {
      const wanted = setting.mode === "on" ? "org" : "personal";
      if (input.scope !== wanted) {
        throw new ValidationError(
          `Web search is set to "${setting.mode}": use a ${wanted} connection`,
        );
      }
    }
    if (input.scope === "org" && !isAdmin(ctx)) {
      throw new ForbiddenError("Only admins can create org connections", {
        permission: "integrations:manage",
      });
    }
    const id = newId("connection");
    ctx.write(
      ctx.db.insertInto("core_integration_connection").values({
        id,
        vendor: input.vendor,
        scope: input.scope,
        owner_user_id: ctx.user.id,
        title: input.title ?? entry.title,
        sharing_level: input.sharingLevel,
        status: "connecting",
        created_at: ctx.now,
        updated_at: ctx.now,
      }),
    );
    ctx.recordChange({
      object: "connection",
      id,
      action: "create",
      after: { vendor: input.vendor, scope: input.scope, sharingLevel: input.sharingLevel },
    });
    const crm = ctx.pipeline.crm;
    return ctx.afterCommit(async () => {
      let connect: { url: string; nonce: string } | null = null;
      try {
        if (entry.connect === "auto") {
          const { accountLabel } = await integrations.provision({
            connectionId: id,
            vendor: input.vendor,
            userId: ctx.user.id,
          });
          await crm.batch([
            crm.query
              .updateTable("core_integration_connection")
              .set({
                status: "active",
                account_label: accountLabel,
                connected_at: ctx.now,
                updated_at: ctx.now,
              })
              .where("id", "=", id),
          ]);
        } else {
          connect = await integrations.startConnect({
            connectionId: id,
            vendor: input.vendor,
            userId: ctx.user.id,
          });
        }
      } catch (error) {
        await crm.batch([
          crm.query
            .updateTable("core_integration_connection")
            .set({ status: "error", error: String((error as Error)?.message ?? error) })
            .where("id", "=", id),
        ]);
        throw new OperationError(
          "integration_error",
          `Could not start connecting ${entry.title}: ${(error as Error)?.message ?? error}`,
        );
      }
      return { connection: await view(ctx, id), connect };
    });
  },
});

export const connectionCompleteConnect = defineOperation({
  name: "connection.completeConnect",
  description:
    "Finish a connect flow: redeem the ticket the gatekeeper's final page handed to " +
    "/connect/handoff, with the popup's nonce. Only the user who started the flow can redeem " +
    "it; otherwise the staged account is revoked. May return a next step (a companion " +
    "gatekeeper connected in the same flow). People only.",
  input: z.object({
    connectionId,
    ticket: z.string().min(8).max(2000),
    nonce: z.string().min(8).max(200),
  }),
  output: z.object({
    connection: connectionSchema,
    next: z.object({ url: z.string(), nonce: z.string(), vendor: z.string() }).nullable(),
  }),
  permission: "records:write",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  redact: ["ticket", "nonce"],
  async handler(input, ctx) {
    const integrations = requireIntegrations(ctx);
    const row = await loadIntegrationConnection(ctx.db, input.connectionId);
    if (row.owner_user_id !== ctx.user.id) {
      throw new ForbiddenError("Only the user who started this connect flow can finish it");
    }
    const redeemed = await integrations.redeem({
      connectionId: row.id,
      ticket: input.ticket,
      nonce: input.nonce,
      userId: ctx.user.id,
    });
    ctx.write(
      ctx.db
        .updateTable("core_integration_connection")
        .set({
          status: "active",
          error: null,
          account_label: redeemed.accountLabel ?? row.account_label,
          connected_at: row.connected_at ?? ctx.now,
          updated_at: ctx.now,
        })
        .where("id", "=", row.id),
    );
    ctx.recordChange({
      object: "connection",
      id: row.id,
      action: "update",
      before: { status: row.status },
      after: { status: "active", accountLabel: redeemed.accountLabel },
    });
    return ctx.afterCommit(async () => ({
      connection: await view(ctx, row.id),
      next: redeemed.next,
    }));
  },
});

export const connectionReconnect = defineOperation({
  name: "connection.reconnect",
  description:
    "Start a reconnect for a connection whose credentials expired (or to widen its grant). " +
    "Returns a connect URL and nonce, finished like a first connect. Owner only; people only.",
  input: z.object({ id: connectionId }),
  output: z.object({ connect: z.object({ url: z.string(), nonce: z.string() }) }),
  permission: "records:write",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const integrations = requireIntegrations(ctx);
    const row = await loadIntegrationConnection(ctx.db, input.id);
    if (row.owner_user_id !== ctx.user.id) {
      throw new ForbiddenError("Only the connection's owner can reconnect it");
    }
    return { connect: await integrations.reconnect({ connectionId: row.id, userId: ctx.user.id }) };
  },
});

export const connectionUpdate = defineOperation({
  name: "connection.update",
  description:
    "Rename a connection or change its sharing level (full / metadata / none for synced mail " +
    "and meetings). A new level applies to what syncs from now on. Owner (or an admin for org " +
    "connections); people only.",
  input: z.object({
    id: connectionId,
    title: z.string().trim().min(1).max(200).optional(),
    sharingLevel: sharingLevel.optional(),
  }),
  output: connectionSchema,
  permission: "records:write",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const row = await loadIntegrationConnection(ctx.db, input.id);
    assertManage(ctx, row);
    const after = {
      title: input.title ?? row.title,
      sharingLevel: input.sharingLevel ?? row.sharing_level,
    };
    ctx.write(
      ctx.db
        .updateTable("core_integration_connection")
        .set({ title: after.title, sharing_level: after.sharingLevel, updated_at: ctx.now })
        .where("id", "=", row.id),
    );
    ctx.recordChange({
      object: "connection",
      id: row.id,
      action: "update",
      before: { title: row.title, sharingLevel: row.sharing_level },
      after,
    });
    return ctx.afterCommit(() => view(ctx, row.id));
  },
});

export const connectionDisconnect = defineOperation({
  name: "connection.disconnect",
  description:
    "Disconnect: revoke the gatekeeper account, drop its resources, hooks and sync. Already " +
    "synced activities stay. Outbound actions still waiting on it will fail if approved. " +
    "Owner (or an admin for org connections); people only.",
  input: z.object({ id: connectionId }),
  output: connectionSchema,
  permission: "records:write",
  risk: "destructive",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const integrations = requireIntegrations(ctx);
    const row = await loadIntegrationConnection(ctx.db, input.id);
    if (row.owner_user_id !== ctx.user.id && !isAdmin(ctx)) {
      throw new ForbiddenError("Only the owner or an admin can disconnect a connection");
    }
    ctx.write(
      ctx.db
        .updateTable("core_integration_connection")
        .set({
          status: "disconnected",
          resources: "[]",
          sync: "{}",
          disconnected_at: ctx.now,
          updated_at: ctx.now,
        })
        .where("id", "=", row.id),
    );
    ctx.recordChange({
      object: "connection",
      id: row.id,
      action: "update",
      before: { status: row.status },
      after: { status: "disconnected" },
    });
    // Run-as (ADR 0170): automations bound to it pause, and the admins are told.
    const revoked = await revokeBindingsPlan(
      ctx.db,
      { connectionId: row.id },
      { reason: `${row.title} was disconnected`, by: ctx.user.id, now: ctx.now },
    );
    ctx.write(...revoked.statements);
    return ctx.afterCommit(async () => {
      try {
        await integrations.disconnect({ connectionId: row.id });
      } catch (error) {
        console.error("disconnect: the host could not revoke the account", error);
      }
      return view(ctx, row.id);
    });
  },
});

export const connectionBindResource = defineOperation({
  name: "connection.bindResource",
  description:
    "Grant a connection's agents access to one resource (a mailbox, calendar, Drive folder, " +
    "Slack channel, webhook endpoint, sender address …) by its URL, usually chosen in the " +
    "resource picker. The integration host creates the gatekeeper facet that serves it. " +
    "Owner (or an admin for org connections); people only.",
  input: z.object({ id: connectionId, url: z.string().min(3).max(2000) }),
  output: z.object({ connection: connectionSchema, resource: resourceSchema }),
  permission: "records:write",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const integrations = requireIntegrations(ctx);
    const row = await loadIntegrationConnection(ctx.db, input.id);
    assertManage(ctx, row);
    if (row.status !== "active") {
      throw new ValidationError(`The connection is ${row.status}, not active`);
    }
    const resource = await integrations.bindResource({ connectionId: row.id, url: input.url });
    const resources = [...resourcesOf(row).filter((r) => r.key !== resource.key), resource];
    ctx.write(
      ctx.db
        .updateTable("core_integration_connection")
        .set({ resources: JSON.stringify(resources), updated_at: ctx.now })
        .where("id", "=", row.id),
    );
    ctx.recordChange({
      object: "connection",
      id: row.id,
      action: "update",
      before: { resources: resourcesOf(row).map((r) => r.url) },
      after: { resources: resources.map((r) => r.url) },
    });
    return ctx.afterCommit(async () => ({
      connection: await view(ctx, row.id),
      resource: { ...resource, syncKind: syncKindOf(row.vendor, resource.url) },
    }));
  },
});

export const connectionUnbindResource = defineOperation({
  name: "connection.unbindResource",
  description:
    "Remove a resource from a connection: its facet, hooks and any sync from it stop. Owner " +
    "(or an admin for org connections); people only.",
  input: z.object({ id: connectionId, key: z.string().min(1).max(200) }),
  output: connectionSchema,
  permission: "records:write",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const integrations = requireIntegrations(ctx);
    const row = await loadIntegrationConnection(ctx.db, input.id);
    assertManage(ctx, row);
    const resource = findResource(row, input.key);
    const resources = resourcesOf(row).filter((r) => r.key !== resource.key);
    ctx.write(
      ctx.db
        .updateTable("core_integration_connection")
        .set({ resources: JSON.stringify(resources), updated_at: ctx.now })
        .where("id", "=", row.id),
    );
    ctx.recordChange({
      object: "connection",
      id: row.id,
      action: "update",
      before: { resources: resourcesOf(row).map((r) => r.url) },
      after: { resources: resources.map((r) => r.url) },
    });
    return ctx.afterCommit(async () => {
      await integrations.unbindResource({ connectionId: row.id, key: resource.key });
      return view(ctx, row.id);
    });
  },
});

export const connectionConfigure = defineOperation({
  name: "connection.configure",
  description:
    "Resource picker plumbing: call a method of the gatekeeper's resource configurator " +
    "capability (listing drives, labels, channels …) for a resource type. People only, from " +
    "Settings → Integrations.",
  input: z.object({
    id: connectionId,
    pattern: z.string().min(1).max(500),
    method: z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9]{0,60}$/)
      .describe("A configurator method"),
    args: z.array(z.unknown()).max(10).default([]),
  }),
  output: z.object({ value: z.unknown() }),
  permission: "records:read",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const integrations = requireIntegrations(ctx);
    const row = await loadIntegrationConnection(ctx.db, input.id);
    assertManage(ctx, row);
    const value = await integrations.configure({
      connectionId: row.id,
      pattern: input.pattern,
      method: input.method,
      args: input.args,
    });
    return { value: JSON.parse(JSON.stringify(value ?? null)) as unknown };
  },
});

export const connectionResourceTypes = defineOperation({
  name: "connection.resourceTypes",
  description:
    "The kinds of resource a connection's account can grant (a mailbox, calendars, Drive " +
    "folders, channels …), each with its URL pattern, for the resource picker. Read-only.",
  input: z.object({ id: connectionId }),
  output: z.object({
    items: z.array(
      z.object({
        urlPattern: z.string(),
        title: z.string(),
        description: z.string(),
        grantable: z.boolean(),
        vendor: z.string(),
        syncKind: z.enum(["mail", "calendar"]).nullable(),
      }),
    ),
  }),
  permission: "records:read",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const integrations = requireIntegrations(ctx);
    const row = await loadIntegrationConnection(ctx.db, input.id);
    assertManage(ctx, row);
    const items = await integrations.supportedResources({ connectionId: row.id });
    return {
      items: items.map((i) => ({
        ...i,
        syncKind: syncKindOf(row.vendor, i.urlPattern.replace(/:[^/]+.*$/, "")),
      })),
    };
  },
});

export const connectionSetSync = defineOperation({
  name: "connection.setSync",
  description:
    "Choose which bound mailbox and calendar sync onto CRM timelines, and how far back the " +
    "first sync reads (default 90 days, chunked). Sync follows the connection's sharing level; " +
    "'none' syncs nothing. Owner (or an admin for org connections); people only.",
  input: z.object({
    id: connectionId,
    mail: z.string().max(200).nullable().describe("Resource key of the mailbox, or null"),
    calendar: z.string().max(200).nullable().describe("Resource key of the calendar, or null"),
    backfillDays: z.number().int().min(0).max(365).default(90),
  }),
  output: connectionSchema,
  permission: "records:write",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const integrations = requireIntegrations(ctx);
    const row = await loadIntegrationConnection(ctx.db, input.id);
    assertManage(ctx, row);
    for (const [kind, key] of [
      ["mail", input.mail],
      ["calendar", input.calendar],
    ] as const) {
      if (key === null) continue;
      const resource = findResource(row, key);
      if (syncKindOf(row.vendor, resource.url) !== kind) {
        throw new ValidationError(`${resource.title} is not a ${kind} resource`, { key });
      }
    }
    const before = parseJson<Record<string, unknown>>(row.sync, {});
    const sync = {
      ...before,
      mail: input.mail,
      calendar: input.calendar,
      backfillDays: input.backfillDays,
    };
    ctx.write(
      ctx.db
        .updateTable("core_integration_connection")
        .set({ sync: JSON.stringify(sync), updated_at: ctx.now })
        .where("id", "=", row.id),
    );
    ctx.recordChange({
      object: "connection",
      id: row.id,
      action: "update",
      before: { mail: before.mail ?? null, calendar: before.calendar ?? null },
      after: { mail: input.mail, calendar: input.calendar, backfillDays: input.backfillDays },
    });
    return ctx.afterCommit(async () => {
      await integrations.setSync({
        connectionId: row.id,
        config: {
          mail: input.mail,
          calendar: input.calendar,
          backfillDays: input.backfillDays,
        },
      });
      return view(ctx, row.id);
    });
  },
});

export const connectionSyncNow = defineOperation({
  name: "connection.syncNow",
  description:
    "Run a sync pass on a connection now (catch-up, or the next backfill chunk). Owner (or an " +
    "admin for org connections); people only.",
  input: z.object({ id: connectionId }),
  output: z.object({ ok: z.literal(true) }),
  permission: "records:write",
  risk: "write",
  actors: ["human"],
  bookkeeping: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    const integrations = requireIntegrations(ctx);
    const row = await loadIntegrationConnection(ctx.db, input.id);
    assertManage(ctx, row);
    await integrations.syncNow({ connectionId: row.id });
    return { ok: true as const };
  },
});

// --- Calling gatekeepers -----------------------------------------------------------------------

export const integrationCall = defineOperation({
  name: "integration.call",
  description:
    "Call a method on a connected gatekeeper's session, e.g. Gmail `searchMessages('from:ada')` " +
    "or email sending `send({...})`. Find connections and resources with connection.list and " +
    "the session's TypeScript API with integration.types. Reads are recorded as observations. " +
    "Side effects (sending, posting) are NOT applied at once: each becomes an outbound action " +
    "that a person approves in the Approvals inbox (unless an admin let that kind auto-apply), " +
    "returned in `pending`; until then the gatekeeper simulates it. Cursor results return the " +
    "first page. For several steps or nested objects (a message's thread, replies), use the " +
    'Code Mode tool with `import { connect } from "codemode:<gatekeeper>"`.',
  input: z.object({
    connectionId,
    resource: z.string().min(1).max(200).describe("Resource key or binding name, e.g. GMAIL"),
    method: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,60}$/),
    args: z.array(z.unknown()).max(10).default([]),
  }),
  output: z.object({
    value: z.unknown(),
    pending: z.array(z.record(z.string(), z.unknown())),
    applied: z.array(z.record(z.string(), z.unknown())),
  }),
  permission: "records:read",
  // The call itself only dispatches; every side effect it causes is gated on its own as risk
  // `outbound` by the integration host's ApprovalQueue, and every read is an observation. So
  // the gate never queues the dispatch itself (which would dry-run a live session).
  risk: "read",
  mcp: { curated: true, title: "Call a connected gatekeeper" },
  async handler(input, ctx) {
    const integrations = requireIntegrations(ctx);
    const row = await loadIntegrationConnection(ctx.db, input.connectionId);
    assertUsable(ctx, row);
    const resource = findResource(row, input.resource);
    const result = await integrations.call({
      connectionId: row.id,
      resource: resource.key,
      method: input.method,
      args: input.args,
      caller: {
        actor: ctx.actor,
        userId: ctx.user.id,
        userName: ctx.user.name,
        role: ctx.user.role,
        origin: ctx.origin,
        grantedPermissions: ctx.grantedPermissions,
        reason: ctx.reason,
      },
    });
    return JSON.parse(JSON.stringify(result)) as {
      value: unknown;
      pending: Record<string, unknown>[];
      applied: Record<string, unknown>[];
    };
  },
});

export const integrationTypes = defineOperation({
  name: "integration.types",
  description:
    "The TypeScript declarations of a bound resource's session (what integration.call and " +
    "Code Mode's codemode:<gatekeeper> can call), from the gatekeeper itself. Read-only.",
  input: z.object({ connectionId, resource: z.string().min(1).max(200) }),
  output: z.object({ tsType: z.string(), bindingName: z.string(), types: z.string() }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const integrations = requireIntegrations(ctx);
    const row = await loadIntegrationConnection(ctx.db, input.connectionId);
    assertUsable(ctx, row);
    const resource = findResource(row, input.resource);
    const types = await integrations.types({ connectionId: row.id, resource: resource.key });
    return { tsType: resource.tsType, bindingName: resource.bindingName, types };
  },
});

// --- Outbound kinds ----------------------------------------------------------------------------

const kindSchema = z.object({
  tag: z.string(),
  vendor: z.string(),
  label: z.string(),
  autoApprovable: z.boolean(),
  autoApprove: z.boolean(),
  firstSeenAt: z.string(),
  updatedAt: z.string(),
});

export const outboundKinds = defineOperation({
  name: "outbound.kinds",
  description:
    "Outbound action kinds gatekeepers have submitted (e.g. email.send, slack.post) and " +
    "whether each may auto-apply under Balanced: only kinds the gatekeeper marks " +
    "autoApprovable can be, and only once an admin enabled it. Read-only.",
  input: z.object({}),
  output: z.object({ items: z.array(kindSchema) }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(_input, ctx) {
    const rows = await ctx.db
      .selectFrom("core_outbound_kind")
      .selectAll()
      .orderBy("vendor")
      .orderBy("tag")
      .execute();
    return {
      items: rows.map((r) => ({
        tag: r.tag,
        vendor: r.vendor,
        label: r.label,
        autoApprovable: r.auto_approvable === 1,
        autoApprove: r.auto_approve === 1,
        firstSeenAt: r.first_seen_at,
        updatedAt: r.updated_at,
      })),
    };
  },
});

export const outboundSetAutoApprove = defineOperation({
  name: "outbound.setAutoApprove",
  description:
    "Let an outbound action kind auto-apply under the Balanced preset (or require review " +
    "again). Only kinds the gatekeeper marks autoApprovable qualify. Loosens the approval " +
    "policy, so it is admin-only, human-only and audited. The deploy-time floor still applies.",
  input: z.object({ tag: z.string().min(1).max(100), enabled: z.boolean() }),
  output: kindSchema,
  permission: "policy:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const row = await ctx.db
      .selectFrom("core_outbound_kind")
      .selectAll()
      .where("tag", "=", input.tag)
      .executeTakeFirst();
    if (!row) throw new NotFoundError("outbound kind", input.tag);
    if (input.enabled && row.auto_approvable !== 1) {
      throw new ValidationError(
        `${row.label} (${row.tag}) is not marked auto-approvable by its gatekeeper, so it ` +
          "always needs review",
        { tag: row.tag },
      );
    }
    ctx.write(
      ctx.db
        .updateTable("core_outbound_kind")
        .set({ auto_approve: input.enabled ? 1 : 0, updated_at: ctx.now, updated_by: ctx.user.id })
        .where("tag", "=", row.tag),
    );
    ctx.recordChange({
      object: "settings",
      id: `outbound:${row.tag}`,
      action: "update",
      before: { autoApprove: row.auto_approve === 1 },
      after: { autoApprove: input.enabled },
    });
    return {
      tag: row.tag,
      vendor: row.vendor,
      label: row.label,
      autoApprovable: row.auto_approvable === 1,
      autoApprove: input.enabled,
      firstSeenAt: row.first_seen_at,
      updatedAt: ctx.now,
    };
  },
});

// --- Events ------------------------------------------------------------------------------------

const eventSchema = z.object({
  id: z.string(),
  source: z.enum(["webhook", "sync"]),
  connectionId: z.string().nullable(),
  type: z.string(),
  externalId: z.string().nullable(),
  payload: z.unknown(),
  occurredAt: z.string(),
  createdAt: z.string(),
  consumedAt: z.string().nullable(),
});

export const integrationEventList = defineOperation({
  name: "integrationEvent.list",
  description:
    "Inbound events, newest first: verified webhook deliveries (typed, e.g. github.push, " +
    "invoice.paid) and sync events (email.received, email.sent, meeting.created …). Stage 5 " +
    "automations will trigger on them. Filter by source and type; page with cursor. Read-only.",
  input: z.object({
    source: z.enum(["webhook", "sync"]).optional(),
    type: z.string().max(200).optional(),
    connectionId: connectionId.optional(),
    cursor: z.string().max(64).optional().describe("The last id of the previous page"),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({ items: z.array(eventSchema), nextCursor: z.string().nullable() }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    let query = ctx.db.selectFrom("core_integration_event").selectAll();
    if (input.source) query = query.where("source", "=", input.source);
    if (input.type) query = query.where("type", "=", input.type);
    if (input.connectionId) query = query.where("connection_id", "=", input.connectionId);
    if (input.cursor) query = query.where("id", "<", input.cursor);
    const rows = await query
      .orderBy("id", "desc")
      .limit(input.limit + 1)
      .execute();
    const page = rows.slice(0, input.limit);
    return {
      items: page.map((r) => ({
        id: r.id,
        source: r.source,
        connectionId: r.connection_id,
        type: r.type,
        externalId: r.external_id,
        payload: parseJson<unknown>(r.payload, null),
        occurredAt: r.occurred_at,
        createdAt: r.created_at,
        consumedAt: r.consumed_at,
      })),
      nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
    };
  },
});

export const integrationOperations = [
  integrationCatalogue,
  integrationSetVendor,
  connectionList,
  connectionGet,
  connectionCreate,
  connectionCompleteConnect,
  connectionReconnect,
  connectionUpdate,
  connectionDisconnect,
  connectionBindResource,
  connectionUnbindResource,
  connectionConfigure,
  connectionResourceTypes,
  connectionSetSync,
  connectionSyncNow,
  integrationCall,
  integrationTypes,
  outboundKinds,
  outboundSetAutoApprove,
  integrationEventList,
] as const;
