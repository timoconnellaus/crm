// crm-app's front door for MCP (ADR 0021, ADR 0032). `workers-oauth-provider` serves OAuth 2.1
// (metadata, dynamic client registration, token, revocation) and checks Bearer tokens on /mcp;
// /oauth/consent is our authorization page; everything else goes to TanStack Start.
//
// /mcp uses the Agents SDK's stateless Streamable HTTP handler with an MCP SDK v2 server built
// per request. The protocol has no sessions, so the MCP session is the connected app: one
// row in core_connected_app per authorization, whose id is in the token's props.
import {
  getOAuthApi,
  OAuthError,
  type OAuthHelpers,
  OAuthProvider,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import type { IdentityEnv } from "@crm/auth";
import {
  type ActingUser,
  bindConnectionGrant,
  consumeRateLimit,
  loadConnection,
  parseFloor,
  RateLimitedError,
  ROLES,
  type Role,
  scopePermissions,
  touchConnection,
} from "@crm/core";
import { createCrmDb } from "@crm/db";
import { createMcpHandler } from "agents/mcp/server";
import type { OperationsEnv } from "../operations.ts";
import { CONSENT_PATH, handleConsent, type McpProps } from "./consent.ts";
import { createCrmMcpServer, type McpCaller } from "./tools.ts";

export const MCP_PATH = "/mcp";

export interface McpEnv extends IdentityEnv, OperationsEnv {
  OAUTH_KV: KVNamespace;
  APPROVAL_EXPIRY_DAYS?: string;
  MCP_RATE_LIMIT_REQUESTS?: string;
  MCP_RATE_LIMIT_WRITES?: string;
  MCP_ACCESS_TOKEN_TTL?: string;
  /** The public /mcp URL tokens are bound to. Default: this request's origin + /mcp. */
  MCP_RESOURCE?: string;
}

const REFRESH_TOKEN_TTL = 30 * 24 * 3600;

function int(value: string | undefined, fallback: number, min = 1): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

export function mcpLimits(env: McpEnv) {
  return {
    requestsPerMinute: int(env.MCP_RATE_LIMIT_REQUESTS, 120),
    writesPerMinute: int(env.MCP_RATE_LIMIT_WRITES, 30),
  };
}

function bearerError(status: number, error: string, description: string, headers?: HeadersInit) {
  const h = new Headers(headers);
  h.set("www-authenticate", `Bearer error="${error}", error_description="${description}"`);
  return Response.json({ error, error_description: description }, { status, headers: h });
}

/** JSON-RPC error body, so MCP clients show the message. */
function rpcError(status: number, message: string, headers?: HeadersInit): Response {
  return Response.json(
    { jsonrpc: "2.0", id: null, error: { code: -32000, message } },
    { status, headers },
  );
}

const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";

/** /mcp, after the provider has verified the Bearer token. */
export async function serveMcp(
  request: Request,
  env: McpEnv,
  ctx: ExecutionContext & { props?: unknown },
  clock: () => Date = () => new Date(),
): Promise<Response> {
  const props = (ctx.props ?? {}) as Partial<McpProps>;
  if (!props.connectionId) return bearerError(401, "invalid_token", "Token has no connection");
  const db = createCrmDb(env.DB);
  const connection = await loadConnection(db.query, props.connectionId);
  if (!connection || connection.revokedAt) {
    return bearerError(401, "invalid_token", "This app was disconnected. Connect it again.");
  }
  const row = await db.query
    .selectFrom("core_user")
    .select(["id", "email", "name", "role"])
    .where("id", "=", connection.userId)
    .executeTakeFirst();
  if (!row) return bearerError(401, "invalid_token", "The user no longer exists");
  const user: ActingUser = {
    id: row.id,
    email: row.email,
    name: row.name,
    role: (ROLES as readonly string[]).includes(row.role) ? (row.role as Role) : "viewer",
  };

  const now = clock().toISOString();
  const limits = mcpLimits(env);
  const requests = await consumeRateLimit(
    db.query,
    `${connection.id}:requests`,
    limits.requestsPerMinute,
    now,
  );
  if (!requests.ok) {
    return rpcError(
      429,
      `Rate limit: this connection may make ${limits.requestsPerMinute} requests per minute. Retry in ${requests.retryAfterSeconds}s.`,
      { "retry-after": String(requests.retryAfterSeconds) },
    );
  }
  ctx.waitUntil(touchConnection(db.query, connection.id, now).catch(() => {}));

  const caller: McpCaller = {
    context: {
      actor: "mcp",
      user,
      origin: {
        surface: "mcp",
        clientId: connection.clientId,
        clientName: connection.clientName,
        sessionId: connection.id,
      },
      db,
      floor: parseFloor(env.APPROVAL_FLOOR),
      grantedPermissions: scopePermissions(connection.scopes),
      approvalExpiryDays: int(env.APPROVAL_EXPIRY_DAYS, 7),
    },
    async consumeWrite() {
      const writes = await consumeRateLimit(
        db.query,
        `${connection.id}:writes`,
        limits.writesPerMinute,
        clock().toISOString(),
      );
      if (!writes.ok) {
        throw new RateLimitedError(
          `Rate limit: this connection may make ${limits.writesPerMinute} changes per minute. Retry in ${writes.retryAfterSeconds}s.`,
          { retryAfterSeconds: writes.retryAfterSeconds },
        );
      }
    },
  };
  const handler = createMcpHandler(() => createCrmMcpServer(caller, APP_VERSION), {
    route: MCP_PATH,
  });
  return handler(request, env, ctx);
}

interface Fallback {
  fetch(request: Request, env: McpEnv, ctx: ExecutionContext): Response | Promise<Response>;
}

export function oauthOptions(
  origin: string,
  env: McpEnv,
  fallback: Fallback,
): OAuthProviderOptions<McpEnv> {
  return {
    apiRoute: MCP_PATH,
    apiHandler: {
      fetch: (request, env, ctx) => serveMcp(request, env as McpEnv, ctx),
    },
    defaultHandler: {
      fetch: (request, env, ctx) => {
        const e = env as McpEnv & { OAUTH_PROVIDER: OAuthHelpers };
        if (new URL(request.url).pathname === CONSENT_PATH) {
          return handleConsent(request, e, e.OAUTH_PROVIDER);
        }
        return fallback.fetch(request, e, ctx);
      },
    },
    authorizeEndpoint: CONSENT_PATH,
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: ["read", "write", "admin"],
    accessTokenTTL: int(env.MCP_ACCESS_TOKEN_TTL, 3600, 60),
    refreshTokenTTL: REFRESH_TOKEN_TTL,
    resourceMetadata: {
      resource: env.MCP_RESOURCE || `${origin}${MCP_PATH}`,
      resource_name: "CRM",
    },
    // Code exchange binds the provider's grant to the connected app; every refresh checks the
    // connection is still live, so revoking it also kills its refresh token.
    tokenExchangeCallback: async (options) => {
      const props = (options.props ?? {}) as Partial<McpProps>;
      if (!props.connectionId) return;
      const db = createCrmDb(options.env.DB);
      const connection = await loadConnection(db.query, props.connectionId);
      if (!connection || connection.revokedAt) {
        throw new OAuthError("invalid_grant", { description: "This app was disconnected" });
      }
      if (!connection.grantId) await bindConnectionGrant(db.query, connection.id, options.grantId);
    },
  };
}

/** The OAuth helpers outside a request the provider routed (e.g. revoking a grant from the UI). */
export function oauthApi(env: McpEnv, origin = "https://localhost"): OAuthHelpers {
  return getOAuthApi(oauthOptions(origin, env, { fetch: () => new Response(null) }), env);
}

/** Deletes a revoked connection's tokens from the provider's store (best effort). */
export async function deleteGrantTokens(
  env: McpEnv,
  grantId: string | null,
  userId: string,
): Promise<void> {
  if (!grantId || !env.OAUTH_KV) return;
  try {
    await oauthApi(env).revokeGrant(grantId, userId);
  } catch (error) {
    console.warn("could not revoke OAuth grant", grantId, error);
  }
}

/** Wraps the app's fetch handler with OAuth and /mcp. One provider per origin, per isolate. */
export function createAppHandler(fallback: Fallback) {
  const providers = new Map<string, OAuthProvider<McpEnv>>();
  return {
    fetch(request: Request, env: McpEnv, ctx: ExecutionContext): Promise<Response> {
      const origin = new URL(request.url).origin;
      let provider = providers.get(origin);
      if (!provider) {
        provider = new OAuthProvider<McpEnv>(oauthOptions(origin, env, fallback));
        providers.set(origin, provider);
      }
      return provider.fetch(request, env, ctx);
    },
  };
}
