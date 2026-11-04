// The extension contract (ADR 0005, ADR 0023): one entry file whose default export is
// `defineExtension({...})`. Everything here is plain data plus tool/automation handlers, so the host
// can turn it into a JSON manifest, validate it, diff it and reconcile it to tables.
import type { z } from "zod";
import type { FieldTypeName } from "./field-types.ts";

/** The contract version this SDK writes. The host accepts this and the previous version. */
export const CONTRACT_VERSION = 1;
/** Contract versions a host built with this SDK runs (current and previous, ADR 0005). */
export const SUPPORTED_CONTRACT_VERSIONS: readonly number[] = [CONTRACT_VERSION];

/** Host modules an extension can ask for (ADR 0025). There is no HTTP module. */
export const HOST_MODULES = ["crm", "storage", "log", "ai"] as const;
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
  /**
   * Maintained by the host (for example a stage behaviour's won/lost date), never written by
   * record operations. Shown, filtered and sorted like any field.
   */
  readOnly?: boolean;
}

export type SelectOption =
  | string
  | {
      value: string;
      label?: string;
      color?: string;
      /**
       * Fields that must have a value for a record to hold this choice (a stage rule, ADR 0058).
       * Moving a record to it without them is refused by the update operation, naming the field,
       * so a board drag asks for it.
       */
      requires?: string[];
    };

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
  /**
   * Where the object is listed: `main` (the sidebar, default), `settings` (set-up records such as
   * pipelines, listed under Settings → Extensions) or `none` (reached from other records only).
   */
  navigation?: "main" | "settings" | "none";
  /**
   * Indexes on the object's table, each a list of up to 4 own, single-valued, non-formula fields
   * (or `createdAt` / `updatedAt`). They cover live rows only. Declare one for every field the
   * object's hot lists filter or sort by.
   */
  indexes?: readonly (readonly string[])[];
  /**
   * Relation fields (one record each) whose records also get this object's timeline posts, e.g.
   * `["organisation"]` posts a deal's stage moves on its organisation's timeline too.
   */
  timelineLinks?: readonly string[];
  /** A pipeline-like stage behaviour (see StagesSpec). */
  stages?: StagesSpec;
  /**
   * Records created once, when the object is first installed (default pipelines and stages).
   * Keyed by a seed key (camelCase); a relation value `{ seed: "<key>" }` points at another seed
   * record of the relation's target (one of this extension's objects). Later releases never
   * re-apply seeds, so people can edit or delete seeded records.
   */
  seed?: Record<string, Record<string, unknown>>;
}

/** Stage types every stage object distinguishes. */
export const STAGE_TYPES = ["open", "won", "lost"] as const;
export type StageType = (typeof STAGE_TYPES)[number];

/**
 * A stage behaviour (ADR 0100): the object moves through ordered stages (records of another of the
 * extension's objects), optionally grouped (pipelines). The host enforces it in the record
 * operations, so it applies to every actor: people, MCP clients, Code Mode, extensions.
 *
 * - Entering a stage needs the stage's required fields and `requiredByType[type]` to have values;
 *   otherwise the write is refused with a structured error naming the missing fields.
 * - `group` must match the stage's group; a record given only a group starts in its first stage.
 * - `probability.field` follows the stage's default probability unless it was set by hand
 *   (`probability.overridden` is then true; clearing that flag resets it).
 * - `closedDate` is set on entering a won or lost stage and cleared on reopening; `status` mirrors
 *   the stage type.
 * - Every stage change is recorded in stage history (entered and left times) and, when the field
 *   is tracked, posted on the timeline as "Moved to <stage>".
 */
