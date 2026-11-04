// Who is calling, how dangerous the call is, and what a role may do (ADR 0003, 0011, 0015).
import { z } from "zod";

/** How dangerous an operation is. The gate decides per actor × risk class. */
export const RISK_CLASSES = [
  "read",
  "write",
  "bulk-write",
  "destructive",
  "schema",
  "extension",
  "outbound",
] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

/** Who initiated an operation. */
/** `extension`: extension code calling operations through `codemode:crm` (ADR 0025). */
export const ACTORS = ["human", "assistant", "mcp", "automation", "extension"] as const;
export type Actor = (typeof ACTORS)[number];

/** Where a call came from, recorded in the audit log. */
export const originSchema = z.object({
  surface: z.enum(["ui", "mcp", "automation", "system", "extension"]),
  /** The MCP client id (OAuth client_id). */
  clientId: z.string().optional(),
  /** The MCP client's display name, as registered (self-asserted). */
  clientName: z.string().optional(),
  /**
   * The MCP session: the connected app (cap_…) the token belongs to (ADR 0032). Pending actions
   * group by it, and only it sees their simulated state.
   */
  sessionId: z.string().optional(),
  /** The automation id (later stages). */
  automationId: z.string().optional(),
  /** The extension whose code made the call (actor `extension`). */
  extensionId: z.string().optional(),
});
export type Origin = z.infer<typeof originSchema>;

export const ROLES = ["admin", "member", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/**
 * What an operation requires. Roles grant permissions (below); operations name one.
 * - `records:read`  read any record, list, search, view own saved views
 * - `records:write` create, update, soft-delete and restore records; manage own saved views
 * - `records:erase` hard-delete (GDPR erase)
 * - `audit:read`    the admin Audit page
 * - `users:manage`  change users' roles
 * - `policy:manage` change the approval policy (also human-only, see `actors`)
 * - `extensions:manage` install, check, disable, enable and roll back extensions (stage 3)
 * - `integrations:manage` enable gatekeepers, create and manage org connections (stage 6)
 * - `settings:manage` org settings such as the base currency (stage 4b)
 */
export const PERMISSIONS = [
  "records:read",
  "records:write",
  "records:erase",
  "audit:read",
  "users:manage",
  "policy:manage",
  "extensions:manage",
  "integrations:manage",
  "settings:manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  viewer: ["records:read"],
  member: ["records:read", "records:write"],
  admin: PERMISSIONS,
};

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * OAuth scopes an MCP client can be granted (ADR 0021). Each scope implies the ones before it.
 * A token's effective permissions are its user's role ∩ its scopes (`effectivePermissions`).
 * Policy changes stay human-only whatever the scope: `policy.update` is `actors: ["human"]`.
 */
export const MCP_SCOPES = ["read", "write", "admin"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

export const SCOPE_PERMISSIONS: Record<McpScope, readonly Permission[]> = {
  read: ["records:read"],
  write: ["records:read", "records:write"],
  admin: PERMISSIONS,
};

/** Scopes a role may be granted: `admin` only for admins. */
export function grantableScopes(role: Role): McpScope[] {
  return role === "admin" ? [...MCP_SCOPES] : ["read", "write"];
}

/** The permissions granted scopes allow, before intersecting with the role. */
export function scopePermissions(scopes: readonly string[]): Permission[] {
  const out = new Set<Permission>();
  for (const scope of scopes) {
    if ((MCP_SCOPES as readonly string[]).includes(scope)) {
      for (const p of SCOPE_PERMISSIONS[scope as McpScope]) out.add(p);
    }
  }
  return PERMISSIONS.filter((p) => out.has(p));
}

/** Role ∩ scopes. */
export function effectivePermissions(role: Role, scopes: readonly string[]): Permission[] {
  return scopePermissions(scopes).filter((p) => roleHasPermission(role, p));
}

/** The CRM user an invocation acts for: the Principal resolved to a `core_user` row. */
export interface ActingUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}
