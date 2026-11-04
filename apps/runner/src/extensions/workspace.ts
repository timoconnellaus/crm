// The extension workspace (ADR 0006, ADR 0025): one Durable Object holding an @cloudflare/computer
// Workspace. Each extension's source lives in its own git repository at /extensions/<id>/; a
// commit is a version and rollback reinstalls an earlier commit. Code runs in Worker Loader
// Dynamic Workers (the worker-javascript backend) with globalOutbound: null and read-only
// filesystem access; it reaches the CRM only through the host modules below.
//
// Host modules are configured once on the backend, so they find the running extension through
// `#current`. Executions are serialised by `#queue` (one at a time, which is also the Workspace's
// default), so `#current` always belongs to the execution making the call.
import { DurableObject } from "cloudflare:workers";
import { Workspace, type WorkspaceRuntimeValue } from "@cloudflare/computer";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";
import { createGitClient } from "@cloudflare/computer/git";
import {
  type ActingUser,
  type EvaluateResult,
  type ExtensionHost,
  type ExtensionVersion,
  invokeByName,
  parseFloor,
  type RunToolInput,
  type RunToolResult,
  type ShippedExtension,
  type SourceIssue,
  toOperationError,
} from "@crm/core";
import { createCrmDb } from "@crm/db";
import type { ExtensionManifest, HostModuleName, RunResponse } from "@crm/sdk";
import { SDK_BUNDLE } from "../generated/sdk-bundle.ts";
import { SHIPPED_EXTENSIONS } from "../generated/shipped.ts";
import { runModelRole } from "./ai.ts";
import { buildExtension, entrySource, SDK_SPECIFIER } from "./build.ts";
import { recordRun } from "./runs.ts";

/** Consecutive failed runs that quarantine an extension (ADR 0025). */
export const QUARANTINE_AFTER = 3;
const TOOL_TIMEOUT_MS = 30_000;
const MANIFEST_TIMEOUT_MS = 10_000;
const MAX_LOGS = 200;
const IDENTITY = { name: "CRM extension workspace", email: "workspace@crm.invalid" };
/** Failures that are the caller's, not the extension's: they do not count towards quarantine. */
const CALLER_ERRORS = new Set(["invalid_input", "unknown_tool"]);

interface RunContext {
  extensionId: string;
  modules: ReadonlySet<HostModuleName>;
  user: ActingUser;
  permissions: ExtensionManifest["permissions"];
  logs: { level: string; message: string; data: unknown; at: string }[];
  operations: { operation: string; ok: boolean; code?: string; ms: number }[];
}

type Envelope =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

const extensionDir = (id: string) => `/extensions/${id}`;
const buildDir = (id: string, key: string) => `/build/${id}/${key}`;

function json(value: unknown): WorkspaceRuntimeValue {
  return JSON.parse(JSON.stringify(value ?? null)) as WorkspaceRuntimeValue;
}

