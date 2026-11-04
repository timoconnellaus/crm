// The host side of one run (ADR 0025, ADR 0043): a per-run RpcTarget the executor passes to the
// Dynamic Worker as an argument. It holds everything about the run (who it acts as, the declared
// modules and permissions, the deadline, the logs and operations it collects), so a reused worker
// carries no run state of its own, and two concurrent runs on one worker cannot see each other's.
//
// `call(module, method, args)` is the only way extension code reaches the CRM:
// - only the declared modules answer (the entry module also only wires those);
// - `crm` invokes operations through the pipeline as the extension principal (actor `extension`),
//   or, for a Code Mode script, as the connected user (ADR 0042);
// - after the deadline, or once the run is over, every call is refused, so a run that timed out
//   cannot keep acting.
import { RpcTarget } from "cloudflare:workers";
import {
  type ActingUser,
  type CodeCaller,
  type EventSink,
  invokeByName,
  PendingApprovalError,
  type Permission,
  parseFloor,
  type TestSimulation,
  toOperationError,
} from "@crm/core";
import { createCrmDb } from "@crm/db";
import type { ExtensionManifest } from "@crm/sdk";
import { runModelRole } from "../extensions/ai.ts";
import { CODE_MAX_CALLS } from "../extensions/code-mode.ts";
import { embedsFromEvents } from "../extensions/embeddings.ts";
import { gatekeeperCall } from "../integrations/code.ts";
import { HOST_METHODS, type HostModule, isGatekeeperModule, isHostModule } from "./worker-code.ts";

export const MAX_LOGS = 200;

export interface HostEnv {
  DB: D1Database;
  APPROVAL_FLOOR?: string;
  AI?: unknown;
  AI_GATEWAY_ID?: string;
}

/** A Code Mode run (ADR 0042): the script acts as the connected user, not as an extension. */
export interface CodeRun {
  caller: CodeCaller;
  pending: unknown[];
  calls: number;
}

export interface RunLog {
  level: string;
  message: string;
  data: unknown;
  at: string;
}

export interface RunOperation {
  operation: string;
  ok: boolean;
  code?: string;
  pendingActionId?: string;
  ms: number;
  /** Automation runs: the object the call touched, the step it ran in, and what it returned. */
  object?: string | null;
  step?: string | null;
  pending?: { actionId: string; changeSetId: string; expiresAt: string };
  /** Created / changed record ids, when the output names one. */
  recordId?: string;
  /** Records the call wrote (bulk calls: the input's ids), for the writes-per-hour rail. */
  writes?: number;
}

/**
 * An automation run (ADR 0130): operations run as actor `automation` under the extension
 * principal, with the run's cascade tags on their origin, and post-commit events. In test mode
 * (ADR 0133) they run against `simulate` and send no events.
 */
export interface AutomationRunContext {
  automationId: string;
  runId: string;
  depth: number;
  chain: string[];
  rootEventId: string;
  events?: EventSink;
  simulate?: TestSimulation;
}

export interface RunState {
  runId: string;
  extensionId: string;
  code?: CodeRun;
  automation?: AutomationRunContext;
  modules: ReadonlySet<HostModule>;
  user: ActingUser;
  permissions: ExtensionManifest["permissions"];
  /** Epoch ms after which every host call is refused. */
  deadline: number;
  logs: RunLog[];
  operations: RunOperation[];
}

type Envelope =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

function json(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null));
}

function errorEnvelope(error: unknown): Envelope {
  const typed = toOperationError(error);
  return {
    ok: false,
    error: {
      code: typed.code,
      message: typed.code === "internal" ? "Internal error" : typed.message,
      ...(typed.code !== "internal" && typed.details !== undefined
        ? { details: typed.details }
        : {}),
    },
  };
}

export class RunHost extends RpcTarget {
  readonly #env: HostEnv;
  readonly #run: RunState;
  #closed = false;

  constructor(env: HostEnv, run: RunState) {
    super();
    this.#env = env;
    this.#run = run;
  }

  /** Ends the run: later calls (a timed-out run still executing) are refused. */
  close(): void {
    this.#closed = true;
  }

