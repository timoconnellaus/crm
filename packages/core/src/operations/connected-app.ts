// connectedApp.* operations (ADR 0021, ADR 0032): the MCP clients a user has authorized over
// OAuth. A row is created at the consent step and is the authority on whether the connection
// may still be used: revoking it stops its access and refresh tokens on their next use (the app
// also deletes them from the OAuth provider's store).
import type { CoreDatabase } from "@crm/db";
import type { Kysely } from "kysely";
import { z } from "zod";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { defineOperation } from "../operation.ts";
import { grantableScopes, MCP_SCOPES, roleHasPermission } from "../principals.ts";

const connectedAppId = z.string().startsWith("cap_").max(64).describe("Connected app id (cap_…)");

export const connectedAppSchema = z.object({
  id: z.string(),
  userId: z.string(),
  userName: z.string().nullable(),
  userEmail: z.string().nullable(),
  clientId: z.string(),
  clientName: z.string(),
  clientUri: z.string().nullable(),
  redirectHost: z.string().nullable(),
  scopes: z.array(z.string()),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  revokedBy: z.string().nullable(),
  /** revoked (by a person) or replaced (authorized again). */
  revokeReason: z.string().nullable(),
  active: z.boolean(),
});
export type ConnectedApp = z.infer<typeof connectedAppSchema>;

function appQuery(db: Kysely<CoreDatabase>) {
  return db
    .selectFrom("core_connected_app as a")
    .leftJoin("core_user as u", "u.id", "a.user_id")
    .select([
      "a.id",
      "a.user_id",
      "u.name as user_name",
      "u.email as user_email",
      "a.client_id",
      "a.client_name",
      "a.client_uri",
      "a.redirect_host",
      "a.scopes",
      "a.grant_id",
      "a.created_at",
      "a.last_used_at",
      "a.revoked_at",
      "a.revoked_by",
      "a.revoke_reason",
    ]);
}

type AppRow = Awaited<ReturnType<ReturnType<typeof appQuery>["execute"]>>[number];

function toApp(row: AppRow): ConnectedApp {
  let scopes: string[] = [];
  try {
    scopes = JSON.parse(row.scopes) as string[];
  } catch {}
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    userEmail: row.user_email,
    clientId: row.client_id,
    clientName: row.client_name,
    clientUri: row.client_uri,
    redirectHost: row.redirect_host,
    scopes,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
    revokeReason: row.revoke_reason,
    active: row.revoked_at === null,
  };
}

const listInput = z.object({
  includeRevoked: z.boolean().default(false).describe("Also list revoked and replaced ones"),
});

export const connectedAppList = defineOperation({
  name: "connectedApp.list",
  description:
    "Your connected apps: the MCP clients you authorized " +
    "to use the CRM for you, with their scopes, when they were connected and last used. " +
    "Read-only.",
  input: listInput,
  output: z.object({ items: z.array(connectedAppSchema) }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    let q = appQuery(ctx.db).where("a.user_id", "=", ctx.user.id);
    if (!input.includeRevoked) q = q.where("a.revoked_at", "is", null);
    const rows = await q.orderBy("a.created_at", "desc").execute();
    return { items: rows.map(toApp) };
  },
});

export const connectedAppListAll = defineOperation({
  name: "connectedApp.listAll",
  description:
    "Every user's connected apps, for admins: who authorized which MCP client, with what " +
    "scopes, and when it was last used. Read-only.",
  input: listInput,
  output: z.object({ items: z.array(connectedAppSchema) }),
  permission: "users:manage",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    let q = appQuery(ctx.db);
    if (!input.includeRevoked) q = q.where("a.revoked_at", "is", null);
    const rows = await q.orderBy("a.created_at", "desc").execute();
    return { items: rows.map(toApp) };
  },
});

export const connectedAppRevoke = defineOperation({
  name: "connectedApp.revoke",
  description:
    "Disconnect an MCP client: its access and refresh tokens stop working immediately and it " +
    "must be authorized again. Users revoke their own apps; admins can revoke anyone's. People " +
    "only.",
  input: z.object({ id: connectedAppId }),
  output: connectedAppSchema.extend({ grantId: z.string().nullable() }),
  permission: "records:read",
  risk: "write",
  actors: ["human"],
  bookkeeping: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    const row = await appQuery(ctx.db).where("a.id", "=", input.id).executeTakeFirst();
    if (!row) throw new NotFoundError("connected app", input.id);
    if (row.user_id !== ctx.user.id && !roleHasPermission(ctx.user.role, "users:manage")) {
      throw new ForbiddenError("Only admins can revoke another user's connected apps");
    }
    if (row.revoked_at) {
      throw new ConflictError("That app is already disconnected", { revokedAt: row.revoked_at });
    }
    ctx.write(
      ctx.db
        .updateTable("core_connected_app")
        .set({ revoked_at: ctx.now, revoked_by: ctx.user.id, revoke_reason: "revoked" })
        .where("id", "=", input.id)
        .where("revoked_at", "is", null),
    );
    ctx.recordChange({
      object: "connected_app",
      id: input.id,
      action: "update",
      diff: { revokedAt: { before: null, after: ctx.now } },
    });
    return {
      ...toApp({ ...row, revoked_at: ctx.now, revoked_by: ctx.user.id, revoke_reason: "revoked" }),
      grantId: row.grant_id,
    };
  },
});

