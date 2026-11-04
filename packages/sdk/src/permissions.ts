// Declared permissions (ADR 0025): what an extension may call through `codemode:crm`. The host
// enforces this in the invocation pipeline; the testing harness uses the same rules.
import type { PermissionsManifest } from "./manifest.ts";
import { FORBIDDEN_OPERATION_PREFIXES } from "./manifest.ts";

export interface GrantRequest {
  /** Operation name, e.g. `organisation.get`, `record.create`. */
  operation: string;
  /** The operation's risk class. */
  risk: string;
  /** The object the call reads or writes, when the operation is about one (else null). */
  object: string | null;
}

export type GrantDecision = { ok: true } | { ok: false; reason: string };

/** Decides whether extension `id` with `permissions` may make `request`. */
export function checkGrant(
  id: string,
  permissions: PermissionsManifest,
  request: GrantRequest,
): GrantDecision {
  const { operation, risk, object } = request;
  if (FORBIDDEN_OPERATION_PREFIXES.some((prefix) => operation.startsWith(prefix))) {
    return { ok: false, reason: `Extensions cannot call ${operation}` };
  }
  if (operation.startsWith(`x.${id}.`)) {
    return { ok: false, reason: "An extension cannot call its own tools through codemode:crm" };
  }
  if (permissions.operations.includes(operation)) return { ok: true };
  if (operation.startsWith("x.")) {
    return { ok: false, reason: `${operation} is not in permissions.operations` };
  }
  if (!object) {
    return {
      ok: false,
      reason: `${operation} is not in permissions.operations of extension ${id}`,
    };
  }
  if (object.startsWith(`${id}.`)) return { ok: true };
  if (risk === "read") {
    if (permissions.read.includes(object) || permissions.write.includes(object))
      return { ok: true };
    return {
      ok: false,
      reason: `Extension ${id} may not read ${object} (add it to permissions.read)`,
    };
  }
  if (risk === "write" || risk === "bulk-write") {
    if (permissions.write.includes(object)) return { ok: true };
    return {
      ok: false,
      reason: `Extension ${id} may not write ${object} (add it to permissions.write)`,
    };
  }
  return {
    ok: false,
    reason: `${operation} is ${risk}; list it in permissions.operations to allow it`,
  };
}
