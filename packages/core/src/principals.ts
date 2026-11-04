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
export const ACTORS = ["human", "assistant", "mcp", "automation"] as const;
export type Actor = (typeof ACTORS)[number];

/** Where a call came from, recorded in the audit log. */
export const originSchema = z.object({
  surface: z.enum(["ui", "mcp", "automation", "system"]),
  /** The MCP client id (stage 2). */
  clientId: z.string().optional(),
  /** The automation id (later stages). */
  automationId: z.string().optional(),
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
 */
export const PERMISSIONS = [
  "records:read",
  "records:write",
  "records:erase",
  "audit:read",
  "users:manage",
  "policy:manage",
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

/** The CRM user an invocation acts for: the Principal resolved to a `core_user` row. */
export interface ActingUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}
