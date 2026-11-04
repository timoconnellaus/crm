// The extension manifest: the JSON form of an extension (no handlers, tool schemas as JSON
// Schema). The host evaluates an extension in the sandbox to get its manifest, then validates,
// diffs and reconciles the manifest. `validateManifest` is the contract check `extension.check`
// runs; it returns structured issues a model can act on.
import { z } from "zod";
import {
  type Extension,
  HOST_MODULES,
  type HostModuleName,
  SUPPORTED_CONTRACT_VERSIONS,
  TOOL_RISKS,
} from "./contract.ts";
import { FIELD_TYPES, type FieldTypeName, formulaTypeOf } from "./field-types.ts";
import { checkFormula, type FormulaFieldRef } from "./formula/compile.ts";

export const EXTENSION_ID_RE = /^[a-z][a-z0-9]{1,29}$/;
export const OBJECT_NAME_RE = /^[a-z][a-z0-9]{0,29}$/;
export const FIELD_NAME_RE = /^[a-z][a-zA-Z0-9]{0,39}$/;
export const TOOL_NAME_RE = /^[a-z][a-zA-Z0-9]{0,39}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const OPERATION_RE = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

/** Core objects extension fields can target, and which extension objects may not be named. */
export const CORE_OBJECT_NAMES = ["person", "organisation", "activity", "task"] as const;
const RESERVED_OBJECT_NAMES = new Set([
  ...CORE_OBJECT_NAMES,
  "affiliation",
  "user",
  "users",
  "tag",
  "tags",
  "view",
  "audit",
  "record",
]);
const RESERVED_EXTENSION_IDS = new Set([
  "core",
  "crm",
  "x",
  "sdk",
  "system",
  "record",
  "extension",
]);
/** Field names every record already has. */
export const RESERVED_FIELD_NAMES = new Set([
  "id",
  "createdAt",
  "updatedAt",
  "deletedAt",
  "createdBy",
  "deletedBy",
  "tags",
  "title",
]);
/** Operation prefixes no extension may be granted. */
export const FORBIDDEN_OPERATION_PREFIXES = ["extension.", "policy.", "user.", "audit."] as const;
const TEXT_LIKE: FieldTypeName[] = ["text", "email", "phone", "url", "select"];
/** Objects relations may point at. */
export const RELATION_CORE_TARGETS = ["person", "organisation", "task"] as const;

const optionSchema = z.object({
  value: z.string().min(1).max(100),
  label: z.string().min(1).max(100),
  color: z.string().max(20).optional(),
});

export const fieldManifestSchema = z.object({
  type: z.enum(FIELD_TYPES),
  label: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
  track: z.literal("timeline").optional(),
  renamedFrom: z.string().max(40).optional(),
  required: z.boolean().optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  options: z.array(optionSchema).max(200).optional(),
  to: z.string().max(80).optional(),
  many: z.boolean().optional(),
  expression: z.string().max(2000).optional(),
});
export type FieldManifest = z.infer<typeof fieldManifestSchema>;

export const objectManifestSchema = z.object({
  label: z.string().min(1).max(100),
  plural: z.string().min(1).max(100),
  icon: z.string().max(60).optional(),
  titleField: z.string().max(40),
  description: z.string().max(1000).optional(),
  renamedFrom: z.string().max(40).optional(),
  fields: z.record(z.string(), fieldManifestSchema),
});
export type ObjectManifest = z.infer<typeof objectManifestSchema>;

const jsonSchemaObject = z.record(z.string(), z.unknown());

export const toolManifestSchema = z.object({
  description: z.string().min(20).max(2000),
  risk: z.enum(TOOL_RISKS),
  inputSchema: jsonSchemaObject,
  outputSchema: jsonSchemaObject,
});
export type ToolManifest = z.infer<typeof toolManifestSchema>;

export const viewManifestSchema = z.object({
  label: z.string().min(1).max(100),
  object: z.string().max(80),
  filter: z.unknown().optional(),
  sort: z
    .object({ field: z.string().max(64), direction: z.enum(["asc", "desc"]).default("asc") })
    .optional(),
  columns: z.array(z.string().max(80)).max(100).optional(),
});
export type ViewManifest = z.infer<typeof viewManifestSchema>;

export const automationManifestSchema = z.object({
  description: z.string().min(1).max(2000),
  trigger: z.union([
    z.object({
      type: z.enum(["record.created", "record.updated", "record.deleted"]),
      object: z.string().max(80),
    }),
    z.object({ type: z.literal("schedule"), cron: z.string().min(9).max(100) }),
  ]),
});

