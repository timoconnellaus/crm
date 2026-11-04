// The extension field types (ADR 0023) and the facts about them both the SDK and the host need:
// the formula type a field reads as, and which type changes are lossless. Storage, validation,
// filter operators, CSV mapping and widgets live in the host's field-type registry
// (`@crm/core`, fields/field-types.ts), keyed by these names.
import type { FormulaType } from "./formula/ast.ts";

export const FIELD_TYPES = [
  "text",
  "longText",
  "number",
  "currency",
  "percent",
  "date",
  "datetime",
  "boolean",
  "select",
  "multiSelect",
  "relation",
  "user",
  "email",
  "phone",
  "url",
  "formula",
] as const;
export type FieldTypeName = (typeof FIELD_TYPES)[number];

/** What a formula sees when it reads a field of this type (null: not readable from formulas). */
export function formulaTypeOf(
  type: FieldTypeName,
  many = false,
): Exclude<FormulaType, "null"> | null {
  switch (type) {
    case "text":
    case "longText":
    case "select":
    case "user":
    case "email":
    case "phone":
    case "url":
      return "text";
    case "relation":
      return many ? null : "text";
    case "number":
    case "currency":
    case "percent":
      return "number";
    case "boolean":
      return "boolean";
    case "date":
      return "date";
    case "datetime":
      return "datetime";
    case "multiSelect":
    case "formula":
      return null;
  }
}

/**
 * Type changes the reconciler accepts: the stored values stay valid and keep their meaning.
 * Anything else is refused with a suggestion to add a new field and migrate.
 */
export const LOSSLESS_TYPE_CHANGES: Readonly<Record<FieldTypeName, readonly FieldTypeName[]>> = {
  text: ["longText"],
  longText: [],
  number: ["currency", "percent"],
  currency: ["number"],
  percent: ["number"],
  date: ["datetime"],
  datetime: [],
  boolean: [],
  select: ["text", "longText"],
  multiSelect: [],
  relation: [],
  user: [],
  email: ["text", "longText"],
  phone: ["text", "longText"],
  url: ["text", "longText"],
  formula: [],
};

export function isLosslessChange(from: FieldTypeName, to: FieldTypeName): boolean {
  return from === to || LOSSLESS_TYPE_CHANGES[from].includes(to);
}
