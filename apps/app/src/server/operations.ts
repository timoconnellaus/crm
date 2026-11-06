// The UI adapter for the operations registry (ADR 0003): turns a signed-in Principal plus an
// operation name and input into a pipeline invocation. Framework-free so it is tested directly in
// workerd; `call-operation.ts` wraps it in a TanStack Start server function, and `#/lib/operations`
// is the typed client. The MCP (stage 2) and host-module (stage 3) adapters follow the same shape
// with a different actor and origin.
import type { Principal } from "@relationship-os/auth";
import {
  type AssistantThreadStore,
  type AutomationHost,
  type EventSink,
  type ExtensionHost,
  errorForLog,
  type InvocationContext,
  invokeByName,
  parseFloor,
  queueEventSink,
  type RateLimitBinding,
  resolveActingUser,
  type SerializedOperationError,
  toOperationError,
  withCodeModeRateLimit,
} from "@relationship-os/core";
import { createCrmDb } from "@relationship-os/db";
import { getAgentByName } from "agents";
import { type AiAppEnv, aiContextFor } from "./ai.ts";
import { type AssistantAgent, threadName } from "./assistant/agent.ts";
import { blobStoreFor, integrationRuntimeFor } from "./integrations.ts";
import { deleteGrantTokens } from "./mcp/handler.ts";
import { runner } from "./runner.ts";
import { updaterRuntimeFor } from "./updater.ts";

export interface OperationsEnv extends AiAppEnv {
  DB: D1Database;
  /** Deploy-time approval floor (ADR 0011), JSON. Empty means none. */
  APPROVAL_FLOOR?: string;
  /** Days before a pending action expires (ADR 0022). Default 7. */
  APPROVAL_EXPIRY_DAYS?: string;
  /** The OAuth provider's store, so revoking a connected app also deletes its tokens. */
  OAUTH_KV?: KVNamespace;
  /** ros-runner: the extension host (ADR 0025). */
  RUNNER?: Fetcher;
  /** The automation events queue (ADR 0130): committed changes start automations in ros-runner. */
  AUTOMATION_EVENTS?: Queue;
  /** Code Mode runs per user (Workers Rate Limiting, ADR 0043). */
  CODE_MODE_RATE_LIMIT?: RateLimitBinding;
  /** Synced email bodies (R2, ADR 0112). */
  BLOBS?: R2Bucket;
  /** Release (stage 8): the installed version, release repository and account (ADR 0164). */
  ROS_RELEASE_VERSION?: string;
  ROS_RELEASE_REPO?: string;
  ROS_ACCOUNT_ID?: string;
  /** Optional scoped token for in-app updates (a secret). */
  ROS_UPDATE_TOKEN?: string;
  /** The same token on an install from before the rename (ADR 0190); read when ROS_UPDATE_TOKEN is unset. */
  CRM_UPDATE_TOKEN?: string;
  /** Each person's assistant thread (ADR 0340): thread.* operations and erase reach it. */
  ASSISTANT?: DurableObjectNamespace<AssistantAgent>;
}

/**
 * The assistant threads as operations see them (ADR 0340): each person's AssistantAgent object,
 * for `thread.*` and for an erase to redact (ADR 0019 amendment).
 */
export function assistantThreadsFor(env: OperationsEnv): AssistantThreadStore | undefined {
  const namespace = env.ASSISTANT;
  if (!namespace) return undefined;
  const stub = (userId: string) =>
    getAgentByName(namespace as never, threadName(userId)) as unknown as Promise<
      DurableObjectStub<AssistantAgent>
    >;
  return {
    async search(userId, query, limit) {
      return (await stub(userId)).search(userId, query, limit);
    },
    async deleteMessage(userId, seq) {
      return (await stub(userId)).deleteMessage(userId, seq);
    },
    async markSeen(userId, seq) {
      return (await stub(userId)).markSeen(userId, seq);
    },
    async scrub(userId, scrub) {
      await (await stub(userId)).scrub(scrub);
    },
  };
}

