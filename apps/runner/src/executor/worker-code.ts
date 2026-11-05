// What the executor hands Worker Loader (ADR 0043): the Dynamic Worker code for an extension
// build, its fixed entry module, and the stable loader ids.
//
// The code of a reused worker must never depend on a run. So the entry module is fixed text plus
// the build and the declared host-module set (both part of the id). Everything per run (the tool,
// its input, the principal, the run id, the deadline) arrives as RPC arguments: the request, and a
// per-run `host` RpcTarget that is the only way to reach the CRM. Nothing in the entry patches
// globals (Date, Math.random, timers, fetch, console), so a warm isolate starts every run the same.
//
// scripts/bundle.mjs hashes this file into RUNTIME_HASH, so editing the entry changes every id.
import {
  GATEKEEPER_MODULES,
  type GatekeeperModuleName,
  SUPPORTED_CONTRACT_VERSIONS,
} from "@relationship-os/sdk";
import { SDK_SPECIFIER } from "../extensions/build.ts";
import {
  CHECKER_HASH,
  RUNTIME_HASH,
  SDK_HASH,
  TYPESCRIPT_VERSION,
} from "../generated/runtime-meta.ts";
import SDK_BUNDLE from "../generated/sdk-bundle.txt";

export { SDK_BUNDLE, SDK_SPECIFIER };

/** Pinned for every Dynamic Worker; part of each id. No flags: extension code needs no Node APIs. */
export const COMPATIBILITY_DATE = "2026-10-01";
export const COMPATIBILITY_FLAGS: readonly string[] = [];
const ENTRY = "ros-entry.js";
/** The SDK bundle's module name (workerd resolves bare specifiers per directory, so modules
 * import it by a relative path; see sdkImports). */
const SDK_MODULE = "ros-sdk.js";
const EXT_DIR = "ext";
// `crm-sdk`: modules built before the rename (ADR 0190) and still in a build cache.
const SDK_IMPORT_RE = new RegExp(
  `(\\b(?:from|import)\\s*)(["'])(?:${SDK_SPECIFIER}|crm-sdk)\\2`,
  "g",
);

/** Points a built module's `ros-sdk` imports (build.ts writes them) at the root SDK module. */
function sdkImports(path: string, code: string): string {
  const depth = path.split("/").length; // ext/ plus any subdirectories
  const relative = `${"../".repeat(depth)}${SDK_MODULE}`;
  return code.replace(
    SDK_IMPORT_RE,
    (_m, head: string, quote: string) => `${head}${quote}${relative}${quote}`,
  );
}

/** The methods each host module exposes (the raw `codemode:*` shape the SDK's buildContext reads). */
const GATEKEEPER_METHODS = ["connections", "call", "types"] as const;

export const HOST_METHODS = {
  crm: ["call"],
  storage: ["get", "set", "del", "list"],
  log: ["write"],
  ai: ["summarise", "extract", "classify"],
  // `codemode:<gatekeeper>` (stage 6a): one module per shipped gatekeeper.
  ...(Object.fromEntries(GATEKEEPER_MODULES.map((m) => [m, GATEKEEPER_METHODS])) as Record<
    GatekeeperModuleName,
    typeof GATEKEEPER_METHODS
  >),
} as const;

export function isGatekeeperModule(name: string): name is GatekeeperModuleName {
  return (GATEKEEPER_MODULES as readonly string[]).includes(name);
}
export type HostModule = keyof typeof HOST_METHODS;

export function isHostModule(name: string): name is HostModule {
  return Object.hasOwn(HOST_METHODS, name);
}

/** The declared host modules, deduplicated and sorted (what goes into the id and the entry). */
export function moduleSet(modules: readonly string[]): HostModule[] {
  return [...new Set(modules)].filter(isHostModule).sort();
}

/**
 * The fixed entry module. `runTool(request, host)`: `request` is { tool, input, version }, `host`
 * is the per-run RpcTarget whose `call(module, method, args)` serves the declared modules only.
 * `runAutomation(request, host)` (ADR 0130): `request` is an AutomationRunRequest (one advance,
 * or a whole test run); same worker, same stable id as the extension's tools.
 */
