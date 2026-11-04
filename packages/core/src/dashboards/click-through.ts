// Click-through (ADR 0057): a widget's filter template, resolved against a clicked row and the
// bound parameters, becomes ordinary list filter JSON for the target object. The template's
// placeholders are `{ "$row": "<column>" }` and `{ "$param": "<name>" }`; a condition whose
// placeholder resolves to null is dropped (an unset dashboard filter does not narrow the list),
// as is a group left empty. Browser-safe: the UI resolves templates when a segment is clicked.
import type { Filter, FilterCondition } from "../filter.ts";
import type { ClickThrough } from "./spec.ts";

export type Row = Record<string, unknown>;

const DROP = Symbol("drop");

function resolveValue(
  value: unknown,
  row: Row,
  params: Record<string, unknown>,
): unknown | typeof DROP {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "$row") {
      const column = (value as { $row: unknown }).$row;
      const resolved = typeof column === "string" ? row[column] : undefined;
      return resolved === undefined || resolved === null ? DROP : resolved;
    }
    if (keys.length === 1 && keys[0] === "$param") {
      const name = (value as { $param: unknown }).$param;
      const resolved = typeof name === "string" ? params[name] : undefined;
      return resolved === undefined || resolved === null ? DROP : resolved;
    }
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => resolveValue(item, row, params));
    return items.includes(DROP) ? DROP : items;
  }
  return value;
}

function resolveFilter(
  filter: Filter,
  row: Row,
  params: Record<string, unknown>,
): Filter | null {
  if ("and" in filter || "or" in filter) {
    const key = "and" in filter ? "and" : "or";
    const parts = ((filter as Record<string, Filter[]>)[key] ?? [])
      .map((part) => resolveFilter(part, row, params))
      .filter((part): part is Filter => part !== null);
    if (!parts.length) return null;
    if (parts.length === 1) return parts[0] as Filter;
    return key === "and" ? { and: parts } : { or: parts };
  }
  const condition = filter as FilterCondition;
  if (!("value" in condition)) return condition;
  const value = resolveValue(condition.value, row, params);
  if (value === DROP) return null;
  return { field: condition.field, op: condition.op, value };
}

/** The list a click opens: `{ object, filter }`, or the object's whole list when nothing narrows it. */
export function resolveClickThrough(
  template: ClickThrough,
  row: Row,
  params: Record<string, unknown>,
): { object: string; filter: Filter | null } {
  const fromRow = template.objectColumn ? row[template.objectColumn] : undefined;
  return {
    object: typeof fromRow === "string" && fromRow ? fromRow : template.object,
    filter: template.filter ? resolveFilter(template.filter, row, params) : null,
  };
}