/**
 * The extension runtime as seen from ros-app: ros-runner's RPC over the RUNNER service binding
 * (code runs in ros-runner's stateless entrypoint; git and builds in its workspace DO), with Code
 * Mode's per-user rate limit applied here, where the binding lives.
 */
export function extensionHostFor(env: OperationsEnv): ExtensionHost | undefined {
  if (!env.RUNNER) return undefined;
  const host = runner({ RUNNER: env.RUNNER }) as unknown as ExtensionHost;
  return withCodeModeRateLimit(rpcHost(host), env.CODE_MODE_RATE_LIMIT);
}

/**
 * The automation wiring for an invocation (ADR 0130): committed record changes go to the
 * AUTOMATION_EVENTS queue, and automation.test / run / retry / replay / cancel reach ros-runner.
 */
export function automationWiring(env: OperationsEnv): {
  events?: EventSink;
  automationHost?: AutomationHost;
} {
  const out: { events?: EventSink; automationHost?: AutomationHost } = {};
  if (env.AUTOMATION_EVENTS) out.events = queueEventSink(env.AUTOMATION_EVENTS);
  if (env.RUNNER) {
    const stub = runner({ RUNNER: env.RUNNER });
    out.automationHost = {
      testAutomation: (input) => stub.testAutomation(input),
      startManualRun: (input) => stub.startManualRun(input),
      retryRun: (runId) => stub.retryRun(runId),
      replayRun: (runId) => stub.replayRun(runId),
      cancelRun: (runId) => stub.cancelRun(runId),
    };
  }
  return out;
}

/** The RPC stub's methods as a plain object (an RPC stub cannot be spread). */
function rpcHost(stub: ExtensionHost): ExtensionHost {
  return {
    commit: (input) => stub.commit(input),
    shipped: () => stub.shipped(),
    commitShipped: (id) => stub.commitShipped(id),
    evaluate: (input) => stub.evaluate(input),
    runTool: (input) => stub.runTool(input),
    versions: (id) => stub.versions(id),
    files: (id, commit) => stub.files(id, commit),
    listWorkspace: () => stub.listWorkspace(),
    workingCopy: (id, options) => stub.workingCopy(id, options),
    writeFiles: (input) => stub.writeFiles(input),
    commitWorkingCopy: (input) => stub.commitWorkingCopy(input),
    eject: (id) => stub.eject(id),
    runCode: (input) => stub.runCode(input),
    describeChange: (input) => stub.describeChange(input),
  };
}

let shippedInstall: Promise<void> | null = null;

/**
 * Installs the shipped extensions bundled with this release once per isolate, through
 * `extension.install` in ros-runner (ADR 0025). A failure is logged and retried on a later call;
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
  /** The request's origin: where integration connect popups are handed back. */
  appOrigin?: string,
): Promise<OperationResult> {
  if (!principal) {
    return { ok: false, error: { code: "forbidden", message: "Sign in to continue" } };
  }
  try {
    await ensureShippedExtensions(env);
    const db = createCrmDb(env.DB);
    const extensionHost = extensionHostFor(env);
    const integrations = integrationRuntimeFor(env, appOrigin);
    const blobs = blobStoreFor(env);
    const assistantThreads = assistantThreadsFor(env);
    const ctx: InvocationContext = {
      ...(integrations ? { integrations } : {}),
      ...(blobs ? { blobs } : {}),
      actor: "human",
      user: await resolveActingUser(db, principal),
      origin: { surface: "ui" },
      db,
      floor: parseFloor(env.APPROVAL_FLOOR),
      ...(extensionHost ? { extensionHost } : {}),
      ...automationWiring(env),
      ...(assistantThreads ? { assistantThreads } : {}),
      updater: updaterRuntimeFor(env),
      ...aiContextFor(env, db),
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
      // Log-safe: the error can quote record content (ADR 0320).
      console.error(`operation ${call.name} failed`, errorForLog(error));
      // Internal details stay in the logs.
      return { ok: false, error: { code: typed.code, message: typed.message } };
    }
    return toWire({ ok: false, error: typed.toJSON() });
  }
}
