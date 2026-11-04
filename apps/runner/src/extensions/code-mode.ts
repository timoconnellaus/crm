// Code Mode scripts (ADR 0042): a short ES module an MCP client model writes, run in a Dynamic Worker
// like extension code (no network, read-only filesystem) but acting as the connected user. The
// script may import only `codemode:crm`, which is rewritten to a small wrapper over the raw host
// module so `crm.call` returns values and throws errors. The entry module captures console output
// and returns the script's default export.
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
    bad ??= specifier;
    return `${head}${quote}${specifier}${quote}`;
  };
  const script = code.replace(IMPORT_FROM_RE, rewrite).replace(BARE_IMPORT_RE, rewrite);
  if (bad) {
    return {
      ok: false,
      message: `Cannot import "${bad}": a Code Mode script may import only "codemode:crm"`,
    };
  }
  return { ok: true, script };
}

/** `crm.call` over the raw host module: returns the value, throws a CrmCallError on failure. */
export const CRM_WRAPPER = `import * as host from "codemode:crm";
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

/** The per-run entry: console capture, then the script's default export (called if a function). */
export function codeEntry(dir: string): string {
  return `import * as script from "${dir}/script.js";
const MAX_LOGS = ${CODE_MAX_LOGS};
export default async () => {
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
};
`;
}
