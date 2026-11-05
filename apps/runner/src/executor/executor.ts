// The extension executor (ADR 0043): runs extension code from the stateless runner entrypoint (and,
// from stage 5, from Workflow steps), never inside the workspace DO, so runs execute in parallel.
//
// The rule: anything that runs more than once gets its Dynamic Worker from
// `LOADER.get(stableId, …)`. Tool runs key on extension + commit + host modules + runtime; manifest
// evaluation keys on extension + source hash + runtime; the checker keys on the compiler and its
// declarations. Only Code Mode scripts, new code every time, use `LOADER.load()`.
//
// Each call passes the run's context as RPC arguments: the request and a per-run host RpcTarget
// (src/executor/host.ts) that carries the principal, the deadline and the run's logs. A reused
// worker therefore holds no run state, and the entry module patches no globals.
import {
  type CodeCaller,
  type CodeResult,
  type EvaluateResult,
  newId,
  type RunToolInput,
  type RunToolResult,
  type SourceIssue,
} from "@relationship-os/core";
import { createCrmDb } from "@relationship-os/db";
import {
  type AutomationRunRequest,
  type ExtensionManifest,
  GATEKEEPER_MODULES,
  type RunResponse,
} from "@relationship-os/sdk";
import { runBuildRole } from "../extensions/ai.ts";
import {
  buildScript,
  CODE_MAX_VALUE_BYTES,
  CODE_TIMEOUT_MS,
  codeWorkerCode,
} from "../extensions/code-mode.ts";
import { recordRun } from "../extensions/runs.ts";
import { type BuildEnv, prepare, workspaceStub } from "./build-cache.ts";
import type { CodeModeGate } from "./code-gate.ts";
import {
  type AutomationRunContext,
  type HostEnv,
  RunHost,
  type RunLog,
  type RunOperation,
  type RunState,
} from "./host.ts";
import { extensionWorkerCode, manifestWorkerId, moduleSet, toolWorkerId } from "./worker-code.ts";

/** Consecutive failed runs that quarantine an extension (ADR 0025). */
export const QUARANTINE_AFTER = 3;
export const TOOL_TIMEOUT_MS = 30_000;
export const MANIFEST_TIMEOUT_MS = 10_000;
/** Failures that are the caller's, not the extension's: they do not count towards quarantine. */
const CALLER_ERRORS = new Set(["invalid_input", "unknown_tool"]);

export interface ExecutorEnv extends HostEnv, BuildEnv {
  LOADER: WorkerLoader;
  CODE_MODE_GATE: DurableObjectNamespace<CodeModeGate>;
}

export interface ExecutorOptions {
  /** Worker Loader to use (tests wrap it to count loads). Defaults to env.LOADER. */
  loader?: WorkerLoader;
  toolTimeoutMs?: number;
  manifestTimeoutMs?: number;
  codeTimeoutMs?: number;
}

interface ExtensionEntrypoint {
  evaluateManifest(): Promise<RunResponse>;
  runTool(
    request: { runId: string; tool: string; input: unknown; version: string; deadline: number },
    host: RunHost,
  ): Promise<RunResponse>;
  runAutomation(request: AutomationRunRequest, host: RunHost): Promise<RunResponse>;
}

/** One automation advance (or a whole test run) and what the host saw it do (ADR 0130). */
export interface AutomationExecution {
  response: RunResponse;
  operations: RunOperation[];
  logs: RunLog[];
  ms: number;
  /** The worker id it ran on (LOADER.get with the tool worker's stable id). */
  workerId: string | null;
}

export interface RunAutomationInput {
  extensionId: string;
  commit: string;
  request: AutomationRunRequest;
  automation: AutomationRunContext;
}

/** Automation step failures that retrying cannot fix: the Workflow stops at once. */
export const PERMANENT_AUTOMATION_ERRORS = new Set([
  "disabled",
  "build",
  "entry",
  "unknown_automation",
  "undeclared_step",
]);

interface CodeEntrypoint {
  run(
    host: RunHost,
  ): Promise<RunResponse & { logs?: { level: string; message: string }[]; dropped?: boolean }>;
}