export interface StagesSpec {
  /** This object's relation field (one) holding its stage. */
  field: string;
  /** Fields of the stage object (the relation's target). */
  stage: {
    /** A select whose option values include `open`, `won` and `lost`. */
    type: string;
    /** A number field ordering stages within their group. */
    order: string;
    /** A multiSelect whose option values are this object's field names. */
    requiredFields?: string;
    /** A number or percent field: the default probability of records in the stage. */
    probability?: string;
    /** A relation field to the group object (e.g. the stage's pipeline). */
    group?: string;
  };
  /** This object's relation field to the group object (e.g. the deal's pipeline). */
  group?: string;
  /** This object's probability (number or percent) and the boolean flag set when it is overridden. */
  probability?: { field: string; overridden: string };
  /** This object's date field set on entering a won or lost stage, cleared on reopening. */
  closedDate?: string;
  /** This object's select field mirroring the stage type (options open, won, lost). */
  status?: string;
  /** Fields required in every stage of a type, on top of each stage's own required fields. */
  requiredByType?: Partial<Record<StageType, readonly string[]>>;
  /**
   * A text setting of this extension (`settings`) naming the group (by id or title) a record
   * created without a group or stage goes in, e.g. the default pipeline.
   */
  defaultGroupSetting?: string;
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

/**
 * A saved view shipped with the extension: shared with everyone, read-only, listed in the
 * object's views menu (ADR 0103). A table by default, or a board, calendar or gallery (ADR 0056).
 * Filter values may be relative: `{ $relative: "me" | "today" | "startOfMonth" | … }`.
 */
export interface ViewSpec {
  label: string;
  /** Object the view lists: core or `<extension>.<object>`. */
  object: string;
  type?: "table" | "board" | "calendar" | "gallery";
  filter?: ViewFilter;
  sort?: { field: string; direction?: "asc" | "desc" };
  columns?: string[];
  /** board: the single-select or stage relation to group by, and a number field to sum. */
  groupBy?: string;
  sumField?: string;
  /** calendar */
  dateField?: string;
  mode?: "month" | "week" | "agenda";
  /** gallery */
  imageField?: string;
  /** board, calendar, gallery: fields on each card. */
  cardFields?: string[];
}

/**
 * A view on another object's record page (ADR 0058): a tab, or a side panel, listing records of
 * `view.object` whose `view.relation` field points at the record being shown, e.g. the projects
 * of an organisation. The host renders it with its own components; extensions ship no UI.
 */
export interface RecordViewSpec {
  label: string;
  /** The record page it appears on: `person`, `organisation`, `task` or `<extension>.<object>`. */
  on: string;
  view: {
    type: "table" | "board" | "calendar" | "gallery";
    /** The object listed. */
    object: string;
    /** The field of `object` that holds the current record's id (a relation, or `linkedRecordId`). */
    relation: string;
    filter?: ViewFilter;
    sort?: { field: string; direction?: "asc" | "desc" };
    /** table: fields shown. */
    columns?: string[];
    /** board: the single-select field to group by, and an optional number field to sum. */
    groupBy?: string;
    sumField?: string;
    /** calendar: the date field, and the starting mode. */
    dateField?: string;
    mode?: "month" | "week" | "agenda";
    /** gallery: an image URL field. */
    imageField?: string;
    /** board, calendar, gallery: fields shown on each card. */
    cardFields?: string[];
  };
  /** Order among the page's tabs or panels (lower first). Default 100. */
  order?: number;
}

/** A typed extension setting, edited by admins in Settings → Extensions (ADR 0058). */
export type SettingSpec = {
  label: string;
  description?: string;
  required?: boolean;
} & (
  | { type: "text"; default?: string }
  | { type: "number"; default?: number; min?: number; max?: number }
  | { type: "boolean"; default?: boolean }
  | { type: "select"; options: readonly SelectOption[]; default?: string }
);

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

export interface ExtensionContext {
  extension: { id: string; version: string };
  crm: CrmModule;
  storage: StorageModule;
  log: LogModule;
  ai: AiModule;
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

/**
 * A dashboard the extension ships (ADR 0103): the same filters and widgets as a dashboard spec
 * (ADR 0057; SQL over crm_* views with named params, a chart mapping, a click-through). It is
 * read-only, listed while the extension is active and copyable; `home: true` makes it everyone's
 * default Home.
 */
export interface DashboardDeclaration {
  title: string;
  description?: string;
  home?: boolean;
  filters?: readonly Record<string, unknown>[];
  widgets: readonly WidgetDeclaration[];
}

/** A widget of a shipped dashboard; see the host's dashboard spec for every option. */
export interface WidgetDeclaration {
  id: string;
  type: "kpi" | "bar" | "line" | "donut" | "funnel" | "table" | "leaderboard" | "markdown";
  title: string;
  description?: string;
  sql?: string;
  markdown?: string;
  mapping?: Record<string, unknown>;
  options?: Record<string, unknown>;
  clickThrough?: { object: string; objectColumn?: string; filter?: unknown };
  layout?: { w?: number; h?: number };
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
  /** Dashboards shipped with the extension (ADR 0103). */
  dashboards?: Record<string, DashboardDeclaration>;
  /** Tabs on other objects' record pages (ADR 0058). */
  recordTabs?: Record<string, RecordViewSpec>;
  /** Side panels on other objects' record pages (ADR 0058). */
  recordPanels?: Record<string, RecordViewSpec>;
  /** Typed settings, edited in Settings → Extensions (ADR 0058). */
  settings?: Record<string, SettingSpec>;
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
