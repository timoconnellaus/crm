// The filter builder's model: an editable draft tree (groups of conditions, with raw input text)
// and its conversion to and from filter JSON (`Filter` from @relationship-os/core, ADR 0016). Pure, so it is
// unit-tested without a DOM. Operators come from the field's type (OPS_BY_TYPE, narrowed for
// multi-valued fields), and every emitted filter is checked with `filterSchema`.
import {
  FILTER_LIMITS,
  type FieldDefinition,
  type Filter,
  type FilterOp,
  filterSchema,
  getField,
  type ObjectDefinition,
  OPS_BY_TYPE,
  RELATED_OPS,
} from "@relationship-os/core/client";

export type GroupMode = "and" | "or";

export interface DraftCondition {
  kind: "condition";
  id: string;
  field: string;
  op: FilterOp;
  /** Raw input. Lists (`in`, `not_in`) are comma-separated; `between` uses value and value2. */
  value: string;
  value2: string;
}

export interface DraftGroup {
  kind: "group";
  id: string;
  mode: GroupMode;
  children: DraftNode[];
}

export type DraftNode = DraftCondition | DraftGroup;

let nextId = 0;
const draftId = () => `f${++nextId}`;

export const OP_LABELS: Record<FilterOp, string> = {
  eq: "is",
  neq: "is not",
  lt: "before / less than",
  lte: "on or before / at most",
  gt: "after / more than",
  gte: "on or after / at least",
  between: "between",
  in: "is any of",
  not_in: "is none of",
  contains: "contains",
  not_contains: "does not contain",
  starts_with: "starts with",
  ends_with: "ends with",
  is_null: "is empty",
  is_not_null: "is not empty",
};

/** Fields the builder offers: filterable, with at least one operator. */
export function filterableFields(object: ObjectDefinition): FieldDefinition[] {
  return object.fields.filter((field) => field.filterable && opsForField(field).length > 0);
}

/** Operators a field supports: by type, and only "has a value that …" ops for list fields. */
export function opsForField(field: FieldDefinition): FilterOp[] {
  const byType = OPS_BY_TYPE[field.type];
  return field.related ? byType.filter((op) => RELATED_OPS.includes(op)) : [...byType];
}

export function opNeedsValue(op: FilterOp): boolean {
  return op !== "is_null" && op !== "is_not_null";
}

export function isListOp(op: FilterOp): boolean {
  return op === "in" || op === "not_in";
}

export function defaultOp(field: FieldDefinition): FilterOp {
  const ops = opsForField(field);
  if (field.type === "text" && ops.includes("contains")) return "contains";
  return ops[0] ?? "eq";
}

export function emptyGroup(mode: GroupMode = "and"): DraftGroup {
  return { kind: "group", id: draftId(), mode, children: [] };
}

export function newCondition(object: ObjectDefinition, fieldName?: string): DraftCondition {
  const fields = filterableFields(object);
  // Default to the field lists sort by (usually the name), else the first filterable one.
  const field =
    (fieldName && fields.find((f) => f.name === fieldName)) ||
    fields.find((f) => f.name === object.defaultSort.field) ||
    fields[0];
  if (!field) throw new Error(`${object.name} has no filterable fields`);
  const op = defaultOp(field);
  return {
    kind: "condition",
    id: draftId(),
    field: field.name,
    op,
    value: field.type === "boolean" ? "true" : "",
    value2: "",
  };
}

