// The sandbox side of the runtime. The host generates a small entry module per run that imports
// the extension and the host modules it declared, and calls `runExtension`. Tool handlers get a
// `ctx` built from those modules; a module the extension did not declare is absent, and using it
// throws.
import {
  type AutomationAdvance,
  type AutomationContext,
  type AutomationEvent,
  type AutomationJournalEntry,
  type AutomationRunRequest,
  type AutomationSpec,
  type AutomationStep,
  type AutomationStepApi,
  type AutomationTestStep,
  type Duration,
  durationMs,
  notificationInput,
} from "./automation.ts";
import type {
  AiModule,
  CrmModule,
  Extension,
  ExtensionContext,
  GatekeeperModule,
  LogModule,
  StorageModule,
} from "./contract.ts";
import { toManifest } from "./manifest.ts";

type HostFn = (...args: unknown[]) => Promise<unknown>;

/** The raw `codemode:*` modules, as imported in the entry module. */
export interface RawHostModules {
  crm?: { call: HostFn };
  storage?: { get: HostFn; set: HostFn; del: HostFn; list: HostFn };
  log?: { write: HostFn };
  ai?: { summarise: HostFn; extract: HostFn; classify: HostFn };
  /** `codemode:<gatekeeper>` modules, by gatekeeper name. */
  [gatekeeper: string]: Record<string, HostFn> | undefined;
}

export type RunRequest =
  | { kind: "manifest" }
  | { kind: "tool"; tool: string; input: unknown; version?: string };

export type RunResponse =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

/** What `codemode:crm`'s `call` returns. */
export type CrmReply =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

/** Thrown by `ctx.crm.call` when the operation fails; `code` is the pipeline's error code. */
export class CrmCallError extends Error {
  override name = "CrmCallError";
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

function missing(name: string): never {
  throw new Error(
    `Host module "${name}" is not declared. Add "${name}" to permissions.modules in defineExtension.`,
  );
}

function absent<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      if (prop === "then") return undefined;
      return () => missing(name);
    },
  });
}

/** Builds the `ctx` tools receive from raw host modules. Exported for the testing harness. */
export function buildContext(
  extension: { id: string; version: string },
  raw: RawHostModules,
  pending: Promise<unknown>[] = [],
): ExtensionContext {
  const crm: CrmModule = raw.crm
    ? {
        call: async (operation, input) => {
          // The host answers with an envelope so error codes survive the isolate boundary.
          const reply = (await raw.crm?.call(operation, input ?? {})) as CrmReply;
          if (reply.ok) return reply.value as never;
          throw new CrmCallError(reply.error.code, reply.error.message, reply.error.details);
        },
      }
    : absent("crm");
  const storage: StorageModule = raw.storage
    ? {
        get: (key) => raw.storage?.get(key) as Promise<never>,
        set: async (key, value) => {
          await raw.storage?.set(key, value);
        },
        delete: async (key) => {
          await raw.storage?.del(key);
        },
        list: (prefix) => raw.storage?.list(prefix ?? "") as Promise<never>,
      }
    : absent("storage");
  const write = (level: string) => (message: string, data?: unknown) => {
    const call = raw.log?.write(level, String(message), data ?? null);
    if (call) pending.push(call.catch(() => undefined));
  };
  const log: LogModule = raw.log
    ? { info: write("info"), warn: write("warn"), error: write("error") }
    : absent("log");
  const ai: AiModule = raw.ai
    ? {
        summarise: (text, options) => raw.ai?.summarise(text, options ?? {}) as Promise<string>,
        extract: (text, fields) => raw.ai?.extract(text, fields) as Promise<never>,
        classify: (text, labels) => raw.ai?.classify(text, labels) as Promise<never>,
      }
    : absent("ai");
  const gatekeeper = (name: string): GatekeeperModule => {
    const mod = raw[name] as Record<string, HostFn> | undefined;
    if (!mod?.call) return absent<GatekeeperModule>(name);
    return {
      connections: () => mod.connections?.() as Promise<never>,
      call: async (connectionId, resource, method, ...args) => {
        const reply = (await mod.call?.(connectionId, resource, method, args)) as CrmReply;
        if (reply.ok) return reply.value as never;
        throw new CrmCallError(reply.error.code, reply.error.message, reply.error.details);
      },
      types: (connectionId, resource) => mod.types?.(connectionId, resource) as Promise<string>,
    };
  };
  return {
    extension: { id: extension.id, version: extension.version },
    crm,
    storage,
    log,
    ai,
    gatekeeper: gatekeeper as ExtensionContext["gatekeeper"],
  };
}