export const connectedAppRegister = defineOperation({
  name: "connectedApp.register",
  description:
    "Record that the signed-in user authorized an MCP client with the given scopes (the OAuth " +
    "consent step). Scopes must be ones the user's role may grant: admin only for admins. " +
    "Earlier connections of the same client for this user are marked replaced. Called by the " +
    "consent page, never by agents.",
  input: z.object({
    clientId: z.string().min(1).max(500),
    clientName: z.string().trim().min(1).max(200),
    clientUri: z.string().max(500).nullish(),
    redirectHost: z.string().max(500).nullish(),
    scopes: z.array(z.enum(MCP_SCOPES)).min(1).max(3),
  }),
  output: z.object({ id: z.string(), scopes: z.array(z.string()) }),
  permission: "records:read",
  risk: "write",
  actors: ["human"],
  bookkeeping: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    const allowed = grantableScopes(ctx.user.role);
    const refused = input.scopes.filter((s) => !allowed.includes(s));
    if (refused.length) {
      throw new ForbiddenError(`Your role (${ctx.user.role}) cannot grant ${refused.join(", ")}`, {
        refused,
      });
    }
    if (!input.scopes.includes("read")) {
      throw new ValidationError("Connected apps always get the read scope", { field: "scopes" });
    }
    // Writing needs the write scope; admin implies everything below it.
    const scopes = [...new Set(input.scopes)].sort(
      (a, b) => MCP_SCOPES.indexOf(a) - MCP_SCOPES.indexOf(b),
    );
    ctx.write(
      ctx.db
        .updateTable("core_connected_app")
        .set({ revoked_at: ctx.now, revoked_by: ctx.user.id, revoke_reason: "replaced" })
        .where("user_id", "=", ctx.user.id)
        .where("client_id", "=", input.clientId)
        .where("revoked_at", "is", null),
    );
    const id = newId("connectedApp");
    ctx.write(
      ctx.db.insertInto("core_connected_app").values({
        id,
        user_id: ctx.user.id,
        client_id: input.clientId,
        client_name: input.clientName,
        client_uri: input.clientUri ?? null,
        redirect_host: input.redirectHost ?? null,
        scopes: JSON.stringify(scopes),
        created_at: ctx.now,
      }),
    );
    ctx.recordChange({
      object: "connected_app",
      id,
      action: "create",
      after: { clientId: input.clientId, clientName: input.clientName, scopes },
    });
    return { id, scopes };
  },
});

export const connectedAppOperations = [
  connectedAppList,
  connectedAppListAll,
  connectedAppRevoke,
  connectedAppRegister,
] as const;

// --- Infrastructure (not operations) -------------------------------------------------------------
// Per-request bookkeeping for /mcp: checking a connection is live, noting when it was last used,
// binding the OAuth grant id, and rate-limit counters. These run on every MCP request, change no
// records and would flood the audit log as operations, so they are plain helpers.

export interface ActiveConnection {
  id: string;
  userId: string;
  clientId: string;
  clientName: string;
  scopes: string[];
  grantId: string | null;
  revokedAt: string | null;
}

export async function loadConnection(
  db: Kysely<CoreDatabase>,
  id: string,
): Promise<ActiveConnection | null> {
  const row = await db
    .selectFrom("core_connected_app")
    .select(["id", "user_id", "client_id", "client_name", "scopes", "grant_id", "revoked_at"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) return null;
  let scopes: string[] = [];
  try {
    scopes = JSON.parse(row.scopes) as string[];
  } catch {}
  return {
    id: row.id,
    userId: row.user_id,
    clientId: row.client_id,
    clientName: row.client_name,
    scopes,
    grantId: row.grant_id,
    revokedAt: row.revoked_at,
  };
}

/** Binds the OAuth provider's grant id to the connection (at the code exchange). */
export async function bindConnectionGrant(
  db: Kysely<CoreDatabase>,
  id: string,
  grantId: string,
): Promise<void> {
  await db
    .updateTable("core_connected_app")
    .set({ grant_id: grantId })
    .where("id", "=", id)
    .where("grant_id", "is", null)
    .execute();
}

/** Notes a use, at most once a minute per connection to keep writes down. */
export async function touchConnection(
  db: Kysely<CoreDatabase>,
  id: string,
  now: string,
): Promise<void> {
  const cutoff = new Date(Date.parse(now) - 60_000).toISOString();
  await db
    .updateTable("core_connected_app")
    .set({ last_used_at: now })
    .where("id", "=", id)
    .where((eb) => eb.or([eb("last_used_at", "is", null), eb("last_used_at", "<", cutoff)]))
    .execute();
}