export const permissionsManifestSchema = z.object({
  read: z.array(z.string().max(80)).max(100).default([]),
  write: z.array(z.string().max(80)).max(100).default([]),
  operations: z.array(z.string().max(100)).max(200).default([]),
  modules: z.array(z.enum(HOST_MODULES)).max(HOST_MODULES.length).default([]),
});
export type PermissionsManifest = z.infer<typeof permissionsManifestSchema>;

export const manifestSchema = z.object({
  id: z.string(),
  version: z.string(),
  contractVersion: z.number().int(),
  label: z.string().max(100).optional(),
  description: z.string().max(2000).optional(),
  permissions: permissionsManifestSchema.default({
    read: [],
    write: [],
    operations: [],
    modules: [],
  }),
  objects: z.record(z.string(), objectManifestSchema).default({}),
  fields: z.record(z.string(), z.record(z.string(), fieldManifestSchema)).default({}),
  views: z.record(z.string(), viewManifestSchema).default({}),
  tools: z.record(z.string(), toolManifestSchema).default({}),
  automations: z.record(z.string(), automationManifestSchema).default({}),
});
export type ExtensionManifest = z.infer<typeof manifestSchema>;

/** One problem `check` found. `path` points into the manifest, e.g. `objects.project.fields.x`. */
export interface ManifestIssue {
  code:
    | "contract"
    | "formula_syntax"
    | "formula_type"
    | "formula_unknown_field"
    | "formula_unknown_function"
    | "formula_cycle"
    | "formula_too_complex";
  path: string;
  message: string;
  /** For formula issues: the character span in the expression. */
  span?: { start: number; end: number };
}

function normaliseOptions(options: readonly unknown[] | undefined) {
  return options?.map((option) =>
    typeof option === "string"
      ? { value: option, label: option }
      : {
          ...(option as { value: string; label?: string; color?: string }),
          label: (option as { label?: string }).label ?? (option as { value: string }).value ?? "",
        },
  );
}

function fieldToManifest(spec: Record<string, unknown>): Record<string, unknown> {
  const { options, ...rest } = spec;
  return {
    ...rest,
    ...(options ? { options: normaliseOptions(options as unknown[]) } : {}),
  };
}

function fieldsToManifest(fields: Record<string, unknown> | undefined) {
  return Object.fromEntries(
    Object.entries(fields ?? {}).map(([name, spec]) => [
      name,
      fieldToManifest(spec as Record<string, unknown>),
    ]),
  );
}

/**
 * Turns a live extension into its JSON manifest. Tool schemas become JSON Schema. Runs wherever
 * the extension is loaded (the sandbox, or the testing harness).
 */
export function toManifest(extension: Extension): ExtensionManifest {
  const raw = {
    id: extension.id,
    version: extension.version,
    contractVersion: extension.contractVersion,
    ...(extension.label ? { label: extension.label } : {}),
    ...(extension.description ? { description: extension.description } : {}),
    permissions: extension.permissions ?? {},
    objects: Object.fromEntries(
      Object.entries(extension.objects ?? {}).map(([name, object]) => [
        name,
        { ...object, fields: fieldsToManifest(object.fields as Record<string, unknown>) },
      ]),
    ),
    fields: Object.fromEntries(
      Object.entries(extension.fields ?? {}).map(([target, fields]) => [
        target,
        fieldsToManifest(fields as Record<string, unknown>),
      ]),
    ),
    views: extension.views ?? {},
    tools: Object.fromEntries(
      Object.entries(extension.tools ?? {}).map(([name, tool]) => [
        name,
        {
          description: tool.description,
          risk: tool.risk ?? "write",
          inputSchema: z.toJSONSchema(tool.input, { io: "input", unrepresentable: "any" }),
          outputSchema: z.toJSONSchema(tool.output, { io: "output", unrepresentable: "any" }),
        },
      ]),
    ),
    automations: Object.fromEntries(
      Object.entries(extension.automations ?? {}).map(([name, automation]) => [
        name,
        { description: automation.description, trigger: automation.trigger },
      ]),
    ),
  };
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    // Return what we have; validateManifest reports the structural issues.
    return raw as unknown as ExtensionManifest;
  }
  return parsed.data;
}