/** Symbol.dispose (workerd has it; this lib target does not declare it). */
const DISPOSE = (Symbol as unknown as { dispose?: symbol }).dispose;

/** Releases an RPC stub now rather than at garbage collection. */
function dispose(value: unknown): void {
  if (!DISPOSE || !value) return;
  try {
    (value as Record<symbol, (() => void) | undefined>)[DISPOSE]?.();
  } catch {
    // Already gone.
  }
}

function isResponse(value: unknown): value is RunResponse {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as { ok?: unknown }).ok === "boolean"
  );
}

/**
 * Calls `fn` on a fresh entrypoint stub of `worker` with a deadline. On timeout the run's host is
 * closed (it refuses further calls) and the stub is dropped; the result is `timeout`. A throw
 * (module evaluation failed, the isolate died, the CPU limit) is `crashed`.
 */
async function invoke<E, R>(
  worker: WorkerStub,
  timeoutMs: number,
  fn: (entrypoint: E) => Promise<R>,
  host?: RunHost,
): Promise<
  { value: R; ms: number } | { error: { code: "timeout" | "crashed"; message: string }; ms: number }
> {
  const started = Date.now();
  let entrypoint: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    entrypoint = worker.getEntrypoint(undefined, { limits: { cpuMs: timeoutMs } });
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const run = fn(entrypoint as E).then((value) => ({ value }));
    const outcome = await Promise.race([run, timeout]);
    if (outcome === "timeout") {
      run.catch(() => undefined);
      return {
        error: { code: "timeout", message: `Timed out after ${timeoutMs} ms` },
        ms: Date.now() - started,
      };
    }
    return { value: outcome.value, ms: Date.now() - started };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      error: { code: "crashed", message: message || "The run crashed" },
      ms: Date.now() - started,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    host?.close();
    dispose(entrypoint);
  }
}

export class Executor {
  readonly #env: ExecutorEnv;
  readonly #loader: WorkerLoader;
  readonly #toolTimeoutMs: number;
  readonly #manifestTimeoutMs: number;
  readonly #codeTimeoutMs: number;

  constructor(env: ExecutorEnv, options: ExecutorOptions = {}) {
    this.#env = env;
    this.#loader = options.loader ?? env.LOADER;
    this.#toolTimeoutMs = options.toolTimeoutMs ?? TOOL_TIMEOUT_MS;
    this.#manifestTimeoutMs = options.manifestTimeoutMs ?? MANIFEST_TIMEOUT_MS;
    this.#codeTimeoutMs = options.codeTimeoutMs ?? CODE_TIMEOUT_MS;
  }

  /**
   * Evaluates source in a Dynamic Worker with no host modules and returns its manifest. `commit`
   * for committed source, `files` for a dry run. The build is cached by content hash.
   */
  async evaluate(
    input: { id: string; commit: string } | { id: string; files: Record<string, string> },
  ): Promise<EvaluateResult> {
    const commit = "commit" in input ? input.commit : null;
    let prepared: Awaited<ReturnType<typeof prepare>>;
    try {
      prepared = await prepare(this.#env, this.#loader, input);
    } catch (error) {
      const issue: SourceIssue = {
        code: "entry",
        path: "(root)",
        message: error instanceof Error ? error.message : String(error),
      };
      return { ok: false, commit, issues: [issue] };
    }
    const { build } = prepared;
    if (!build.ok) return { ok: false, commit, issues: build.issues };
    const id = await manifestWorkerId({ extensionId: input.id, sourceHash: prepared.sourceHash });
    const worker = this.#loader.get(id, () => extensionWorkerCode(build.modules, []));
    const outcome = await invoke<ExtensionEntrypoint, RunResponse>(
      worker,
      this.#manifestTimeoutMs,
      (ep) => ep.evaluateManifest(),
    );
    const response: RunResponse =
      "error" in outcome
        ? { ok: false, error: outcome.error }
        : isResponse(outcome.value)
          ? outcome.value
          : { ok: false, error: { code: "crashed", message: "The worker returned no result" } };
    if (commit) {
      await recordRun(this.#env, {
        extensionId: input.id,
        commit,
        kind: "manifest",
        name: null,
        caller: null,
        ms: outcome.ms,
        response,
        logs: [],
        operations: [],
      });
    }
    if (!response.ok) {
      return {
        ok: false,
        commit,
        issues: [{ code: "evaluate", path: "index.ts", message: response.error.message }],
      };
    }
    return { ok: true, commit, manifest: response.value };
  }

