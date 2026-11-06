// The extension manifest: the JSON form of an extension (no handlers, tool schemas as JSON
// Schema). The host evaluates an extension in the sandbox to get its manifest, then validates,
// diffs and reconciles the manifest. `validateManifest` is the contract check `extension.check`
// runs; it returns structured issues a model can act on.
import { z } from "zod";
import { automationManifestSchema } from "./automation.ts";
import { checkAutomation } from "./automation-check.ts";
import { checkObjectBehaviour } from "./behaviour.ts";
import {
  type Extension,
  HOST_MODULES,
  type HostModuleName,
  STAGE_TYPES,
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
  requires: z.array(z.string().max(80)).max(20).optional(),
  fixed: z.boolean().optional(),
});

export const fieldManifestSchema = z.object({
  type: z.enum(FIELD_TYPES),
  label: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
  track: z.literal("timeline").optional(),
  renamedFrom: z.string().max(40).optional(),
  required: z.boolean().optional(),
  readOnly: z.boolean().optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  options: z.array(optionSchema).max(200).optional(),
  editableOptions: z.boolean().optional(),
  default: z.union([z.string().max(1000), z.number(), z.boolean()]).optional(),
  defaultSetting: z.string().max(40).optional(),
  to: z.string().max(80).optional(),
  many: z.boolean().optional(),
  expression: z.string().max(2000).optional(),
});
export type FieldManifest = z.infer<typeof fieldManifestSchema>;

export const stagesManifestSchema = z.object({
  field: z.string().max(40),
  stage: z.object({
    type: z.string().max(40),
    order: z.string().max(40),
    requiredFields: z.string().max(40).optional(),
    probability: z.string().max(40).optional(),
    group: z.string().max(40).optional(),
  }),
  group: z.string().max(40).optional(),
  probability: z.object({ field: z.string().max(40), overridden: z.string().max(40) }).optional(),
  closedDate: z.string().max(40).optional(),
  status: z.string().max(40).optional(),
  defaultGroupSetting: z.string().max(40).optional(),
  requiredByType: z
    .partialRecord(z.enum(STAGE_TYPES), z.array(z.string().max(40)).max(50))
    .optional(),
});
export type StagesManifest = z.infer<typeof stagesManifestSchema>;

export const objectManifestSchema = z.object({
  label: z.string().min(1).max(100),
  plural: z.string().min(1).max(100),
  icon: z.string().max(60).optional(),
  titleField: z.string().max(40),
  description: z.string().max(1000).optional(),
  renamedFrom: z.string().max(40).optional(),
  fields: z.record(z.string(), fieldManifestSchema),
  navigation: z.enum(["main", "settings", "none"]).optional(),
  indexes: z
    .array(z.array(z.string().max(40)).min(1).max(4))
    .max(16)
    .optional(),
  timelineLinks: z.array(z.string().max(40)).max(8).optional(),
  stages: stagesManifestSchema.optional(),
  owner: z.string().max(40).optional(),
  navigationOrder: z.number().int().min(0).max(10_000).optional(),
  requireOneOf: z
    .array(z.array(z.string().max(40)).min(2).max(8))
    .max(8)
    .optional(),
  titleDefault: z
    .object({
      from: z.array(z.string().max(40)).min(1).max(8),
      suffix: z.string().max(40).optional(),
    })
    .optional(),
  seed: z
    .record(z.string().max(40), z.record(z.string().max(40), z.unknown()))
    .refine((seed) => Object.keys(seed).length <= 200, "At most 200 seed records per object")
    .optional(),
});
export type ObjectManifest = z.infer<typeof objectManifestSchema>;

const jsonSchemaObject = z.record(z.string(), z.unknown());

export const recordActionManifestSchema = z.object({
  object: z.string().min(1).max(80),
  label: z.string().min(1).max(60),
  idInput: z.string().min(1).max(40),
  confirm: z.string().max(300).optional(),
  ask: z
    .object({
      input: z.string().min(1).max(40),
      label: z.string().min(1).max(60),
      options: z
        .array(z.object({ value: z.string().min(1).max(100), label: z.string().min(1).max(100) }))
        .min(1)
        .max(50),
    })
    .optional(),
  hideWhen: z
    .object({
      field: z.string().min(1).max(80),
      values: z.array(z.string().min(1).max(100)).min(1).max(50),
    })
    .optional(),
});
export type RecordActionManifest = z.infer<typeof recordActionManifestSchema>;

