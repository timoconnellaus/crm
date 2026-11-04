// The field-type registry for extension fields (ADR 0023): for every SDK field type, its SQLite
// storage, zod validation, filter semantics (and so its filter operators), CSV mapping and the UI
// widgets that display and edit it. Browser-safe: the UI renders widgets from `widget`.
import type { FieldManifest, FieldTypeName } from "@crm/sdk";
import { z } from "zod";
import type { FieldType } from "./types.ts";

export type WidgetKind =
  | "text"
  | "textarea"
  | "number"
  | "currency"
  | "percent"
  | "date"
  | "datetime"
  | "checkbox"
  | "select"
  | "multiSelect"
  | "relation"
  | "user"
  | "email"
  | "phone"
  | "url"
  | "formula";

/** The storage value of a field: what goes into its column. */
export type StoredValue = string | number | null;

export interface FieldTypeSpec {
  /** SQLite column type. Null: no column (formula fields are computed in the crm_* view). */
  storage: "TEXT" | "REAL" | "INTEGER" | null;
  /** How filters treat it (this picks the operators, see OPS_BY_TYPE). */
  filterType(field: FieldManifest): FieldType;
  /** Stored as a JSON array; filters match any element. */
  multi(field: FieldManifest): boolean;
  sortable(field: FieldManifest): boolean;
  /** Validates a value written by record operations (null clears it). */
  schema(field: FieldManifest): z.ZodType;
  /** Converts a validated value to its column value. */
  toStorage(value: unknown): StoredValue;
  /** Converts a column value back to the API value. */
  fromStorage(value: unknown): unknown;
  /** CSV mapping: parse a cell (empty → null) and format a value. */
  csv: { parse(cell: string, field: FieldManifest): unknown; format(value: unknown): string };
  widget: { display: WidgetKind; edit: WidgetKind | null };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

const nullable = (schema: z.ZodType) => schema.nullable();
const text = (max: number) => z.string().max(max);
const identity = (value: unknown) => (value === undefined ? null : (value as StoredValue));
const jsonArray = {
  toStorage: (value: unknown) => (value == null ? null : JSON.stringify(value)),
  fromStorage: (value: unknown) =>
    typeof value === "string" ? (JSON.parse(value) as unknown[]) : value == null ? null : value,
};
const csvText = {
  parse: (cell: string) => (cell === "" ? null : cell),
  format: (value: unknown) => (value == null ? "" : String(value)),
};
const csvNumber = {
  parse: (cell: string) => {
    if (cell.trim() === "") return null;
    const n = Number(cell.replace(/[,$€£%\s]/g, ""));
    if (!Number.isFinite(n)) throw new Error(`"${cell}" is not a number`);
    return n;
  },
  format: (value: unknown) => (value == null ? "" : String(value)),
};
const csvList = {
  parse: (cell: string) =>
    cell.trim() === ""
      ? null
      : cell
          .split(";")
          .map((part) => part.trim())
          .filter(Boolean),
  format: (value: unknown) => (Array.isArray(value) ? value.map(String).join("; ") : ""),
};

const choices = (field: FieldManifest) => (field.options ?? []).map((o) => o.value);

function textType(max: number, widget: WidgetKind, edit: WidgetKind, schema?: z.ZodType) {
  return {
    storage: "TEXT",
    filterType: () => "text",
    multi: () => false,
    sortable: () => widget !== "textarea",
    schema: () => nullable(schema ?? text(max)),
    toStorage: identity,
    fromStorage: identity,
    csv: csvText,
    widget: { display: widget, edit },
  } satisfies FieldTypeSpec;
}

function numberType(widget: WidgetKind) {
  return {
    storage: "REAL",
    filterType: () => "number",
    multi: () => false,
    sortable: () => true,
    schema: () => nullable(z.number().finite()),
    toStorage: identity,
    fromStorage: identity,
    csv: csvNumber,
    widget: { display: widget, edit: widget },
  } satisfies FieldTypeSpec;
}

export const FIELD_TYPE_REGISTRY: Record<FieldTypeName, FieldTypeSpec> = {
  text: textType(1000, "text", "text"),
  longText: textType(100_000, "textarea", "textarea"),
  email: textType(320, "email", "email", z.email().max(320)),
  phone: textType(64, "phone", "phone", z.string().regex(/^[+0-9 ().-]{3,64}$/)),
  url: textType(2000, "url", "url", z.url().max(2000)),
  number: numberType("number"),
  currency: numberType("currency"),
  percent: numberType("percent"),
  date: {
    storage: "TEXT",
    filterType: () => "date",
    multi: () => false,
    sortable: () => true,
    schema: () => nullable(z.string().regex(DATE_RE, "Expected YYYY-MM-DD")),
    toStorage: identity,
    fromStorage: identity,
    csv: {
      parse: (cell) => {
        if (cell.trim() === "") return null;
        if (!DATE_RE.test(cell.trim())) throw new Error(`"${cell}" is not a YYYY-MM-DD date`);
        return cell.trim();
      },
      format: csvText.format,
    },
    widget: { display: "date", edit: "date" },
  },
  datetime: {
    storage: "TEXT",
    filterType: () => "datetime",
    multi: () => false,
    sortable: () => true,
    schema: () => nullable(z.string().regex(DATETIME_RE, "Expected an ISO-8601 timestamp")),
    toStorage: identity,
    fromStorage: identity,
    csv: {
      parse: (cell) => {
        if (cell.trim() === "") return null;
        const date = new Date(cell.trim());
        if (Number.isNaN(date.getTime())) throw new Error(`"${cell}" is not a timestamp`);
        return date.toISOString();
      },
      format: csvText.format,
    },
    widget: { display: "datetime", edit: "datetime" },
  },
  boolean: {
    storage: "INTEGER",
    filterType: () => "boolean",
    multi: () => false,
    sortable: () => true,
    schema: () => nullable(z.boolean()),
    toStorage: (value) => (value == null ? null : value ? 1 : 0),
    fromStorage: (value) => (value == null ? null : Boolean(value)),
    csv: {
      parse: (cell) => {
        const v = cell.trim().toLowerCase();
        if (v === "") return null;
        if (["true", "yes", "y", "1"].includes(v)) return true;
        if (["false", "no", "n", "0"].includes(v)) return false;
        throw new Error(`"${cell}" is not true or false`);
      },
      format: (value) => (value == null ? "" : value ? "true" : "false"),
    },
    widget: { display: "checkbox", edit: "checkbox" },
  },
  select: {
    storage: "TEXT",
    filterType: () => "enum",
    multi: () => false,
    sortable: () => true,
    schema: (field) => nullable(z.enum(choices(field) as [string, ...string[]])),
    toStorage: identity,
    fromStorage: identity,
    csv: csvText,
    widget: { display: "select", edit: "select" },
  },
  multiSelect: {
    storage: "TEXT",
    filterType: () => "enum",
    multi: () => true,
    sortable: () => false,
    schema: (field) => nullable(z.array(z.enum(choices(field) as [string, ...string[]])).max(200)),
    ...jsonArray,
    csv: csvList,
    widget: { display: "multiSelect", edit: "multiSelect" },
  },
  relation: {
    storage: "TEXT",
    filterType: () => "id",
    multi: (field) => field.many === true,
    sortable: (field) => field.many !== true,
    schema: (field) =>
      nullable(
        field.many ? z.array(z.string().min(1).max(64)).max(500) : z.string().min(1).max(64),
      ),
    toStorage: (value) =>
      value == null ? null : Array.isArray(value) ? JSON.stringify(value) : (value as string),
    fromStorage: (value) =>
      typeof value === "string" && value.startsWith("[") ? (JSON.parse(value) as unknown) : value,
    csv: {
      parse: (cell, field) => (field.many ? csvList.parse(cell) : csvText.parse(cell)),
      format: (value) => (Array.isArray(value) ? csvList.format(value) : csvText.format(value)),
    },
    widget: { display: "relation", edit: "relation" },
  },
  user: {
    storage: "TEXT",
    filterType: () => "id",
    multi: () => false,
    sortable: () => false,
    schema: () => nullable(z.string().min(1).max(64)),
    toStorage: identity,
    fromStorage: identity,
    csv: csvText,
    widget: { display: "user", edit: "user" },
  },
  formula: {
    storage: null,
    // Replaced by the formula's result type when the registry is built.
    filterType: () => "text",
    multi: () => false,
    sortable: () => true,
    schema: () => z.never(),
    toStorage: identity,
    fromStorage: identity,
    csv: csvText,
    widget: { display: "formula", edit: null },
  },
};

/** The filter type a formula result maps to. */
export function formulaFilterType(resultType: string): FieldType {
  switch (resultType) {
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "date":
      return "date";
    case "datetime":
      return "datetime";
    default:
      return "text";
  }
}

/** Converts a formula's stored value (booleans are 0/1) to its API value. */
export function formulaFromStorage(resultType: string | undefined, value: unknown): unknown {
  if (resultType === "boolean") return value == null ? null : Boolean(value);
  return value ?? null;
}