/** Changing the field resets the operator (and value) when the old one no longer applies. */
export function changeField(
  object: ObjectDefinition,
  condition: DraftCondition,
  fieldName: string,
): DraftCondition {
  const field = getField(object, fieldName);
  if (!field) return condition;
  const sameType = getField(object, condition.field)?.type === field.type;
  const op = opsForField(field).includes(condition.op) ? condition.op : defaultOp(field);
  return {
    ...condition,
    field: fieldName,
    op,
    value: sameType ? condition.value : field.type === "boolean" ? "true" : "",
    value2: sameType ? condition.value2 : "",
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Converts one raw input to the JSON value for `field`, or undefined when it is not valid yet. */
export function coerceValue(field: FieldDefinition, raw: string): unknown {
  const text = raw.trim();
  if (!text) return undefined;
  switch (field.type) {
    case "number": {
      const n = Number(text);
      return Number.isFinite(n) ? n : undefined;
    }
    case "boolean":
      return text === "true" ? true : text === "false" ? false : undefined;
    case "date":
      return DATE_RE.test(text) ? text : undefined;
    case "datetime":
      // A bare date compares against ISO timestamps as the start of that day.
      return DATE_RE.test(text) || !Number.isNaN(Date.parse(text)) ? text : undefined;
    case "enum":
      return field.enumValues?.includes(text) ? text : undefined;
    case "json":
      return undefined;
    default:
      return text;
  }
}

/** The JSON condition for a draft, or null when it is incomplete or invalid. */
export function conditionToFilter(object: ObjectDefinition, draft: DraftCondition): Filter | null {
  const field = getField(object, draft.field);
  if (!field?.filterable || !opsForField(field).includes(draft.op)) return null;
  if (!opNeedsValue(draft.op)) return { field: field.name, op: draft.op };
  if (isListOp(draft.op)) {
    const parts = draft.value
      .split(",")
      .map((part) => coerceValue(field, part))
      .filter((value) => value !== undefined);
    if (!parts.length || parts.length > FILTER_LIMITS.maxListValues) return null;
    return { field: field.name, op: draft.op, value: parts };
  }
  if (draft.op === "between") {
    const low = coerceValue(field, draft.value);
    const high = coerceValue(field, draft.value2);
    if (low === undefined || high === undefined) return null;
    return { field: field.name, op: draft.op, value: [low, high] };
  }
  const value = coerceValue(field, draft.value);
  if (value === undefined) return null;
  return { field: field.name, op: draft.op, value };
}

function nodeToFilter(object: ObjectDefinition, node: DraftNode): Filter | null {
  if (node.kind === "condition") return conditionToFilter(object, node);
  const children = node.children
    .map((child) => nodeToFilter(object, child))
    .filter((child): child is Filter => child !== null);
  if (!children.length) return null;
  return node.mode === "and" ? { and: children } : { or: children };
}

/**
 * The filter JSON for a draft tree. Incomplete conditions and empty groups are left out; an
 * entirely empty tree is `undefined` (no filter). Throws if the result fails `filterSchema`,
 * which would be a bug in this module.
 */
export function toFilter(object: ObjectDefinition, root: DraftGroup): Filter | undefined {
  const filter = nodeToFilter(object, root);
  if (!filter) return undefined;
  const parsed = filterSchema.safeParse(filter);
  if (!parsed.success) throw new Error(`filter builder emitted invalid JSON: ${parsed.error}`);
  return parsed.data;
}

function rawValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value);
}

function nodeFromFilter(object: ObjectDefinition, filter: Filter): DraftNode {
  if ("and" in filter || "or" in filter) {
    const mode: GroupMode = "and" in filter ? "and" : "or";
    const children = "and" in filter ? filter.and : (filter as { or: Filter[] }).or;
    return {
      kind: "group",
      id: draftId(),
      mode,
      children: children.map((child) => nodeFromFilter(object, child)),
    };
  }
  const { field, op, value } = filter;
  const list = Array.isArray(value) ? value : null;
  return {
    kind: "condition",
    id: draftId(),
    field,
    op,
    value:
      op === "between"
        ? rawValue(list?.[0])
        : list
          ? list.map(rawValue).join(", ")
          : rawValue(value),
    value2: op === "between" ? rawValue(list?.[1]) : "",
  };
}

/** A draft tree for an existing filter. The root is always a group. */
export function fromFilter(object: ObjectDefinition, filter: Filter | undefined): DraftGroup {
  if (!filter) return emptyGroup();
  const node = nodeFromFilter(object, filter);
  return node.kind === "group" ? node : { ...emptyGroup(), children: [node] };
}

/** How many conditions a filter has (for the "Filter (3)" badge). */
export function countConditions(filter: Filter | undefined): number {
  if (!filter) return 0;
  if ("and" in filter) return filter.and.reduce((n, child) => n + countConditions(child), 0);
  if ("or" in filter) return filter.or.reduce((n, child) => n + countConditions(child), 0);
  return 1;
}

/** Depth of a node: the root group is 1. Groups can nest up to FILTER_LIMITS.maxDepth. */
export const MAX_GROUP_DEPTH = FILTER_LIMITS.maxDepth - 1;

// --- Immutable tree edits, by node id ------------------------------------------------------------

export function updateNode(
  root: DraftGroup,
  id: string,
  update: (node: DraftNode) => DraftNode,
): DraftGroup {
  const visit = (node: DraftNode): DraftNode => {
    if (node.id === id) return update(node);
    if (node.kind === "group") return { ...node, children: node.children.map(visit) };
    return node;
  };
  return visit(root) as DraftGroup;
}

export function removeNode(root: DraftGroup, id: string): DraftGroup {
  const visit = (group: DraftGroup): DraftGroup => ({
    ...group,
    children: group.children
      .filter((child) => child.id !== id)
      .map((child) => (child.kind === "group" ? visit(child) : child)),
  });
  return visit(root);
}

export function appendChild(root: DraftGroup, groupId: string, child: DraftNode): DraftGroup {
  return updateNode(root, groupId, (node) =>
    node.kind === "group" ? { ...node, children: [...node.children, child] } : node,
  );
}
