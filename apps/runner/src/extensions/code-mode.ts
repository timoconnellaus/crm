// Code Mode scripts (ADR 0042, ADR 0043): a short ES module an MCP client model writes, run in a
// throwaway Dynamic Worker (new code every time, so LOADER.load() with no id) with no network,
// acting as the connected user. The script may import only `codemode:crm`, which is rewritten to a
// small wrapper over the per-run host RpcTarget so `crm.call` returns values and throws errors.
// The entry captures console output and returns the script's default export. Patching console is
// fine here: the worker runs once and is thrown away.
import { GATEKEEPER_MODULES } from "@crm/sdk";
import { transform } from "sucrase";

export const CODE_TIMEOUT_MS = 30_000;
export const CODE_MAX_CALLS = 100;
export const CODE_MAX_LOGS = 200;
export const CODE_MAX_VALUE_BYTES = 256_000;

export type ScriptBuild = { ok: true; script: string } | { ok: false; message: string };

const IMPORT_FROM_RE = /(\b(?:import|export)\b[^'"`;]*?\bfrom\s*)(["'])([^"'\n]+)\2/g;
const BARE_IMPORT_RE = /(\bimport\s*)(["'])([^"'\n]+)\2/g;

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

/** Transpiles the script (TypeScript allowed) and points `codemode:crm` at the wrapper. */
export function buildScript(source: string): ScriptBuild {
  let code: string;
  try {
    code = transform(source, {
      transforms: ["typescript"],
      disableESTransforms: true,
      filePath: "script.ts",
    }).code;
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const scan = stripComments(code);
  if (/\bimport\s*\(/.test(scan)) return { ok: false, message: "Dynamic import() is not allowed" };
  if (/\brequire\s*\(/.test(scan)) {
    return {
      ok: false,
      message: 'require() is not available; use import { crm } from "codemode:crm"',
    };
  }
  let bad: string | null = null;
  const rewrite = (_m: string, head: string, quote: string, specifier: string) => {
    if (specifier === "codemode:crm") return `${head}${quote}./crm.js${quote}`;
    const gatekeeper = specifier.startsWith("codemode:") ? specifier.slice(9) : "";
    if ((GATEKEEPER_MODULES as readonly string[]).includes(gatekeeper)) {
      return `${head}${quote}./gk-${gatekeeper}.js${quote}`;
    }
    bad ??= specifier;
    return `${head}${quote}${specifier}${quote}`;
  };
  const script = code.replace(IMPORT_FROM_RE, rewrite).replace(BARE_IMPORT_RE, rewrite);
  if (bad) {
    return {
      ok: false,
      message: `Cannot import "${bad}": a Code Mode script may import only "codemode:crm" and codemode:<gatekeeper> (${GATEKEEPER_MODULES.join(", ")})`,
    };
  }
  return { ok: true, script };
}

/** Holds the run's host RpcTarget; only the entry and the wrapper import it. */
export const CRM_HOST = `let host = null;
export function bind(value) { host = value; }
export function call(operation, input) {
  if (!host) throw new Error("codemode:crm is not available until the script runs");
  return host.call("crm", "call", [operation, input]);
}
export function gatekeeper(name, method, args) {
  if (!host) throw new Error("codemode modules are not available until the script runs");
  return host.call(name, method, args);
}
`;

/** `codemode:<gatekeeper>` over the host (stage 6a): connections, call and types. */
export function gatekeeperWrapper(name: string): string {
  return `import { gatekeeper } from "./crm-host.js";
const NAME = ${JSON.stringify(name)};
export class GatekeeperCallError extends Error {
  constructor(error) { super(error.message); this.name = "GatekeeperCallError"; this.code = error.code; }
}
export function connections() { return gatekeeper(NAME, "connections", []); }
export function types(connectionId, resource) { return gatekeeper(NAME, "types", [connectionId, resource]); }
export async function call(connectionId, resource, method, ...args) {
  const reply = await gatekeeper(NAME, "call", [connectionId, resource, method, args]);
  if (reply && reply.ok) return reply.value;
  throw new GatekeeperCallError((reply && reply.error) || { code: "internal", message: "No reply" });
}
export default { connections, types, call };
`;
}

/** `crm.call` over the host: returns the value, throws a CrmCallError on failure. */
export const CRM_WRAPPER = `import * as host from "./crm-host.js";
export class CrmCallError extends Error {
  constructor(error) {
    super(error.message);
    this.name = "CrmCallError";
    this.code = error.code;
    this.details = error.details;
  }
}
async function call(operation, input) {
  const reply = await host.call(String(operation), input ?? {});
  if (reply && reply.ok) return reply.value;
  throw new CrmCallError((reply && reply.error) || { code: "internal", message: "No reply" });
}
export const crm = { call };
export default crm;
`;

/** The entry: console capture, then the script's default export (called if a function). */
export const CODE_ENTRY = `import { WorkerEntrypoint } from "cloudflare:workers";
import { bind } from "./crm-host.js";
import * as script from "./script.js";
const MAX_LOGS = ${CODE_MAX_LOGS};
async function main() {
  const logs = [];
  let dropped = false;
  const show = (v) => {
    if (typeof v === "string") return v;
    if (v instanceof Error) return v.stack || v.message;
    try { return JSON.stringify(v); } catch { return String(v); }
  };
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    console[level] = (...args) => {
      if (logs.length >= MAX_LOGS) { dropped = true; return; }
      logs.push({ level: level === "debug" ? "log" : level, message: args.map(show).join(" ").slice(0, 2000) });
    };
  }
  try {
    let value = script.default;
    value = typeof value === "function" ? await value() : await value;
    return { ok: true, value: value === undefined ? null : JSON.parse(JSON.stringify(value)), logs, dropped };
  } catch (error) {
    return {
      ok: false,
      error: { code: (error && error.code) || "script_error", message: String((error && error.message) || error) },
      logs,
      dropped,
    };
  }
}
export default class extends WorkerEntrypoint {
  async run(host) {
    bind(host);
    return main();
  }
}
`;

/** The throwaway worker for one script: new code every run, so LOADER.load() with no id. */
export function codeWorkerCode(script: string): WorkerLoaderWorkerCode {
  return {
    compatibilityDate: "2026-10-01",
    mainModule: "entry.js",
    modules: {
      "entry.js": CODE_ENTRY,
      "script.js": script,
      "crm.js": CRM_WRAPPER,
      "crm-host.js": CRM_HOST,
      ...Object.fromEntries(GATEKEEPER_MODULES.map((g) => [`gk-${g}.js`, gatekeeperWrapper(g)])),
    },
    // No network (ADR 0025); the per-run host RpcTarget is the only way out.
    globalOutbound: null,
    env: {},
  };
}