export interface ValidateOptions {
  /**
   * Fields a formula on `object` may read, other than the extension's own fields on it: the
   * host supplies core and installed fields. Default: none.
   */
  baseFields?: (object: string) => Record<string, FormulaFieldRef>;
  /** Objects that exist outside this extension (`person`, `other.thing`). Default: core only. */
  knownObjects?: readonly string[];
}

/** Formula environment for a set of field manifests (formula fields compile on demand). */
export function formulaFields(
  fields: Record<string, FieldManifest>,
): Record<string, FormulaFieldRef> {
  const env: Record<string, FormulaFieldRef> = {};
  for (const [name, field] of Object.entries(fields)) {
    if (field.type === "formula") {
      env[name] = { expression: field.expression ?? "" };
      continue;
    }
    const type = formulaTypeOf(field.type, field.many);
    if (type) env[name] = { type, sql: `"${name}"` };
  }
  return env;
}

/**
 * The contract check: structure (zod), names, references, permissions and formulas. Returns
 * every issue found (empty when the manifest is valid) and the parsed manifest when it parsed.
 */
export function validateManifest(
  input: unknown,
  options: ValidateOptions = {},
): { manifest: ExtensionManifest | null; issues: ManifestIssue[] } {
  const issues: ManifestIssue[] = [];
  const contract = (path: string, message: string) =>
    issues.push({ code: "contract", path, message });

  const parsed = manifestSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      contract(issue.path.join(".") || "(root)", issue.message);
    }
    return { manifest: null, issues };
  }
  const m = parsed.data;

  if (!EXTENSION_ID_RE.test(m.id) || RESERVED_EXTENSION_IDS.has(m.id)) {
    contract(
      "id",
      `Extension id "${m.id}" must be 2-30 lowercase letters or digits, start with a letter, and not be reserved`,
    );
  }
  if (!SEMVER_RE.test(m.version))
    contract("version", `Version "${m.version}" must be semver, e.g. 1.0.0`);
  if (!SUPPORTED_CONTRACT_VERSIONS.includes(m.contractVersion)) {
    contract(
      "contractVersion",
      `Contract version ${m.contractVersion} is not supported (supported: ${SUPPORTED_CONTRACT_VERSIONS.join(", ")})`,
    );
  }

  const ownObjects = Object.keys(m.objects).map((name) => `${m.id}.${name}`);
  const known = new Set<string>([
    ...CORE_OBJECT_NAMES,
    ...(options.knownObjects ?? []),
    ...ownObjects,
  ]);

  const checkFields = (
    base: string,
    object: string,
    fields: Record<string, FieldManifest>,
    env: Record<string, FormulaFieldRef>,
  ) => {
    for (const [name, field] of Object.entries(fields)) {
      const path = `${base}.${name}`;
      if (!FIELD_NAME_RE.test(name)) {
        contract(
          path,
          `Field name "${name}" must be camelCase letters and digits, starting lowercase`,
        );
      }
      if (RESERVED_FIELD_NAMES.has(name)) contract(path, `"${name}" is reserved on every record`);
      if (field.renamedFrom !== undefined && !FIELD_NAME_RE.test(field.renamedFrom)) {
        contract(`${path}.renamedFrom`, "renamedFrom must be a valid field name");
      }
      if (field.renamedFrom === name)
        contract(`${path}.renamedFrom`, "renamedFrom equals the name");
      if (field.type === "select" || field.type === "multiSelect") {
        if (!field.options?.length)
          contract(`${path}.options`, `${field.type} fields need options`);
        const values = field.options?.map((o) => o.value) ?? [];
        if (new Set(values).size !== values.length) {
          contract(`${path}.options`, "Option values must be unique");
        }
      } else if (field.options) {
        contract(`${path}.options`, `Only select and multiSelect fields take options`);
      }
      if (field.type === "relation") {
        if (!field.to) contract(`${path}.to`, "relation fields need `to`");
        else if (
          !(RELATION_CORE_TARGETS as readonly string[]).includes(field.to) &&
          !(field.to.includes(".") && known.has(field.to))
        ) {
          contract(
            `${path}.to`,
            `Unknown relation target "${field.to}". Use person, organisation, task or <extension>.<object>`,
          );
        }
      } else if (field.to !== undefined || field.many !== undefined) {
        contract(path, "Only relation fields take `to` and `many`");
      }
      if (field.type === "currency" && field.currency === undefined) {
        // Default applied by the host; nothing to report.
      } else if (field.type !== "currency" && field.currency !== undefined) {
        contract(`${path}.currency`, "Only currency fields take `currency`");
      }
      if (field.type === "formula") {
        if (field.required) contract(`${path}.required`, "Formula fields cannot be required");
        if (field.track)
          contract(`${path}.track`, "Formula fields cannot be tracked on the timeline");
        if (!field.expression?.trim()) {
          contract(`${path}.expression`, "formula fields need an expression");
        } else {
          const result = checkFormula(field.expression, { fields: env }, name);
          if (!result.ok) {
            issues.push({
              code: result.issue.code,
              path: `${path}.expression`,
              message: `${object}.${name}: ${result.issue.message}`,
              span: result.issue.span,
            });
          }
        }
      } else if (field.expression !== undefined) {
        contract(`${path}.expression`, "Only formula fields take an expression");
      }
    }
  };

  for (const [name, object] of Object.entries(m.objects)) {
    const path = `objects.${name}`;
    if (!OBJECT_NAME_RE.test(name)) {
      contract(
        path,
        `Object name "${name}" must be lowercase letters and digits, starting with a letter`,
      );
    }
    if (RESERVED_OBJECT_NAMES.has(name)) contract(path, `"${name}" is a reserved object name`);
    if (object.renamedFrom !== undefined && !OBJECT_NAME_RE.test(object.renamedFrom)) {
      contract(`${path}.renamedFrom`, "renamedFrom must be a valid object name");
    }
    const title = object.fields[object.titleField];
    if (!title) {
      contract(`${path}.titleField`, `titleField "${object.titleField}" is not a field of ${name}`);
    } else if (!TEXT_LIKE.includes(title.type)) {
      contract(
        `${path}.titleField`,
        `titleField must be a text-like field (${TEXT_LIKE.join(", ")})`,
      );
    }
    const env = formulaFields(object.fields);
    checkFields(`${path}.fields`, `${m.id}.${name}`, object.fields, env);
  }

  for (const [target, fields] of Object.entries(m.fields)) {
    const path = `fields.${target}`;
    if (!known.has(target)) {
      contract(path, `Unknown object "${target}". Use a core object or <extension>.<object>`);
      continue;
    }
    if (target.startsWith(`${m.id}.`)) {
      contract(path, "Declare fields of your own objects in objects.<name>.fields");
      continue;
    }
    const env = { ...(options.baseFields?.(target) ?? {}), ...formulaFields(fields) };
    checkFields(path, target, fields, env);
  }

  for (const [name, tool] of Object.entries(m.tools)) {
    if (!TOOL_NAME_RE.test(name)) {
      contract(`tools.${name}`, `Tool name "${name}" must be camelCase letters and digits`);
    }
    if (tool.inputSchema.type !== "object") {
      contract(`tools.${name}.input`, "A tool's input must be a z.object(...)");
    }
  }

  for (const [name, view] of Object.entries(m.views)) {
    if (!FIELD_NAME_RE.test(name)) contract(`views.${name}`, "View names must be camelCase");
    if (!known.has(view.object))
      contract(`views.${name}.object`, `Unknown object "${view.object}"`);
  }

  for (const [name, automation] of Object.entries(m.automations)) {
    if (!FIELD_NAME_RE.test(name))
      contract(`automations.${name}`, "Automation names must be camelCase");
    if ("object" in automation.trigger && !known.has(automation.trigger.object)) {
      contract(
        `automations.${name}.trigger.object`,
        `Unknown object "${automation.trigger.object}"`,
      );
    }
  }

  const perms = m.permissions;
  for (const [key, list] of [
    ["read", perms.read],
    ["write", perms.write],
  ] as const) {
    list.forEach((object, i) => {
      if (!known.has(object)) contract(`permissions.${key}.${i}`, `Unknown object "${object}"`);
    });
  }
  perms.operations.forEach((operation, i) => {
    if (!OPERATION_RE.test(operation)) {
      contract(`permissions.operations.${i}`, `"${operation}" is not an operation name`);
    } else if (FORBIDDEN_OPERATION_PREFIXES.some((prefix) => operation.startsWith(prefix))) {
      contract(`permissions.operations.${i}`, `Extensions cannot be granted ${operation}`);
    }
  });
  const usesCrm = perms.read.length > 0 || perms.write.length > 0 || perms.operations.length > 0;
  if (usesCrm && !perms.modules.includes("crm")) {
    contract("permissions.modules", 'Object or operation permissions need the "crm" module');
  }

  return { manifest: m, issues };
}

export function declaredModules(manifest: ExtensionManifest): HostModuleName[] {
  return manifest.permissions.modules;
}
