// The sandbox side of the runtime. The host generates a small entry module per run that imports
// the extension and the host modules it declared, and calls `runExtension`. Tool handlers get a
// `ctx` built from those modules; a module the extension did not declare is absent, and using it
// throws.
import type {
  AiModule,
  CrmModule,
  Extension,
  ExtensionContext,
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
  return { extension: { id: extension.id, version: extension.version }, crm, storage, log, ai };
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
