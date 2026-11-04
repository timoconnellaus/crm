// Where a registry field's value lives in its object's crm_* view.
import type { FieldDefinition } from "../fields/types.ts";

/** The view column of a field: its `column`, or for a multi-valued extension field the JSON column. */
export function viewColumnOf(field: FieldDefinition): string | null {
  if (field.column) return field.column;
  const match = /json_each\(r2\.([a-z0-9_]+)\)/.exec(field.related?.from ?? "");
  return match?.[1] ?? null;
}