export function entryModule(modules: readonly HostModule[]): string {
  const methods = Object.fromEntries(modules.map((m) => [m, HOST_METHODS[m]]));
  return `import { WorkerEntrypoint } from "cloudflare:workers";
import { isExtension, runAutomation, runExtension } from "./${SDK_MODULE}";
import extension from "./${EXT_DIR}/index.js";
const METHODS = ${JSON.stringify(methods)};
const NOT_AN_EXTENSION = { ok: false, error: { code: "entry", message: "index.ts must export default defineExtension({...})" } };
function hostModules(host) {
  const raw = {};
  for (const [name, list] of Object.entries(METHODS)) {
    const mod = {};
    for (const method of list) mod[method] = (...args) => host.call(name, method, args);
    raw[name] = mod;
  }
  return raw;
}
export default class extends WorkerEntrypoint {
  async evaluateManifest() {
    if (!isExtension(extension)) return NOT_AN_EXTENSION;
    return runExtension(extension, { kind: "manifest" }, {});
  }
  async runTool(request, host) {
    if (!isExtension(extension)) return NOT_AN_EXTENSION;
    return runExtension(
      extension,
      { kind: "tool", tool: request.tool, input: request.input, version: request.version },
      hostModules(host),
    );
  }
  async runAutomation(request, host) {
    if (!isExtension(extension)) return NOT_AN_EXTENSION;
    return runAutomation(extension, request, hostModules(host));
  }
}
`;
}

/** The Dynamic Worker for a build: the entry, the SDK and the extension's modules under ext/. */
export function extensionWorkerCode(
  built: Record<string, string>,
  modules: readonly HostModule[],
): WorkerLoaderWorkerCode {
  const code: Record<string, string> = {
    [ENTRY]: entryModule(modules),
    [SDK_MODULE]: SDK_BUNDLE,
  };
  for (const [path, text] of Object.entries(built)) {
    code[`${EXT_DIR}/${path}`] = sdkImports(path, text);
  }
  return {
    compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: [...COMPATIBILITY_FLAGS],
    mainModule: ENTRY,
    modules: code,
    // No network (ADR 0025): fetch() and connect() throw. No bindings either: the per-run host
    // RpcTarget, passed as an argument, is the only way out.
    globalOutbound: null,
    env: {},
  };
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A content hash of source files (path order independent). */
export function contentHash(files: Record<string, string>): Promise<string> {
  return sha256(JSON.stringify(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))));
}

/** What every extension worker id shares: the runtime, the SDK, the contract and compatibility. */
function runtimeKey() {
  return {
    runtime: RUNTIME_HASH,
    sdk: SDK_HASH,
    contract: SUPPORTED_CONTRACT_VERSIONS,
    compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: COMPATIBILITY_FLAGS,
  };
}

/**
 * The stable id of an extension tool worker: extension id + commit + the declared host modules +
 * the runtime key. The same inputs always give the same id and the same code (a commit's build is
 * deterministic for a given RUNTIME_HASH); any change gives a new id.
 */
export async function toolWorkerId(input: {
  extensionId: string;
  commit: string;
  modules: readonly string[];
}): Promise<string> {
  const modules = moduleSet(input.modules);
  const key = await sha256(
    JSON.stringify({
      kind: "tool",
      ext: input.extensionId,
      commit: input.commit,
      modules,
      ...runtimeKey(),
    }),
  );
  return `ext:${input.extensionId}:${input.commit.slice(0, 12)}:${key.slice(0, 32)}`;
}

/**
 * The stable id of a manifest-evaluation worker: extension id + the source's content hash (so
 * `extension.check` on a working copy and `extension.propose` of the same files share it) + the
 * runtime key. It has no host modules.
 */
export async function manifestWorkerId(input: {
  extensionId: string;
  sourceHash: string;
}): Promise<string> {
  const key = await sha256(
    JSON.stringify({
      kind: "manifest",
      ext: input.extensionId,
      source: input.sourceHash,
      ...runtimeKey(),
    }),
  );
  return `manifest:${input.extensionId}:${key.slice(0, 32)}`;
}

/** The type checker's worker id: the compiler version plus a hash of the bundled checker. */
export function checkerWorkerId(): string {
  return `tsc@${TYPESCRIPT_VERSION}+${CHECKER_HASH.slice(0, 16)}`;
}

/** The key a build is cached under: the source plus everything the build and check depend on. */
export async function buildKey(sourceHash: string): Promise<string> {
  return sha256(
    JSON.stringify({ source: sourceHash, runtime: RUNTIME_HASH, checker: CHECKER_HASH }),
  );
}
