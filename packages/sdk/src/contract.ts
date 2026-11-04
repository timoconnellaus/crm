// The extension contract (ADR 0005, ADR 0023): one entry file whose default export is
// `defineExtension({...})`. Everything here is plain data plus tool/automation handlers, so the host
// can turn it into a JSON manifest, validate it, diff it and reconcile it to tables.
import type { z } from "zod";
import type { FieldTypeName } from "./field-types.ts";

/** The contract version this SDK writes. The host accepts this and the previous version. */
export const CONTRACT_VERSION = 1;
/** Contract versions a host built with this SDK runs (current and previous, ADR 0005). */
export const SUPPORTED_CONTRACT_VERSIONS: readonly number[] = [CONTRACT_VERSION];

/**
 * Gatekeepers code can reach as `codemode:<gatekeeper>` host modules (stage 6a, ADR 0050): the
 * only way out to an external service. Calls go through the integration host as the caller,
 * reads are observations and side effects are outbound actions under the approval gate.
 */
export const GATEKEEPER_MODULES = [
  "google",
  "microsoft",
  "slack",
  "slack-post",
  "mcp",
  "email",
  "email-send",
  "zoominfo",
  "websearch",
  "webhook",
  // The fake provider: development and tests only (it answers only when turned on).
  "fake",
] as const;
export type GatekeeperModuleName = (typeof GATEKEEPER_MODULES)[number];

/** Host modules an extension can ask for (ADR 0025). There is no HTTP module. */
export const HOST_MODULES = ["crm", "storage", "log", "ai", ...GATEKEEPER_MODULES] as const;
export type HostModuleName = (typeof HOST_MODULES)[number];

/** Risk classes an extension tool may declare (schema and extension risks are host-only). */
export const TOOL_RISKS = ["read", "write", "bulk-write", "destructive"] as const;
export type ToolRisk = (typeof TOOL_RISKS)[number];

// ---------------------------------------------------------------------------------------------
// Fields

interface FieldBase {
  /** Label shown in the UI. */
  label: string;
  /** Help text for people and models. */
  description?: string;
  /** `timeline`: changes post a system activity on the record (ADR 0017). */
  track?: "timeline";
  /** The field's previous name. Without it a missing field is a removal (hidden, kept 30 days). */
  renamedFrom?: string;
  /** Refuse records without a value. */
  required?: boolean;
}

export type SelectOption = string | { value: string; label?: string; color?: string };

export type FieldSpec =
  | (FieldBase & {
      type:
        | "text"
        | "longText"
        | "number"
        | "percent"
        | "date"
        | "datetime"
        | "boolean"
        | "user"
        | "email"
        | "phone"
        | "url";
    })
  | (FieldBase & {
      type: "currency";
      /** ISO 4217 code shown with the value. Default USD. */
      currency?: string;
    })
  | (FieldBase & { type: "select" | "multiSelect"; options: readonly SelectOption[] })
  | (FieldBase & {
      type: "relation";
      /** Target object: `person`, `organisation`, `task`, or `<extension>.<object>`. */
      to: string;
      /** Many records (stored as a JSON array of ids). Default one. */
      many?: boolean;
    })
  | (Omit<FieldBase, "required"> & {
      type: "formula";
      /** An expression over fields of the same record. See the SDK README for the grammar. */
      expression: string;
    });

export type FieldSpecs = Record<string, FieldSpec>;

// ---------------------------------------------------------------------------------------------
// Objects, views

export interface ObjectSpec {
  label: string;
  plural: string;
  /** A lucide icon name, e.g. `folder-kanban`. */
  icon?: string;
  /** The field used as the record's title (a text-like field). */
  titleField: string;
  description?: string;
  /** The object's previous name, when renaming. */
  renamedFrom?: string;
  fields: FieldSpecs;
}

export type FilterOp =
  | "eq"
  | "neq"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "between"
  | "in"
  | "not_in"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "is_null"
  | "is_not_null";
export type ViewFilter =
  | { field: string; op: FilterOp; value?: unknown }
  | { and: ViewFilter[] }
  | { or: ViewFilter[] };

/** A `table` saved-view spec shipped with the extension. */
export interface ViewSpec {
  label: string;
  /** Object the view lists: core or `<extension>.<object>`. */
  object: string;
  filter?: ViewFilter;
  sort?: { field: string; direction?: "asc" | "desc" };
  columns?: string[];
}

// ---------------------------------------------------------------------------------------------
// Host modules, as seen by tools through `ctx`

export interface CrmModule {
  /** Calls an operation (e.g. `organisation.get`) as this extension, through the gate. */
  call<T = unknown>(operation: string, input?: unknown): Promise<T>;
}