  /** Runs a tool of an installed extension and records the run (ADR 0025). */
  async runTool(input: RunToolInput): Promise<RunToolResult> {
    const db = createCrmDb(this.#env.DB).query;
    const row = await db
      .selectFrom("core_extensions as e")
      .innerJoin("core_user as u", "u.id", "e.user_id")
      .select([
        "e.status",
        "e.manifest",
        "e.failure_count",
        "e.last_good_commit",
        "u.id as user_id",
        "u.email",
        "u.name",
      ])
      .where("e.id", "=", input.id)
      .executeTakeFirst();
    if (row?.status !== "active") {
      return {
        ok: false,
        runId: "",
        quarantined: row?.status === "quarantined",
        error: {
          code: "disabled",
          message: `Extension ${input.id} is ${row?.status ?? "not installed"}`,
        },
      };
    }
    const manifest = JSON.parse(row.manifest) as ExtensionManifest;
    const modules = moduleSet(manifest.permissions.modules);
    const workerId = await toolWorkerId({ extensionId: input.id, commit: input.commit, modules });
    let buildIssues: SourceIssue[] | null = null;
    // The callback runs only when no isolate with this id is warm: then the build comes from the
    // cache (or is built once) and the code is the same for this id every time.
    const worker = this.#loader.get(workerId, async () => {
      const prepared = await prepare(this.#env, this.#loader, {
        id: input.id,
        commit: input.commit,
      });
      if (!prepared.build.ok) {
        buildIssues = prepared.build.issues;
        throw new Error("The extension does not build");
      }
      return extensionWorkerCode(prepared.build.modules, modules);
    });
    const runId = newId("extensionRun");
    const deadline = Date.now() + this.#toolTimeoutMs;
    const run: RunState = {
      runId,
      extensionId: input.id,
      modules: new Set(modules),
      user: { id: row.user_id, email: row.email, name: row.name, role: "member" },
      permissions: manifest.permissions,
      deadline,
      logs: [],
      operations: [],
    };
    const host = new RunHost(this.#env, run);
    const outcome = await invoke<ExtensionEntrypoint, RunResponse>(
      worker,
      this.#toolTimeoutMs,
      (ep) =>
        ep.runTool(
          { runId, tool: input.tool, input: input.input, version: manifest.version, deadline },
          host,
        ),
      host,
    );
    let response: RunResponse;
    const issues = buildIssues as SourceIssue[] | null;
    if (issues) {
      response = {
        ok: false,
        error: { code: "build", message: issues.map((i) => i.message).join("; ") },
      };
    } else if ("error" in outcome) {
      response = { ok: false, error: outcome.error };
    } else if (isResponse(outcome.value)) {
      response = outcome.value;
    } else {
      response = {
        ok: false,
        error: { code: "crashed", message: "The worker returned no result" },
      };
    }
    const counts = !response.ok && !CALLER_ERRORS.has(response.error.code);
    const failures = response.ok ? 0 : counts ? row.failure_count + 1 : row.failure_count;
    const quarantined = failures >= QUARANTINE_AFTER;
    await recordRun(this.#env, {
      id: runId,
      extensionId: input.id,
      commit: input.commit,
      kind: "tool",
      name: input.tool,
      caller: input.caller,
      ms: outcome.ms,
      response,
      logs: run.logs,
      operations: run.operations,
    });
    // Most runs succeed on the last good commit with no failures behind them: nothing changes,
    // so skip the write (a D1 row plus its index entries on every tool and automation step).
    const unchanged =
      failures === row.failure_count &&
      !quarantined &&
      (!response.ok || row.last_good_commit === input.commit);
    if (!unchanged) {
      await db
        .updateTable("core_extensions")
        .set({
          failure_count: failures,
          ...(response.ok ? { last_good_commit: input.commit } : {}),
          ...(quarantined
            ? {
                status: "quarantined" as const,
                status_reason: `Quarantined after ${QUARANTINE_AFTER} consecutive failed runs (last: ${
                  response.ok ? "" : response.error.message.slice(0, 200)
                })`,
              }
            : {}),
          updated_at: new Date().toISOString(),
        })
        .where("id", "=", input.id)
        .where("status", "=", "active")
        .execute();
    }
    if (response.ok) return { ok: true, value: response.value, runId };
    return { ok: false, error: response.error, runId, quarantined };
  }

  /**
   * One advance of an automation run, or a whole test run (ADR 0130, ADR 0133), in the
   * extension's tool worker: `LOADER.get` with the stable tool worker id, never `load()`. A
   * failure counts towards quarantine like a tool failure.
   */
  async runAutomation(input: RunAutomationInput): Promise<AutomationExecution> {
    const db = createCrmDb(this.#env.DB).query;
    const row = await db
      .selectFrom("core_extensions as e")
      .innerJoin("core_user as u", "u.id", "e.user_id")
      .select(["e.status", "e.manifest", "e.failure_count", "u.id as user_id", "u.email", "u.name"])
      .where("e.id", "=", input.extensionId)
      .executeTakeFirst();
    if (row?.status !== "active") {
      return {
        response: {
          ok: false,
          error: {
            code: "disabled",
            message: `Extension ${input.extensionId} is ${row?.status ?? "not installed"}`,
          },
        },
        operations: [],
        logs: [],
        ms: 0,
        workerId: null,
      };
    }
    const manifest = JSON.parse(row.manifest) as ExtensionManifest;
    const modules = moduleSet(manifest.permissions.modules);
    const workerId = await toolWorkerId({
      extensionId: input.extensionId,
      commit: input.commit,
      modules,
    });
    let buildIssues: SourceIssue[] | null = null;
    const worker = this.#loader.get(workerId, async () => {
      const prepared = await prepare(this.#env, this.#loader, {
        id: input.extensionId,
        commit: input.commit,
      });
      if (!prepared.build.ok) {
        buildIssues = prepared.build.issues;
        throw new Error("The extension does not build");
      }
      return extensionWorkerCode(prepared.build.modules, modules);
    });
    const run: RunState = {
      runId: input.automation.runId,
      extensionId: input.extensionId,
      automation: input.automation,
      modules: new Set(modules),
      user: { id: row.user_id, email: row.email, name: row.name, role: "member" },
      permissions: manifest.permissions,
      deadline: Date.now() + this.#toolTimeoutMs,
      logs: [],
      operations: [],
    };
    const host = new RunHost(this.#env, run);
    const request = { ...input.request, version: manifest.version };
    const outcome = await invoke<ExtensionEntrypoint, RunResponse>(
      worker,
      this.#toolTimeoutMs,
      (ep) => ep.runAutomation(request, host),
      host,
    );
    const issues = buildIssues as SourceIssue[] | null;
    const response: RunResponse = issues
      ? { ok: false, error: { code: "build", message: issues.map((i) => i.message).join("; ") } }
      : "error" in outcome
        ? { ok: false, error: outcome.error }
        : isResponse(outcome.value)
          ? outcome.value
          : { ok: false, error: { code: "crashed", message: "The worker returned no result" } };
    // Quarantine (ADR 0025): consecutive failures of real runs count; test runs do not.
    if (!input.automation.simulate) {
      const failures = response.ok ? 0 : row.failure_count + 1;
      if (failures !== row.failure_count) {
        const quarantined = failures >= QUARANTINE_AFTER;
        await db
          .updateTable("core_extensions")
          .set({
            failure_count: failures,
            ...(quarantined
              ? {
                  status: "quarantined" as const,
                  status_reason: `Quarantined after ${QUARANTINE_AFTER} consecutive failed runs (last: ${
                    response.ok ? "" : response.error.message.slice(0, 200)
                  })`,
                }
              : {}),
            updated_at: new Date().toISOString(),
          })
          .where("id", "=", input.extensionId)
          .where("status", "=", "active")
          .execute();
      }
    }
    return { response, operations: run.operations, logs: run.logs, ms: outcome.ms, workerId };
  }

  /**
   * Runs a Code Mode script (ADR 0042) as `caller`: one at a time per user, in a throwaway worker
   * (`LOADER.load()`: the code is new every time). The source goes straight into the worker.
   */
  async runCode(input: { code: string; caller: CodeCaller }): Promise<CodeResult> {
    const started = Date.now();
    const empty = { logs: [], operations: [], pending: [] };
    const built = buildScript(input.code);
    if (!built.ok) {
      return {
        ok: false,
        error: { code: "syntax", message: built.message },
        ...empty,
        durationMs: Date.now() - started,
      };
    }
    const gate = this.#env.CODE_MODE_GATE.getByName(input.caller.user.id);
    const lease = await gate.acquire(this.#codeTimeoutMs + 5_000);
    if (!lease) {
      return {
        ok: false,
        error: {
          code: "concurrency_limit",
          message: "Another Code Mode script of yours is still running; wait for it to finish",
        },
        ...empty,
        durationMs: Date.now() - started,
      };
    }
    const run: RunState = {
      runId: `code-${crypto.randomUUID()}`,
      extensionId: "(code)",
      code: { caller: input.caller, pending: [], calls: 0 },
      modules: new Set(["crm", ...GATEKEEPER_MODULES]),
      user: input.caller.user,
      permissions: { read: [], write: [], operations: [], modules: ["crm"] },
      deadline: Date.now() + this.#codeTimeoutMs,
      logs: [],
      operations: [],
    };
    const host = new RunHost(this.#env, run);
    let worker: WorkerStub | undefined;
    let outcome: Awaited<
      ReturnType<typeof invoke<CodeEntrypoint, Awaited<ReturnType<CodeEntrypoint["run"]>>>>
    >;
    try {
      worker = this.#loader.load(codeWorkerCode(built.script));
      outcome = await invoke<CodeEntrypoint, Awaited<ReturnType<CodeEntrypoint["run"]>>>(
        worker,
        this.#codeTimeoutMs,
        (ep) => ep.run(host),
        host,
      );
    } finally {
      dispose(worker);
      await gate.release(lease);
    }
    const response =
      "error" in outcome
        ? { ok: false as const, error: outcome.error }
        : isResponse(outcome.value)
          ? outcome.value
          : {
              ok: false as const,
              error: { code: "crashed", message: "The script returned no result" },
            };
    const logs = ("logs" in response && Array.isArray(response.logs) ? response.logs : []).map(
      (l) => ({
        level: (["log", "info", "warn", "error"].includes(l.level) ? l.level : "log") as
          | "log"
          | "info"
          | "warn"
          | "error",
        message: String(l.message),
      }),
    );
    let truncated = Boolean("dropped" in response && response.dropped);
    let value: unknown;
    if (response.ok) {
      value = response.value;
      const size = JSON.stringify(value ?? null).length;
      if (size > CODE_MAX_VALUE_BYTES) {
        truncated = true;
        value = {
          truncated: true,
          bytes: size,
          preview: JSON.stringify(value).slice(0, 2_000),
          message: `The result is larger than ${CODE_MAX_VALUE_BYTES} bytes; return less (e.g. counts or ids)`,
        };
      }
    }
    return {
      ok: response.ok,
      ...(response.ok ? { value: value ?? null } : { error: response.error }),
      logs,
      operations: run.operations,
      pending: run.code?.pending ?? [],
      durationMs: Date.now() - started,
      ...(truncated ? { truncated: true } : {}),
    };
  }

  /**
   * The AI summary of a proposal (model role `build`), cached by (extension, commit, base) in the
   * workspace DO; the model runs here, not in the DO. Null without AI or when the call fails.
   */
  async describeChange(input: {
    id: string;
    commit: string;
    base: string | null;
    prompt: string;
  }): Promise<{ text: string; model: string } | null> {
    const ws = workspaceStub(this.#env);
    const cached = await ws.cachedSummary(input.id, input.commit, input.base);
    if (cached) return cached;
    let summary: { text: string; model: string } | null = null;
    try {
      summary = await runBuildRole(this.#env, input.prompt);
    } catch (error) {
      console.error("build role failed", error);
      return null;
    }
    if (summary) await ws.storeSummary(input.id, input.commit, input.base, summary);
    return summary;
  }
}
