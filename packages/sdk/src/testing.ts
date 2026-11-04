// @crm/sdk/testing: unit-test an extension locally with in-memory host modules.
//
//   const host = createTestHost(extension, { records: { organisation: [{ id: "org_1", name: "Acme" }] } });
//   expect(host.issues).toEqual([]);
//   const out = await host.runTool("scoreOrganisation", { organisationId: "org_1" });
//   expect(host.calls).toContainEqual({ operation: "record.get", input: { ... } });
//
// The in-memory `crm` module enforces the extension's declared permissions with the host's rules
// (`checkGrant`) and implements the generic record operations over an in-memory store. Pass
// `operations` to fake anything else.
import type { AiModule, Extension } from "./contract.ts";
import type { ExtensionManifest, ManifestIssue, ValidateOptions } from "./manifest.ts";
import { CORE_OBJECT_NAMES, toManifest, validateManifest } from "./manifest.ts";
import { checkGrant } from "./permissions.ts";
import { type RawHostModules, runExtension } from "./runtime.ts";

type Values = Record<string, unknown> & { id: string };
type OperationFake = (input: Record<string, unknown>) => unknown;

export interface TestHostOptions {
  /** Seed records by object name (`organisation`, `example.project`). */
  records?: Record<string, Values[]>;
  /** Fakes for operations the harness does not implement, by name. */
  operations?: Record<string, OperationFake>;
  /** Fakes for the AI module. Default: deterministic stand-ins. */
  ai?: Partial<AiModule>;
  /** Passed to validateManifest. */
  validate?: ValidateOptions;
}

export class ExtensionToolError extends Error {
  override name = "ExtensionToolError";
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface TestHost {
  manifest: ExtensionManifest;
  /** Contract and formula issues (`extension.check` minus typecheck and dry-run reconcile). */
  issues: ManifestIssue[];
  /** Runs a tool like the host does: input and output validated, ctx from in-memory modules. */
  runTool<T = unknown>(tool: string, input: unknown): Promise<T>;
  /** Every codemode:crm call, in order (allowed or refused). */
  calls: { operation: string; input: unknown; allowed: boolean }[];
  logs: { level: string; message: string; data: unknown }[];
  storage: Map<string, unknown>;
  records: Map<string, Map<string, Values>>;
}

function riskOf(operation: string): string {
  const verb = operation.split(".").at(-1) ?? "";
  if (/^(get|list|search|listForRecord|listMine)$/.test(verb)) return "read";
  if (/^(delete|erase|merge|deleteMany)$/.test(verb)) return "destructive";
  return "write";
}

function objectOf(operation: string, input: Record<string, unknown>): string | null {
  if (operation.startsWith("record."))
    return typeof input.object === "string" ? input.object : null;
  const prefix = operation.split(".")[0] ?? "";
  return (CORE_OBJECT_NAMES as readonly string[]).includes(prefix) ? prefix : null;
}

let sequence = 0;

export function createTestHost(extension: Extension, options: TestHostOptions = {}): TestHost {
  const { manifest: validated, issues } = validateManifest(toManifest(extension), options.validate);
  const manifest = validated ?? toManifest(extension);
  const records = new Map<string, Map<string, Values>>();
  for (const [object, rows] of Object.entries(options.records ?? {})) {
    records.set(object, new Map(rows.map((row) => [row.id, { ...row }])));
  }
  const table = (object: string) => {
    let rows = records.get(object);
    if (!rows) {
      rows = new Map();
      records.set(object, rows);
    }
    return rows;
  };
  const calls: TestHost["calls"] = [];
  const logs: TestHost["logs"] = [];
  const storage = new Map<string, unknown>();

  const builtIn: Record<string, OperationFake> = {
    "record.create": (input) => {
      sequence += 1;
      const id = `rec_test${sequence}`;
      const row = { ...(input.values as Record<string, unknown>), id };
      table(String(input.object)).set(id, row);
      return row;
    },
    "record.get": (input) => {
      const row = table(String(input.object)).get(String(input.id));
      if (!row) throw new ExtensionToolError("not_found", `No ${input.object} with id ${input.id}`);
      return row;
    },
    "record.update": (input) => {
      const rows = table(String(input.object));
      const row = rows.get(String(input.id));
      if (!row) throw new ExtensionToolError("not_found", `No ${input.object} with id ${input.id}`);
      const next = { ...row, ...(input.values as Record<string, unknown>), id: row.id };
      rows.set(row.id, next);
      return next;
    },
    "record.delete": (input) => {
      table(String(input.object)).delete(String(input.id));
      return { id: input.id };
    },
    "record.list": (input) => ({
      items: [...table(String(input.object)).values()],
      nextCursor: null,
    }),
  };
  for (const object of CORE_OBJECT_NAMES) {
    builtIn[`${object}.get`] = (input) => builtIn["record.get"]?.({ ...input, object });
  }

  const has = (name: string) => manifest.permissions.modules.includes(name as never);
  const raw: RawHostModules = {};
  if (has("crm")) {
    raw.crm = {
      call: async (operation, input) => {
        const name = String(operation);
        const body = (input ?? {}) as Record<string, unknown>;
        const decision = checkGrant(manifest.id, manifest.permissions, {
          operation: name,
          risk: riskOf(name),
          object: objectOf(name, body),
        });
        calls.push({ operation: name, input: body, allowed: decision.ok });
        if (!decision.ok) throw new ExtensionToolError("forbidden", decision.reason);
        const fake = options.operations?.[name] ?? builtIn[name];
        if (!fake) throw new ExtensionToolError("unknown_operation", `No fake for ${name}`);
        return structuredClone(await fake(body));
      },
    };
  }
  if (has("storage")) {
    raw.storage = {
      get: async (key) => storage.get(String(key)) ?? null,
      set: async (key, value) => {
        storage.set(String(key), structuredClone(value));
      },
      del: async (key) => {
        storage.delete(String(key));
      },
      list: async (prefix) =>
        [...storage]
          .filter(([key]) => key.startsWith(String(prefix ?? "")))
          .map(([key, value]) => ({ key, value })),
    };
  }
  if (has("log")) {
    raw.log = {
      write: async (level, message, data) => {
        logs.push({ level: String(level), message: String(message), data });
      },
    };
  }
  if (has("ai")) {
    const ai: AiModule = {
      summarise: async (text) => String(text).slice(0, 100),
      extract: async (_text, fields) =>
        Object.fromEntries(Object.keys(fields).map((k) => [k, null])),
      classify: async (_text, labels) => ({ label: labels[0] ?? "" }),
      ...options.ai,
    };
    raw.ai = {
      summarise: (text, opts) => ai.summarise(String(text), opts as never),
      extract: (text, fields) => ai.extract(String(text), fields as Record<string, string>),
      classify: (text, labels) => ai.classify(String(text), labels as string[]),
    };
  }

  return {
    manifest,
    issues,
    calls,
    logs,
    storage,
    records,
    async runTool<T>(tool: string, input: unknown): Promise<T> {
      const response = await runExtension(extension, { kind: "tool", tool, input }, raw);
      if (!response.ok) {
        throw new ExtensionToolError(
          response.error.code,
          response.error.message,
          response.error.details,
        );
      }
      return response.value as T;
    },
  };
}