export const toolManifestSchema = z.object({
  description: z.string().min(20).max(2000),
  risk: z.enum(TOOL_RISKS),
  recordAction: recordActionManifestSchema.optional(),
  inputSchema: jsonSchemaObject,
  outputSchema: jsonSchemaObject,
});
export type ToolManifest = z.infer<typeof toolManifestSchema>;

export const viewManifestSchema = z.object({
  label: z.string().min(1).max(100),
  object: z.string().max(80),
  /** The view type (ADR 0056). Default table. */
  type: z.enum(["table", "board", "calendar", "gallery"]).optional(),
  filter: z.unknown().optional(),
  sort: z
    .object({ field: z.string().max(64), direction: z.enum(["asc", "desc"]).default("asc") })
    .optional(),
  columns: z.array(z.string().max(80)).max(100).optional(),
  groupBy: z.string().max(80).optional(),
  sumField: z.string().max(80).optional(),
  dateField: z.string().max(80).optional(),
  mode: z.enum(["month", "week", "agenda"]).optional(),
  imageField: z.string().max(80).optional(),
  cardFields: z.array(z.string().max(80)).max(8).optional(),
});
export type ViewManifest = z.infer<typeof viewManifestSchema>;

const RECORD_VIEW_TYPES = ["table", "board", "calendar", "gallery"] as const;

export const recordViewManifestSchema = z.object({
  label: z.string().min(1).max(100),
  on: z.string().min(1).max(80),
  view: z.object({
    type: z.enum(RECORD_VIEW_TYPES),
    object: z.string().min(1).max(80),
    relation: z.string().min(1).max(80),
    filter: z.unknown().optional(),
    sort: z
      .object({ field: z.string().max(64), direction: z.enum(["asc", "desc"]).default("asc") })
      .optional(),
    columns: z.array(z.string().max(80)).max(100).optional(),
    groupBy: z.string().max(80).optional(),
    sumField: z.string().max(80).optional(),
    dateField: z.string().max(80).optional(),
    mode: z.enum(["month", "week", "agenda"]).optional(),
    imageField: z.string().max(80).optional(),
    cardFields: z.array(z.string().max(80)).max(8).optional(),
  }),
  order: z.number().int().min(0).max(10_000).default(100),
});
export type RecordViewManifest = z.infer<typeof recordViewManifestSchema>;

/**
 * A dashboard an extension ships (stage 4b): read-only for everyone, listed beside the CRM's own
 * Overview while the extension is active, copyable. `home` makes it the default Home. The host
 * validates `filters` and `widgets` against its dashboard spec (ADR 0057) at check time.
 */
export const dashboardManifestSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  home: z.boolean().optional(),
  filters: z.array(z.record(z.string(), z.unknown())).max(8).default([]),
  widgets: z.array(z.record(z.string(), z.unknown())).min(1).max(30),
});
export type DashboardManifest = z.infer<typeof dashboardManifestSchema>;