export interface StorageModule {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<{ key: string; value: unknown }[]>;
}

export interface LogModule {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export interface AiModule {
  /** Model role `summarise`. */
  summarise(text: string, options?: { maxWords?: number }): Promise<string>;
  /** Model role `extract`: fills `fields` (name → description) from text. */
  extract(text: string, fields: Record<string, string>): Promise<Record<string, unknown>>;
  /** Model role `classify`: picks one of `labels`. */
  classify(text: string, labels: string[]): Promise<{ label: string }>;
}

/** A connected gatekeeper (`codemode:<gatekeeper>`), reached through its connections. */
export interface GatekeeperModule {
  /** Connections of this gatekeeper the caller may use, with their bound resources. */
  connections(): Promise<
    {
      id: string;
      title: string;
      resources: { key: string; bindingName: string; tsType: string }[];
    }[]
  >;
  /**
   * Calls a top-level session method of a bound resource. Side effects come back as pending
   * outbound actions (in `pending`) until a person approves them.
   */
  call(
    connectionId: string,
    resource: string,
    method: string,
    ...args: unknown[]
  ): Promise<{ value: unknown; pending: unknown[]; applied: unknown[] }>;
  /** The session's TypeScript declarations. */
  types(connectionId: string, resource: string): Promise<string>;
}

export interface ExtensionContext {
  extension: { id: string; version: string };
  crm: CrmModule;
  storage: StorageModule;
  log: LogModule;
  ai: AiModule;
  /** A gatekeeper declared in permissions.modules, e.g. `ctx.gatekeeper("email-send")`. */
  gatekeeper(name: GatekeeperModuleName): GatekeeperModule;
}

// ---------------------------------------------------------------------------------------------
// Tools and automations

export interface ToolSpec<In extends z.ZodType = z.ZodType, Out extends z.ZodType = z.ZodType> {
  /** For a model: what it does, when to use it, side effects. At least 20 characters. */
  description: string;
  input: In;
  output: Out;
  /** Default `write`. */
  risk?: ToolRisk;
  handler(input: z.output<In>, ctx: ExtensionContext): Promise<z.input<Out>> | z.input<Out>;
}

export function defineTool<In extends z.ZodType, Out extends z.ZodType>(
  tool: ToolSpec<In, Out>,
): ToolSpec<In, Out> {
  return tool;
}

export type AutomationTrigger =
  | { type: "record.created" | "record.updated" | "record.deleted"; object: string }
  | { type: "schedule"; cron: string };

/** Typed and validated now; triggers fire from stage 5. */
export interface AutomationSpec {
  description: string;
  trigger: AutomationTrigger;
  handler(event: unknown, ctx: ExtensionContext): Promise<void> | void;
}

export function defineAutomation(automation: AutomationSpec): AutomationSpec {
  return automation;
}

// ---------------------------------------------------------------------------------------------
// Permissions and the extension

/**
 * What the extension may do, approved like OAuth scopes. Its own objects are always readable and
 * writable. `read`/`write` name objects (`organisation`, `other.object`); `write` implies `read`.
 * `operations` lists further operations by exact name (e.g. `task.create`, `search.global`).
 */
export interface PermissionsSpec {
  read?: string[];
  write?: string[];
  operations?: string[];
  modules?: HostModuleName[];
}

export interface ExtensionSpec {
  /** Lowercase letters and digits, starting with a letter: `deals`, `example`. */
  id: string;
  /** Semver, e.g. `1.0.0`. */
  version: string;
  contractVersion: number;
  label?: string;
  description?: string;
  permissions?: PermissionsSpec;
  objects?: Record<string, ObjectSpec>;
  /** Fields added to other objects, keyed by target object (`organisation`, `other.object`). */
  fields?: Record<string, FieldSpecs>;
  views?: Record<string, ViewSpec>;
  // biome-ignore lint/suspicious/noExplicitAny: tools of any input/output schema.
  tools?: Record<string, ToolSpec<any, any>>;
  automations?: Record<string, AutomationSpec>;
}

const EXTENSION = Symbol.for("crm.extension");

export type Extension<E extends ExtensionSpec = ExtensionSpec> = E & { readonly [EXTENSION]: true };

/** The entry point of every extension: `export default defineExtension({ ... })`. */
export function defineExtension<const E extends ExtensionSpec>(extension: E): Extension<E> {
  return { ...extension, [EXTENSION]: true } as Extension<E>;
}

export function isExtension(value: unknown): value is Extension {
  return typeof value === "object" && value !== null && EXTENSION in value;
}

export type { FieldTypeName };