function toError(error: unknown): { code: string; message: string; details?: unknown } {
  if (error && typeof error === "object") {
    const e = error as { code?: unknown; message?: unknown; details?: unknown };
    return {
      code: typeof e.code === "string" ? e.code : "extension_error",
      message: typeof e.message === "string" ? e.message : String(error),
      ...(e.details === undefined ? {} : { details: e.details }),
    };
  }
  return { code: "extension_error", message: String(error) };
}

/** Plain JSON only crosses back to the host. */
function plain(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

/** Dispatches one run request inside the sandbox. */
export async function runExtension(
  extension: Extension,
  request: RunRequest,
  raw: RawHostModules,
): Promise<RunResponse> {
  const pending: Promise<unknown>[] = [];
  try {
    if (request.kind === "manifest") return { ok: true, value: plain(toManifest(extension)) };
    const tool = extension.tools?.[request.tool];
    if (!tool) {
      return {
        ok: false,
        error: { code: "unknown_tool", message: `No tool named ${request.tool}` },
      };
    }
    const parsed = tool.input.safeParse(request.input);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "invalid_input",
          message: `Invalid input for ${request.tool}`,
          details: plain(parsed.error.issues),
        },
      };
    }
    const ctx = buildContext(extension, raw, pending);
    const result = await tool.handler(parsed.data, ctx);
    const checked = tool.output.safeParse(result);
    await Promise.all(pending);
    if (!checked.success) {
      return {
        ok: false,
        error: {
          code: "invalid_output",
          message: `${request.tool} returned an invalid result`,
          details: plain(checked.error.issues),
        },
      };
    }
    return { ok: true, value: plain(checked.data) };
  } catch (error) {
    await Promise.all(pending);
    return { ok: false, error: toError(error) };
  }
}

// ---------------------------------------------------------------------------------------------
// Automations (ADR 0130): the replay protocol. The host replays `run` with the journal of steps
// already done on every advance: journaled steps return their stored results, the first new
// `step.do` runs and the advance stops there, and a new sleep or wait stops without running
// anything. Test mode (ADR 0133) runs to the end, skipping waits.

/** What `runAutomation` returns in `value`: an advance, or (test mode) every step. */
export type AutomationRunValue =
  | AutomationAdvance
  | { kind: "test"; steps: AutomationTestStep[]; value: unknown };

/** Thrown to unwind `run` once the advance has done its one step. Never reaches the host. */
class AdvanceStop extends Error {
  override name = "AdvanceStop";
}

/** A step call that does not match the declarations (the declarations are the contract). */
export class AutomationStepError extends Error {
  override name = "AutomationStepError";
  readonly code = "undeclared_step";
}

/**
 * Builds the automation `ctx`: the extension context plus `notify`, which calls
 * `notification.send` with `notificationInput`. Its dedupe key is `<step>:<n>` (the n-th notify
 * of that step), so a step retried or replayed never notifies twice.
 */
export function buildAutomationContext(
  extension: { id: string; version: string },
  raw: RawHostModules,
  event: AutomationEvent,
  pending: Promise<unknown>[] = [],
  currentStep: () => string | null = () => null,
): AutomationContext {
  const base = buildContext(extension, raw, pending);
  const counts = new Map<string, number>();
  return {
    ...base,
    async notify(to, message) {
      const step = currentStep() ?? "run";
      const n = (counts.get(step) ?? 0) + 1;
      counts.set(step, n);
      const input = notificationInput(event, to, message, `${step}:${n}`);
      const out = (await base.crm.call("notification.send" as never, input as never)) as {
        sent?: number;
      } | null;
      return { sent: typeof out?.sent === "number" ? out.sent : 0 };
    },
  };
}