export class ExtensionWorkspace extends DurableObject<Env> implements ExtensionHost {
  readonly workspace: Workspace;
  #queue: Promise<unknown> = Promise.resolve();
  #current: RunContext | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.workspace = new Workspace({
      storage: ctx.storage,
      git: createGitClient(),
      defaultGitIdentity: IDENTITY,
      backends: [
        new WorkerJavaScriptBackend({
          loader: env.LOADER,
          root: "/",
          access: "read",
          globalOutbound: null,
          defaultTimeoutMs: TOOL_TIMEOUT_MS,
          maxTimeoutMs: 60_000,
          modules: {
            [SDK_SPECIFIER]: SDK_BUNDLE,
            "codemode:crm": {
              call: (args: readonly WorkspaceRuntimeValue[]) => this.#crmCall(args),
            },
            "codemode:storage": {
              get: (args) => this.#storage("get", args),
              set: (args) => this.#storage("set", args),
              del: (args) => this.#storage("del", args),
              list: (args) => this.#storage("list", args),
            },
            "codemode:log": { write: (args) => this.#log(args) },
            "codemode:ai": {
              summarise: (args) => this.#ai("summarise", args),
              extract: (args) => this.#ai("extract", args),
              classify: (args) => this.#ai("classify", args),
            },
          },
        }),
      ],
    });
  }

  // -------------------------------------------------------------------------------------------
  // Host modules

  async #exists(path: string): Promise<boolean> {
    try {
      await this.workspace.fs.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  #context(module: HostModuleName): RunContext {
    const current = this.#current;
    if (!current) throw new Error("No extension is running");
    if (!current.modules.has(module)) {
      throw new Error(`Host module "${module}" is not declared by ${current.extensionId}`);
    }
    return current;
  }

  async #crmCall(args: readonly WorkspaceRuntimeValue[]): Promise<WorkspaceRuntimeValue> {
    const current = this.#context("crm");
    const [name, input] = args;
    const started = Date.now();
    const operation = String(name);
    let reply: Envelope;
    try {
      const db = createCrmDb(this.env.DB);
      const value = await invokeByName(operation, input ?? {}, {
        actor: "extension",
        user: current.user,
        origin: { surface: "extension", extensionId: current.extensionId },
        db,
        floor: parseFloor(this.env.APPROVAL_FLOOR),
        extension: { id: current.extensionId, permissions: current.permissions },
      });
      reply = { ok: true, value };
    } catch (error) {
      const typed = toOperationError(error);
      reply = {
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
    current.operations.push({
      operation,
      ok: reply.ok,
      ...(reply.ok ? {} : { code: reply.error.code }),
      ms: Date.now() - started,
    });
    return json(reply);
  }

  async #storage(
    op: "get" | "set" | "del" | "list",
    args: readonly WorkspaceRuntimeValue[],
  ): Promise<WorkspaceRuntimeValue> {
    const current = this.#context("storage");
    const db = createCrmDb(this.env.DB).query;
    const key = String(args[0] ?? "");
    if (op !== "list" && (key.length < 1 || key.length > 512)) {
      throw new Error("Storage keys are 1 to 512 characters");
    }
    const ext = current.extensionId;
    switch (op) {
      case "get": {
        const row = await db
          .selectFrom("core_extension_kv")
          .select("value")
          .where("extension_id", "=", ext)
          .where("key", "=", key)
          .executeTakeFirst();
        return row ? (JSON.parse(row.value) as WorkspaceRuntimeValue) : null;
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
        return rows.map((r) => ({
          key: r.key,
          value: JSON.parse(r.value) as WorkspaceRuntimeValue,
        }));
      }
    }
  }

  #log(args: readonly WorkspaceRuntimeValue[]): WorkspaceRuntimeValue {
    const current = this.#context("log");
    const [level, message, data] = args;
    if (current.logs.length < MAX_LOGS) {
      current.logs.push({
        level: ["info", "warn", "error"].includes(String(level)) ? String(level) : "info",
        message: String(message).slice(0, 2000),
        data: data ?? null,
        at: new Date().toISOString(),
      });
    }
    return null;
  }

  async #ai(
    role: "summarise" | "extract" | "classify",
    args: readonly WorkspaceRuntimeValue[],
  ): Promise<WorkspaceRuntimeValue> {
    this.#context("ai");
    return json(await runModelRole(this.env, role, args));
  }

  // -------------------------------------------------------------------------------------------
  // Execution

  /** Runs `task` after every earlier execution has finished. */
  #serialise<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(task, task);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #exec(
    source: string,
    request: WorkspaceRuntimeValue,
    timeoutMs: number,
  ): Promise<{ response: RunResponse; ms: number; timedOut: boolean }> {
    const started = Date.now();
    const handle = await this.workspace.runtime.exec(source, {
      backend: "worker-javascript",
      encoding: "utf8",
      input: request,
      timeoutMs,
    });
    const result = await handle.result();
    const ms = Date.now() - started;
    if (result.status === "completed" && result.value && typeof result.value === "object") {
      return { response: result.value as unknown as RunResponse, ms, timedOut: false };
    }
    const stderr = (result.stderr ?? "").trim();
    const timedOut = /timed out/i.test(stderr);
    return {
      response: {
        ok: false,
        error: {
          code: timedOut ? "timeout" : "crashed",
          message: stderr.split("\n").slice(-3).join("\n") || `Execution ${result.status}`,
        },
      },
      ms,
      timedOut,
    };
  }

  async #filesAt(id: string, commit: string): Promise<Record<string, string>> {
    const dir = extensionDir(id);
    const files: Record<string, string> = {};
    const walk = async (path: string) => {
      const entries = await this.workspace.git.lsTree({
        dir,
        ref: commit,
        ...(path ? { path } : {}),
      });
      for (const entry of entries) {
        const full = path ? `${path}/${entry.path}` : entry.path;
        if (entry.type === "tree") await walk(full);
        else if (entry.type === "blob") {
          const blob = await this.workspace.git.catFile({ dir, oid: entry.oid });
          files[full] = new TextDecoder().decode(blob.bytes);
        }
      }
    };
    await walk("");
    return files;
  }

  /** Builds (or reuses) `/build/<id>/<key>/`. */
  async #prepare(
    id: string,
    key: string,
    files: () => Promise<Record<string, string>>,
  ): Promise<{ ok: true; dir: string } | { ok: false; issues: SourceIssue[] }> {
    const dir = buildDir(id, key);
    if (await this.#exists(`${dir}/.built`)) return { ok: true, dir };
    const built = buildExtension(await files());
    if (!built.ok) return built;
    await this.workspace.fs.rm(dir, { recursive: true, force: true });
    for (const [path, code] of Object.entries(built.modules)) {
      const target = `${dir}/${path}`;
      await this.workspace.fs.mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
      await this.workspace.fs.writeFile(target, code);
    }
    await this.workspace.fs.writeFile(`${dir}/.built`, new Date().toISOString());
    return { ok: true, dir };
  }

  // -------------------------------------------------------------------------------------------
  // ExtensionHost

  async commit(input: {
    id: string;
    files: Record<string, string>;
    message: string;
    author: { name: string; email: string };
  }): Promise<{ commit: string; changed: boolean }> {
    return this.#serialise(() => this.#commit(input.id, input.files, input.message, input.author));
  }

  async #commit(
    id: string,
    files: Record<string, string>,
    message: string,
    author: { name: string; email: string },
  ): Promise<{ commit: string; changed: boolean }> {
    if (!/^[a-z][a-z0-9]{1,29}$/.test(id)) throw new Error(`Invalid extension id ${id}`);
    const dir = extensionDir(id);
    const fs = this.workspace.fs;
    const git = this.workspace.git;
    if (!(await this.#exists(`${dir}/.git`))) {
      await fs.mkdir(dir, { recursive: true });
      await git.init({ dir });
    }
    const existing = (await git.lsFiles({ dir })).filter((p) => !Object.hasOwn(files, p));
    for (const path of existing) {
      await fs.rm(`${dir}/${path}`, { force: true });
    }
    if (existing.length) await git.rm({ dir, paths: existing });
    for (const [path, text] of Object.entries(files)) {
      if (path.split("/").some((part) => part === ".." || part === "" || part === ".git")) {
        throw new Error(`Invalid file path ${path}`);
      }
      const target = `${dir}/${path}`;
      await fs.mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
      await fs.writeFile(target, text);
    }
    await git.add({ dir, paths: Object.keys(files) });
    const status = await git.status({ dir });
    const head = await git.log({ dir, depth: 1 }).catch(() => []);
    if (!status.length && head[0]) return { commit: head[0].oid, changed: false };
    const { oid } = await git.commit({ dir, message, author });
    return { commit: oid, changed: true };
  }

  async shipped(): Promise<ShippedExtension[]> {
    return SHIPPED_EXTENSIONS.map(({ id, version }) => ({ id, version }));
  }

  async commitShipped(id: string): Promise<{ commit: string; changed: boolean }> {
    const shipped = SHIPPED_EXTENSIONS.find((s) => s.id === id);
    if (!shipped) throw new Error(`No shipped extension ${id}`);
    return this.commit({
      id,
      files: shipped.files,
      message: `Shipped ${id} ${shipped.version}`,
      author: IDENTITY,
    });
  }

  async evaluate(
    input: { id: string; commit: string } | { id: string; files: Record<string, string> },
  ): Promise<EvaluateResult> {
    return this.#serialise(async () => {
      const commit = "commit" in input ? input.commit : null;
      const key = commit ?? `check-${crypto.randomUUID()}`;
      let prepared: { ok: true; dir: string } | { ok: false; issues: SourceIssue[] };
      try {
        prepared = await this.#prepare(input.id, key, async () =>
          "files" in input ? input.files : this.#filesAt(input.id, input.commit),
        );
      } catch (error) {
        return {
          ok: false,
          commit,
          issues: [
            {
              code: "entry",
              path: "(root)",
              message: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
      if (!prepared.ok) return { ok: false, commit, issues: prepared.issues };
      try {
        const { response, ms } = await this.#exec(
          entrySource(prepared.dir, []),
          { kind: "manifest" },
          MANIFEST_TIMEOUT_MS,
        );
        if (commit) {
          await recordRun(this.env, {
            extensionId: input.id,
            commit,
            kind: "manifest",
            name: null,
            caller: null,
            ms,
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
      } finally {
        if (!commit) await this.workspace.fs.rm(prepared.dir, { recursive: true, force: true });
      }
    });
  }

  async runTool(input: RunToolInput): Promise<RunToolResult> {
    return this.#serialise(() => this.#runTool(input));
  }

  async #runTool(input: RunToolInput): Promise<RunToolResult> {
    const db = createCrmDb(this.env.DB).query;
    const row = await db
      .selectFrom("core_extensions as e")
      .innerJoin("core_user as u", "u.id", "e.user_id")
      .select(["e.status", "e.manifest", "e.failure_count", "u.id as user_id", "u.email", "u.name"])
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
    const prepared = await this.#prepare(input.id, input.commit, () =>
      this.#filesAt(input.id, input.commit),
    );
    const context: RunContext = {
      extensionId: input.id,
      modules: new Set(manifest.permissions.modules),
      user: { id: row.user_id, email: row.email, name: row.name, role: "member" },
      permissions: manifest.permissions,
      logs: [],
      operations: [],
    };
    let response: RunResponse;
    let ms = 0;
    if (!prepared.ok) {
      response = {
        ok: false,
        error: { code: "build", message: prepared.issues.map((i) => i.message).join("; ") },
      };
    } else {
      this.#current = context;
      try {
        ({ response, ms } = await this.#exec(
          entrySource(prepared.dir, [...context.modules]),
          json({ kind: "tool", tool: input.tool, input: input.input, version: manifest.version }),
          TOOL_TIMEOUT_MS,
        ));
      } finally {
        this.#current = null;
      }
    }
    const counts = !response.ok && !CALLER_ERRORS.has(response.error.code);
    const failures = response.ok ? 0 : counts ? row.failure_count + 1 : row.failure_count;
    const quarantined = failures >= QUARANTINE_AFTER;
    const runId = await recordRun(this.env, {
      extensionId: input.id,
      commit: input.commit,
      kind: "tool",
      name: input.tool,
      caller: input.caller,
      ms,
      response,
      logs: context.logs,
      operations: context.operations,
    });
    const now = new Date().toISOString();
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
        updated_at: now,
      })
      .where("id", "=", input.id)
      .where("status", "=", "active")
      .execute();
    if (response.ok) return { ok: true, value: response.value, runId };
    return { ok: false, error: response.error, runId, quarantined };
  }

  async versions(id: string): Promise<ExtensionVersion[]> {
    const dir = extensionDir(id);
    if (!(await this.#exists(`${dir}/.git`))) return [];
    const log = await this.workspace.git.log({ dir });
    return log.map((c) => ({
      commit: c.oid,
      message: c.message.trim(),
      at: new Date(c.committer.timestamp * 1000).toISOString(),
    }));
  }

  async files(id: string, commit: string): Promise<Record<string, string>> {
    return this.#filesAt(id, commit);
  }
}
