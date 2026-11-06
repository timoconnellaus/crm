// Saved A2UI producers (ADR 0346): a script that reads the CRM as the viewer and returns a card,
// with no model. Unlike a Code Mode script, the same code runs again and again, so it gets a stable
// `LOADER.get` id (ADR 0043), and the cached worker serves every viewer. That sets the rules:
// - the entry patches no globals and keeps nothing in module scope: the viewer's host arrives as
//   an argument of each run, so two people's runs on one warm worker can never mix;
// - the script imports nothing; `crm` is handed to its default export;
// - there is no network and there are no bindings, and the run host answers only read operations.
import { transform } from "sucrase";
import { COMPATIBILITY_DATE, sha256 } from "../executor/worker-code.ts";
import type { ScriptBuild } from "./code-mode.ts";

const ENTRY = "entry.js";
const SCRIPT = "script.js";

export const PRODUCER_ENTRY = `import { WorkerEntrypoint } from "cloudflare:workers";
import script from "./script.js";
function client(host) {
  return {
    async call(operation, input) {
      const reply = await host.call("crm", "call", [String(operation), input ?? {}]);
      if (reply && reply.ok) return reply.value;
      const failure = (reply && reply.error) || { code: "internal", message: "No reply" };
      const error = new Error(failure.message);
      error.code = failure.code;
      throw error;
    },
  };
}
export default class extends WorkerEntrypoint {
  async run(request, host) {
    try {
      const value = await script(request.input, {
        crm: client(host),
        now: request.now,
        timezone: request.timezone,
      });
      return { ok: true, value: value === undefined ? null : JSON.parse(JSON.stringify(value)) };
    } catch (error) {
      return {
        ok: false,
        error: { code: (error && error.code) || "script_error", message: String((error && error.message) || error) },
      };
    }
  }
}
`;

/** Transpiles a producer's script (TypeScript allowed). It may import nothing. */
export function buildProducer(source: string): ScriptBuild {
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
  if (/\bimport\b\s*[("'{*\w]|\brequire\s*\(/.test(code.replace(/`[\s\S]*?`/g, "``"))) {
    return { ok: false, message: "A producer imports nothing; use the crm it is given" };
  }
  return { ok: true, script: code };
}

/**
 * The stable id of a producer version: its name and version, plus a hash of its source and of what
 * runs it. The same producer version always gives the same id and the same code.
 */
export async function producerWorkerId(ref: string, source: string): Promise<string> {
  const key = await sha256(
    JSON.stringify({ kind: "producer", ref, source, entry: PRODUCER_ENTRY, COMPATIBILITY_DATE }),
  );
  return `a2ui:${ref}:${key.slice(0, 32)}`;
}

export function producerWorkerCode(script: string): WorkerLoaderWorkerCode {
  return {
    compatibilityDate: COMPATIBILITY_DATE,
    mainModule: ENTRY,
    modules: { [ENTRY]: PRODUCER_ENTRY, [SCRIPT]: script },
    // No network (ADR 0025); the per-run host RpcTarget is the only way out.
    globalOutbound: null,
    env: {},
  };
}