/** Runs one advance (or a whole test run) of an automation inside the sandbox. */
export async function runAutomation(
  extension: Extension,
  request: AutomationRunRequest,
  raw: RawHostModules,
): Promise<RunResponse> {
  const spec = extension.automations?.[request.automation] as AutomationSpec | undefined;
  if (!spec) {
    return {
      ok: false,
      error: { code: "unknown_automation", message: `No automation named ${request.automation}` },
    };
  }
  const test = request.mode === "test";
  const journal = request.journal ?? [];
  const declared = new Map(spec.steps.map((s) => [s.name, s] as const));
  const testSteps: AutomationTestStep[] = [];
  let cursor = 0;
  let stop: AutomationAdvance | null = null;

  const declaredStep = (name: string, kind: "do" | "sleep" | "waitForEvent"): AutomationStep => {
    const step = declared.get(name);
    if (!step) {
      throw new AutomationStepError(
        `step.${kind}("${name}") is not a declared step of ${request.automation}; add it to steps`,
      );
    }
    const declaredKind = step.kind ?? "do";
    if (declaredKind !== kind) {
      throw new AutomationStepError(
        `"${name}" is declared as a ${declaredKind} step but was called with step.${kind}`,
      );
    }
    return step;
  };
  /** The journaled result of the next step, or undefined when it is new. */
  const replayed = (name: string, kind: AutomationJournalEntry["kind"]) => {
    if (stop) throw new AdvanceStop();
    const entry = journal[cursor];
    if (!entry) return undefined;
    if (entry.name !== name || entry.kind !== kind) {
      throw new AutomationStepError(
        `The run took a different path on replay: step ${cursor + 1} was "${entry.name}" ` +
          `(${entry.kind}) and is now "${name}" (${kind}). Steps must run in the same order ` +
          "every time; base branches on step results, not on the clock or randomness.",
      );
    }
    cursor += 1;
    return { value: entry.value };
  };
  const halt = (advance: AutomationAdvance): never => {
    stop = advance;
    throw new AdvanceStop();
  };

  const pending: Promise<unknown>[] = [];
  // Every crm call carries the step it ran in, so the host can file it under that step (and
  // flag writes the step did not declare).
  let current: string | null = null;
  const crm = raw.crm;
  const tagged: RawHostModules = crm
    ? { ...raw, crm: { call: (operation, input) => crm.call(operation, input, { step: current }) } }
    : raw;
  const ctx = buildAutomationContext(extension, tagged, request.event, pending, () => current);
  const step = {
    async do(name: string, a: unknown, b?: unknown): Promise<unknown> {
      const fn = (typeof a === "function" ? a : b) as () => unknown;
      const declaredDo = declaredStep(name, "do") as { writes?: readonly { object: string }[] };
      if (a && typeof a === "object") {
        const intent = a as { writes?: readonly { object: string }[] };
        const allowed = new Set((declaredDo.writes ?? []).map((w) => w.object));
        const extra = (intent.writes ?? []).find((w) => !allowed.has(w.object));
        if (extra) {
          throw new AutomationStepError(
            `step.do("${name}") writes ${extra.object}, which its declaration does not list`,
          );
        }
      }
      const r = replayed(name, "do");
      if (r) return r.value;
      current = name;
      let value: unknown;
      try {
        value = plain(await fn());
      } finally {
        current = null;
      }
      if (test) {
        testSteps.push({ name, kind: "do", value });
        return value;
      }
      return halt({ kind: "do", name, value });
    },
    async sleep(name: string, duration: Duration): Promise<void> {
      declaredStep(name, "sleep");
      if (replayed(name, "sleep")) return;
      const ms = durationMs(duration);
      if (test) {
        testSteps.push({ name, kind: "sleep", skippedMs: ms });
        return;
      }
      halt({ kind: "sleep", name, ms });
    },
    async waitForEvent(name: string): Promise<unknown> {
      const declaredWait = declaredStep(name, "waitForEvent") as {
        event: string;
        timeout?: Duration;
      };
      const r = replayed(name, "waitForEvent");
      if (r) return r.value ?? null;
      const timeoutMs = durationMs(declaredWait.timeout ?? "7 days");
      if (test) {
        testSteps.push({ name, kind: "waitForEvent", skippedMs: timeoutMs });
        return null;
      }
      return halt({ kind: "waitForEvent", name, event: declaredWait.event, timeoutMs });
    },
  } as AutomationStepApi;

  try {
    const value = await spec.run(request.event, step, ctx);
    await Promise.all(pending);
    if (stop) return { ok: true, value: plain(stop) };
    const done: AutomationRunValue = test
      ? { kind: "test", steps: testSteps, value: plain(value) }
      : { kind: "done", value: plain(value) };
    return { ok: true, value: plain(done) };
  } catch (error) {
    await Promise.all(pending);
    // The stop unwinds `run` by throwing; code that catches and rethrows it changes nothing.
    if (stop) return { ok: true, value: plain(stop) };
    // Test mode keeps the steps that ran before the failure, for the report.
    if (test) {
      return { ok: false, error: { ...toError(error), details: { steps: plain(testSteps) } } };
    }
    return { ok: false, error: toError(error) };
  }
}