export const settingManifestSchema = z.object({
  type: z.enum(["text", "number", "boolean", "select"]),
  label: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
  required: z.boolean().optional(),
  default: z.union([z.string().max(1000), z.number(), z.boolean()]).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  options: z.array(optionSchema).max(200).optional(),
});
export type SettingManifest = z.infer<typeof settingManifestSchema>;

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
  recordTabs: z.record(z.string(), recordViewManifestSchema).default({}),
  recordPanels: z.record(z.string(), recordViewManifestSchema).default({}),
  settings: z.record(z.string(), settingManifestSchema).default({}),
  dashboards: z.record(z.string(), dashboardManifestSchema).default({}),
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
    dashboards: extension.dashboards ?? {},
    recordTabs: extension.recordTabs ?? {},
    recordPanels: extension.recordPanels ?? {},
    settings: Object.fromEntries(
      Object.entries(extension.settings ?? {}).map(([name, setting]) => [
        name,
        fieldToManifest(setting as unknown as Record<string, unknown>),
      ]),
    ),
    tools: Object.fromEntries(
      Object.entries(extension.tools ?? {}).map(([name, tool]) => [
        name,
        {
          description: tool.description,
          risk: tool.risk ?? "write",
          ...(tool.recordAction ? { recordAction: tool.recordAction } : {}),
          inputSchema: z.toJSONSchema(tool.input, { io: "input", unrepresentable: "any" }),
          outputSchema: z.toJSONSchema(tool.output, { io: "output", unrepresentable: "any" }),
        },
      ]),
    ),
    automations: Object.fromEntries(
      Object.entries(extension.automations ?? {}).map(([name, automation]) => [
        name,
        {
          label: automation.label,
          description: automation.description,
          trigger: automation.trigger,
          ...(automation.conditions ? { conditions: automation.conditions } : {}),
          steps: automation.steps,
          ...(automation.onRejected ? { onRejected: automation.onRejected } : {}),
          ...(automation.rails ? { rails: automation.rails } : {}),
          ...(automation.connections?.length ? { connections: automation.connections } : {}),
          ...(automation.enabled === false ? { enabled: false } : {}),
        },
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

/**
 * Core fields formulas on core objects can read, by formula type. The host checks this list
 * against its field registry (packages/core/test/sdk-core-fields.test.ts), so the SDK and the
 * testing harness agree with the host without depending on it.
 */
export const CORE_FORMULA_FIELDS: Record<
  (typeof CORE_OBJECT_NAMES)[number],
  Record<string, "text" | "number" | "boolean" | "date" | "datetime">
> = {
  person: {
    id: "text",
    displayName: "text",
    givenName: "text",
    familyName: "text",
    primaryEmail: "text",
    primaryPhone: "text",
    jobTitle: "text",
    organisationId: "text",
    organisationName: "text",
    location: "text",
    timezone: "text",
    ownerId: "text",
    createdAt: "datetime",
    updatedAt: "datetime",
  },
  organisation: {
    id: "text",
    name: "text",
    primaryDomain: "text",
    website: "text",
    industry: "text",
    parentId: "text",
    parentName: "text",
    ownerId: "text",
    currentPeopleCount: "number",
    createdAt: "datetime",
    updatedAt: "datetime",
  },
  activity: {
    id: "text",
    type: "text",
    subject: "text",
    body: "text",
    occurredAt: "datetime",
    authorUserId: "text",
    authorActor: "text",
    createdAt: "datetime",
  },
  task: {
    id: "text",
    title: "text",
    notes: "text",
    dueAt: "datetime",
    status: "text",
    completedAt: "datetime",
    assigneeId: "text",
    createdBy: "text",
    createdAt: "datetime",
    updatedAt: "datetime",
  },
};

function coreFormulaRefs(object: string): Record<string, FormulaFieldRef> {
  const fields = (CORE_FORMULA_FIELDS as Record<string, Record<string, string>>)[object];
  if (!fields) return {};
  return Object.fromEntries(
    Object.entries(fields).map(([name, type]) => [name, { type, sql: name } as FormulaFieldRef]),
  );
}

export interface ValidateOptions {
  /**
   * Fields a formula on `object` may read, other than the extension's own fields on it: the
   * host supplies core and installed fields. Default: none.
   */
  baseFields?: (object: string) => Record<string, FormulaFieldRef>;
  /** Objects that exist outside this extension (`person`, `other.thing`). Default: core only. */
  knownObjects?: readonly string[];
  /**
   * Field types of objects outside this extension (installed extensions' objects), for the
   * automation checks; null when unknown (those checks are skipped). Core objects are built in.
   */
  objectFields?: (object: string) => Record<string, FieldTypeName> | null;
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
        for (const option of field.options ?? []) {
          if (!option.requires?.length) continue;
          if (field.type !== "select") {
            contract(`${path}.options`, "Only select fields take `requires`");
            continue;
          }
          for (const required of option.requires) {
            if (!(required in fields)) {
              contract(
                `${path}.options`,
                `Option "${option.value}" requires "${required}", which is not a field here`,
              );
            }
          }
        }
        if (!field.editableOptions && field.options?.some((o) => o.fixed !== undefined)) {
          contract(`${path}.options`, "Only fields with editableOptions take `fixed`");
        }
      } else if (field.options) {
        contract(`${path}.options`, `Only select and multiSelect fields take options`);
      }
      if (
        field.editableOptions !== undefined &&
        field.type !== "select" &&
        field.type !== "multiSelect"
      ) {
        contract(
          `${path}.editableOptions`,
          "Only select and multiSelect fields take editableOptions",
        );
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
      if (field.readOnly && field.required) {
        contract(`${path}.readOnly`, "A read-only field is set by the host and cannot be required");
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
    // Every record's own timestamps can be read too, as on the host (formulaEnvironment).
    const env = {
      createdAt: { type: "datetime", sql: '"created_at"' } as FormulaFieldRef,
      updatedAt: { type: "datetime", sql: '"updated_at"' } as FormulaFieldRef,
      ...formulaFields(object.fields),
    };
    checkFields(`${path}.fields`, `${m.id}.${name}`, object.fields, env);
    checkObjectBehaviour(m, name, object, contract);
    object.requireOneOf?.forEach((group, i) => {
      for (const field of group) {
        if (!object.fields[field]) {
          contract(`${path}.requireOneOf.${i}`, `"${field}" is not a field of ${name}`);
        }
      }
    });
    for (const field of object.titleDefault?.from ?? []) {
      if (object.fields[field]?.type !== "relation") {
        contract(`${path}.titleDefault`, `"${field}" is not a relation field of ${name}`);
      }
    }
    for (const [fieldName, field] of Object.entries(object.fields)) {
      const fieldPath = `${path}.fields.${fieldName}`;
      if (field.default !== undefined) {
        const expected =
          field.type === "boolean"
            ? "boolean"
            : ["number", "currency", "percent"].includes(field.type)
              ? "number"
              : ["text", "longText", "select", "date", "email", "phone", "url"].includes(field.type)
                ? "string"
                : null;
        if (!expected) contract(`${fieldPath}.default`, `${field.type} fields take no default`);
        else if (typeof field.default !== expected) {
          contract(`${fieldPath}.default`, `The default must be a ${expected}`);
        } else if (
          field.type === "select" &&
          !field.options?.some((o) => o.value === field.default)
        ) {
          contract(`${fieldPath}.default`, "The default must be one of the options");
        }
      }
      if (field.defaultSetting !== undefined && !m.settings[field.defaultSetting]) {
        contract(
          `${fieldPath}.defaultSetting`,
          `"${field.defaultSetting}" is not one of this extension's settings`,
        );
      }
    }
    if (object.owner !== undefined) {
      const owner = object.fields[object.owner];
      if (!owner) contract(`${path}.owner`, `owner "${object.owner}" is not a field of ${name}`);
      else if (owner.type !== "user") contract(`${path}.owner`, "owner must name a user field");
    }
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
    for (const [fieldName, field] of Object.entries(fields)) {
      if (field.default !== undefined || field.defaultSetting !== undefined) {
        contract(`${path}.${fieldName}`, "Only fields of your own objects take a default");
      }
    }
    const base = options.baseFields?.(target) ?? coreFormulaRefs(target);
    const env = { ...base, ...formulaFields(fields) };
    checkFields(path, target, fields, env);
  }

  for (const [name, tool] of Object.entries(m.tools)) {
    if (!TOOL_NAME_RE.test(name)) {
      contract(`tools.${name}`, `Tool name "${name}" must be camelCase letters and digits`);
    }
    if (tool.inputSchema.type !== "object") {
      contract(`tools.${name}.input`, "A tool's input must be a z.object(...)");
    }
    if (tool.recordAction) {
      const action = tool.recordAction;
      if (!known.has(action.object)) {
        contract(`tools.${name}.recordAction.object`, `Unknown object "${action.object}"`);
      }
      const properties = (tool.inputSchema.properties ?? {}) as Record<string, { type?: unknown }>;
      if (properties[action.idInput]?.type !== "string") {
        contract(
          `tools.${name}.recordAction.idInput`,
          `idInput "${action.idInput}" must be a string field of the tool's input`,
        );
      }
      if (action.ask && !properties[action.ask.input]) {
        contract(
          `tools.${name}.recordAction.ask`,
          `"${action.ask.input}" is not a field of the tool's input`,
        );
      }
    }
  }

  for (const [name, view] of Object.entries(m.views)) {
    if (!FIELD_NAME_RE.test(name)) contract(`views.${name}`, "View names must be camelCase");
    if (!known.has(view.object))
      contract(`views.${name}.object`, `Unknown object "${view.object}"`);
    if (view.type === "board" && !view.groupBy) {
      contract(`views.${name}.groupBy`, "board views need groupBy");
    }
    if (view.type === "calendar" && !view.dateField) {
      contract(`views.${name}.dateField`, "calendar views need dateField");
    }
  }

  const homes = Object.entries(m.dashboards).filter(([, d]) => d.home);
  for (const [name] of Object.entries(m.dashboards)) {
    if (!FIELD_NAME_RE.test(name))
      contract(`dashboards.${name}`, "Dashboard names must be camelCase");
  }
  if (homes.length > 1) contract("dashboards", "At most one dashboard can be the default Home");

  for (const [kind, entries] of [
    ["recordTabs", m.recordTabs],
    ["recordPanels", m.recordPanels],
  ] as const) {
    for (const [name, entry] of Object.entries(entries)) {
      const path = `${kind}.${name}`;
      if (!FIELD_NAME_RE.test(name)) contract(path, `${kind} names must be camelCase`);
      if (!known.has(entry.on)) contract(`${path}.on`, `Unknown object "${entry.on}"`);
      if (!known.has(entry.view.object)) {
        contract(`${path}.view.object`, `Unknown object "${entry.view.object}"`);
        continue;
      }
      // The extension's own objects can be checked here; the host checks the rest.
      const own = entry.view.object.startsWith(`${m.id}.`)
        ? m.objects[entry.view.object.slice(m.id.length + 1)]
        : undefined;
      if (own) {
        const relation = own.fields[entry.view.relation];
        if (!relation) {
          contract(
            `${path}.view.relation`,
            `${entry.view.object} has no field "${entry.view.relation}"`,
          );
        } else if (relation.type !== "relation" || relation.to !== entry.on) {
          contract(
            `${path}.view.relation`,
            `${entry.view.object}.${entry.view.relation} must be a relation to ${entry.on}`,
          );
        }
        for (const key of ["groupBy", "sumField", "dateField", "imageField"] as const) {
          const field = entry.view[key];
          if (field && !own.fields[field]) {
            contract(`${path}.view.${key}`, `${entry.view.object} has no field "${field}"`);
          }
        }
      }
      if (entry.view.type === "board" && !entry.view.groupBy) {
        contract(`${path}.view.groupBy`, "board views need groupBy");
      }
      if (entry.view.type === "calendar" && !entry.view.dateField) {
        contract(`${path}.view.dateField`, "calendar views need dateField");
      }
    }
  }

  for (const [name, setting] of Object.entries(m.settings)) {
    const path = `settings.${name}`;
    if (!FIELD_NAME_RE.test(name)) contract(path, "Setting names must be camelCase");
    if (setting.type === "select") {
      if (!setting.options?.length) contract(`${path}.options`, "select settings need options");
      if (
        setting.default !== undefined &&
        !setting.options?.some((o) => o.value === setting.default)
      ) {
        contract(`${path}.default`, "The default must be one of the options");
      }
    } else if (setting.options) {
      contract(`${path}.options`, "Only select settings take options");
    }
    const expected = { text: "string", select: "string", number: "number", boolean: "boolean" };
    if (setting.default !== undefined && typeof setting.default !== expected[setting.type]) {
      contract(`${path}.default`, `The default must be a ${expected[setting.type]}`);
    }
  }

  for (const [name, automation] of Object.entries(m.automations)) {
    checkAutomation(
      { manifest: m, known, objectFields: options.objectFields, contract },
      name,
      automation,
    );
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
