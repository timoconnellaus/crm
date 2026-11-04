// The UI adapter for the operations registry (ADR 0003): turns a signed-in Principal plus an
// operation name and input into a pipeline invocation. Framework-free so it is tested directly in
// workerd; `call-operation.ts` wraps it in a TanStack Start server function, and `#/lib/operations`
// is the typed client. The MCP (stage 2) and host-module (stage 3) adapters follow the same shape
// with a different actor and origin.
import type { Principal } from "@crm/auth";
import {
  type ExtensionHost,
  type InvocationContext,
  invokeByName,
  parseFloor,
  resolveActingUser,
  type SerializedOperationError,
  toOperationError,
} from "@crm/core";
import { createCrmDb } from "@crm/db";
import { runner } from "./runner.ts";

export interface OperationsEnv {
  DB: D1Database;
  /** Deploy-time approval floor (ADR 0011), JSON. Empty means none. */
  APPROVAL_FLOOR?: string;
  /** crm-runner: the extension host (ADR 0025). */
  RUNNER?: Fetcher;
}

/**
 * The extension runtime as seen from crm-app: crm-runner's RPC over the RUNNER service binding,
 * which forwards to the extension workspace Durable Object.
 */
export function extensionHostFor(env: OperationsEnv): ExtensionHost | undefined {
  return env.RUNNER ? (runner({ RUNNER: env.RUNNER }) as unknown as ExtensionHost) : undefined;
}

let shippedInstall: Promise<void> | null = null;

/**
 * Installs the shipped extensions bundled with this release once per isolate, through
 * `extension.install` in crm-runner (ADR 0025). A failure is logged and retried on a later call;
 * operations still run meanwhile.
 */
export function ensureShippedExtensions(env: OperationsEnv): Promise<void> {
  if (!env.RUNNER) return Promise.resolve();
  shippedInstall ??= runner({ RUNNER: env.RUNNER })
    .installShipped()
    .then((results) => {
      const failed = results.filter((r) => r.outcome === "failed");
      if (failed.length) console.error("shipped extensions failed to install", failed);
    })
    .catch((error: unknown) => {
      console.error("could not install shipped extensions", error);
      shippedInstall = null;
    });
  return shippedInstall;
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
    await ensureShippedExtensions(env);
    const db = createCrmDb(env.DB);
    const extensionHost = extensionHostFor(env);
    const ctx: InvocationContext = {
      actor: "human",
      user: await resolveActingUser(db, principal),
      origin: { surface: "ui" },
      db,
      floor: parseFloor(env.APPROVAL_FLOOR),
      ...(extensionHost ? { extensionHost } : {}),
    };
    return toWire({ ok: true, data: await invokeByName(call.name, call.input, ctx) });
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