  async call(module: string, method: string, args: unknown[]): Promise<unknown> {
    const run = this.#run;
    if (this.#closed) throw new Error("This run has ended; the host no longer answers it");
    if (Date.now() > run.deadline) throw new Error("The run passed its deadline");
    if (!isHostModule(module) || !run.modules.has(module)) {
      throw new Error(`Host module "${module}" is not declared by ${run.extensionId}`);
    }
    if (!(HOST_METHODS[module] as readonly string[]).includes(method)) {
      throw new Error(`codemode:${module} has no ${method}`);
    }
    const list = Array.isArray(args) ? args : [];
    switch (module) {
      case "crm":
        if (run.code) return this.#codeCall(run.code, list);
        return run.automation ? this.#automationCall(run.automation, list) : this.#crmCall(list);
      case "storage":
        return this.#storage(method as "get" | "set" | "del" | "list", list);
      case "log":
        return this.#log(list);
      case "ai":
        return json(
          await runModelRole(this.#env, method as "summarise" | "extract" | "classify", list),
        );
      default:
        if (isGatekeeperModule(module)) return this.#gatekeeper(module, method, list);
        throw new Error(`Unknown host module ${module}`);
    }
  }

  async #crmCall(args: unknown[]): Promise<unknown> {
    const run = this.#run;
    const [name, input] = args;
    const started = Date.now();
    const operation = String(name);
    let reply: Envelope;
    try {
      const value = await invokeByName(operation, input ?? {}, {
        actor: "extension",
        user: run.user,
        origin: { surface: "extension", extensionId: run.extensionId },
        db: createCrmDb(this.#env.DB),
        floor: parseFloor(this.#env.APPROVAL_FLOOR),
        extension: { id: run.extensionId, permissions: run.permissions },
      });
      reply = { ok: true, value };
    } catch (error) {
      reply = errorEnvelope(error);
    }
    run.operations.push({
      operation,
      ok: reply.ok,
      ...(reply.ok ? {} : { code: reply.error.code }),
      ms: Date.now() - started,
    });
    return json(reply);
  }

  /**
   * `codemode:crm` in an automation run: actor `automation` under the extension principal, with
   * the run's cascade origin. A call the gate queues for review answers with the pending envelope
   * (as in Code Mode); the Workflow then waits for the decision.
   */
  async #automationCall(automation: AutomationRunContext, args: unknown[]): Promise<unknown> {
    const run = this.#run;
    const [name, input, meta] = args;
    const operation = String(name);
    const started = Date.now();
    let reply: Envelope;
    let pending: RunOperation["pending"];
    try {
      const value = await invokeByName(operation, input ?? {}, {
        actor: "automation",
        user: run.user,
        origin: {
          surface: "automation",
          automationId: automation.automationId,
          runId: automation.runId,
          extensionId: run.extensionId,
          depth: automation.depth,
          chain: automation.chain,
          rootEventId: automation.rootEventId,
          ...(automation.simulate ? { test: true } : {}),
        },
        db: createCrmDb(this.#env.DB),
        floor: parseFloor(this.#env.APPROVAL_FLOOR),
        extension: { id: run.extensionId, permissions: run.permissions },
        reason: `Automation ${automation.automationId}`,
        ...(automation.events ? { events: automation.events } : {}),
        ...(automation.events && embedsFromEvents(this.#env) ? { embedViaEvents: true } : {}),
        ...(automation.simulate ? { simulate: automation.simulate } : {}),
      });
      reply = { ok: true, value };
    } catch (error) {
      if (error instanceof PendingApprovalError) {
        pending = {
          actionId: error.pending.actionId,
          changeSetId: error.pending.changeSetId,
          expiresAt: error.pending.expiresAt,
        };
        reply = { ok: true, value: error.pending };
      } else {
        reply = errorEnvelope(error);
      }
    }
    const value = reply.ok ? (reply.value as { id?: unknown; ids?: unknown } | null) : null;
    const record = input as { object?: unknown; ids?: unknown } | null;
    const step = (meta as { step?: unknown } | null)?.step;
    run.operations.push({
      operation,
      ok: reply.ok,
      ...(reply.ok ? {} : { code: reply.error.code }),
      ...(pending ? { pendingActionId: pending.actionId, pending } : {}),
      ms: Date.now() - started,
      object: operation.startsWith("record.")
        ? typeof record?.object === "string"
          ? record.object
          : null
        : (operation.split(".")[0] ?? null),
      step: typeof step === "string" ? step : null,
      ...(!pending && typeof value?.id === "string" ? { recordId: value.id } : {}),
      writes: Array.isArray(record?.ids) ? record.ids.length : 1,
    });
    return json(reply);
  }

  /** `codemode:crm` for a Code Mode script: the connected user's actor, through the gate. */
  async #codeCall(code: CodeRun, args: unknown[]): Promise<unknown> {
    const run = this.#run;
    const [name, input] = args;
    const operation = String(name);
    const started = Date.now();
    let reply: Envelope;
    let pendingActionId: string | undefined;
    code.calls += 1;
    if (code.calls > CODE_MAX_CALLS) {
      reply = {
        ok: false,
        error: {
          code: "limit",
          message: `A script may make at most ${CODE_MAX_CALLS} operation calls; use *Many operations for many records`,
        },
      };
    } else if (
      operation.startsWith("extension.") ||
      operation.startsWith("x.") ||
      operation === "code.run"
    ) {
      reply = {
        ok: false,
        error: {
          code: "forbidden",
          message: `${operation} cannot be called from a Code Mode script; call it as a tool`,
        },
      };
    } else {
      const { caller } = code;
      try {
        const value = await invokeByName(operation, input ?? {}, {
          actor: caller.actor,
          user: caller.user,
          origin: caller.origin,
          db: createCrmDb(this.#env.DB),
          floor: parseFloor(this.#env.APPROVAL_FLOOR),
          grantedPermissions: caller.grantedPermissions as Permission[] | undefined,
          reason: caller.reason ?? "Code Mode script",
          approvalExpiryDays: caller.approvalExpiryDays,
        });
        reply = { ok: true, value };
      } catch (error) {
        if (error instanceof PendingApprovalError) {
          code.pending.push(error.pending);
          pendingActionId = error.pending.actionId;
          reply = { ok: true, value: error.pending };
        } else {
          reply = errorEnvelope(error);
        }
      }
    }
    run.operations.push({
      operation,
      ok: reply.ok,
      ...(reply.ok ? {} : { code: reply.error.code }),
      ...(pendingActionId ? { pendingActionId } : {}),
      ms: Date.now() - started,
    });
    return json(reply);
  }

  async #storage(op: "get" | "set" | "del" | "list", args: unknown[]): Promise<unknown> {
    const db = createCrmDb(this.#env.DB).query;
    const key = String(args[0] ?? "");
    if (op !== "list" && (key.length < 1 || key.length > 512)) {
      throw new Error("Storage keys are 1 to 512 characters");
    }
    const ext = this.#run.extensionId;
    switch (op) {
      case "get": {
        const row = await db
          .selectFrom("core_extension_kv")
          .select("value")
          .where("extension_id", "=", ext)
          .where("key", "=", key)
          .executeTakeFirst();
        return row ? (JSON.parse(row.value) as unknown) : null;
      }
      case "set": {
        const value = JSON.stringify(args[1] ?? null);
        if (value.length > 128_000) throw new Error("Storage values are limited to 128 KB");
        const now = new Date().toISOString();
        await db
          .insertInto("core_extension_kv")
          .values({ extension_id: ext, key, value, updated_at: now })
          .onConflict((oc) =>
            oc.columns(["extension_id", "key"]).doUpdateSet({ value, updated_at: now }),
          )
          .execute();
        return null;
      }
      case "del":
        await db
          .deleteFrom("core_extension_kv")
          .where("extension_id", "=", ext)
          .where("key", "=", key)
          .execute();
        return null;
      case "list": {
        const rows = await db
          .selectFrom("core_extension_kv")
          .select(["key", "value"])
          .where("extension_id", "=", ext)
          .where("key", ">=", key)
          .where("key", "<", `${key}￿`)
          .orderBy("key")
          .limit(1000)
          .execute();
        return rows.map((r) => ({ key: r.key, value: JSON.parse(r.value) as unknown }));
      }
    }
  }

  /** `codemode:<gatekeeper>`: org connections for an extension, the user's too for Code Mode. */
  async #gatekeeper(vendor: string, method: string, args: unknown[]): Promise<unknown> {
    const run = this.#run;
    const code = run.code;
    return json(
      await gatekeeperCall(this.#env as unknown as Env, {
        vendor,
        method,
        args,
        user: code ? code.caller.user : run.user,
        actor: code ? code.caller.actor : "extension",
        origin: code ? code.caller.origin : { surface: "extension", extensionId: run.extensionId },
        reason: code?.caller.reason,
      }),
    );
  }

  #log(args: unknown[]): null {
    const run = this.#run;
    const [level, message, data] = args;
    if (run.logs.length < MAX_LOGS) {
      run.logs.push({
        level: ["info", "warn", "error"].includes(String(level)) ? String(level) : "info",
        message: String(message).slice(0, 2000),
        data: json(data),
        at: new Date().toISOString(),
      });
    }
    return null;
  }
}
