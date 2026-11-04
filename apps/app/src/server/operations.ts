// The UI adapter for the operations registry (ADR 0003): turns a signed-in Principal plus an
// operation name and input into a pipeline invocation. Framework-free so it is tested directly in
// workerd; `call-operation.ts` wraps it in a TanStack Start server function, and `#/lib/operations`
// is the typed client. The MCP (stage 2) and host-module (stage 3) adapters follow the same shape
// with a different actor and origin.
import type { Principal } from "@crm/auth";
import {
  type InvocationContext,
  invokeByName,
  parseFloor,
  resolveActingUser,
  type SerializedOperationError,
  toOperationError,
} from "@crm/core";
import { createCrmDb } from "@crm/db";
import { deleteGrantTokens } from "./mcp/handler.ts";

export interface OperationsEnv {
  DB: D1Database;
  /** Deploy-time approval floor (ADR 0011), JSON. Empty means none. */
  APPROVAL_FLOOR?: string;
  /** Days before a pending action expires (ADR 0022). Default 7. */
  APPROVAL_EXPIRY_DAYS?: string;
  /** The OAuth provider's store, so revoking a connected app also deletes its tokens. */
  OAUTH_KV?: KVNamespace;
}

/** Plain JSON: what operation outputs are once serialised. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** What crosses the wire: never a thrown error, so codes and details survive serialisation. */
export type OperationResult =
  | { ok: true; data: Json }
  | {
      ok: false;
      error: Omit<SerializedOperationError, "details"> & { details?: Json };
    };

/** Normalises a result to plain JSON (drops undefined, stringifies dates). */
export function toWire(
  result: { ok: true; data: unknown } | { ok: false; error: SerializedOperationError },
): OperationResult {
  return JSON.parse(JSON.stringify(result)) as OperationResult;
}

export interface OperationCall {
  name: string;
  input: unknown;
}

/** Validates the untyped payload a server function receives. */
export function parseOperationCall(payload: unknown): OperationCall {
  if (!payload || typeof payload !== "object") throw new Error("Expected { name, input }");
  const { name, input } = payload as Record<string, unknown>;
  if (typeof name !== "string" || name.length > 100) throw new Error("Expected an operation name");
  return { name, input: input ?? {} };
}

/** Runs one operation for a UI caller (actor `human`, origin `ui`). */
export async function runOperation(
  env: OperationsEnv,
  principal: Principal | null,
  call: OperationCall,
): Promise<OperationResult> {
  if (!principal) {
    return { ok: false, error: { code: "forbidden", message: "Sign in to continue" } };
  }
  try {
    const db = createCrmDb(env.DB);
    const ctx: InvocationContext = {
      actor: "human",
      user: await resolveActingUser(db, principal),
      origin: { surface: "ui" },
      db,
      floor: parseFloor(env.APPROVAL_FLOOR),
      approvalExpiryDays: Number.parseInt(env.APPROVAL_EXPIRY_DAYS ?? "", 10) || undefined,
    };
    const data = await invokeByName(call.name, call.input, ctx);
    if (call.name === "connectedApp.revoke" && env.OAUTH_KV) {
      // Core marks the connection revoked, which already stops it; also delete its tokens.
      const revoked = data as { grantId: string | null; userId: string };
      await deleteGrantTokens({ ...env, OAUTH_KV: env.OAUTH_KV }, revoked.grantId, revoked.userId);
    }
    return toWire({ ok: true, data });
  } catch (error) {
    const typed = toOperationError(error);
    if (typed.code === "internal" || typed.code === "config") {
      console.error(`operation ${call.name} failed`, error);
      // Internal details stay in the logs.
      return { ok: false, error: { code: typed.code, message: typed.message } };
    }
    return toWire({ ok: false, error: typed.toJSON() });
  }
}
