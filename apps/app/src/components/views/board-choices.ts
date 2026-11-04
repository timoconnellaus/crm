// A board's columns (ADR 0056, ADR 0103): a single-select's choices, or the records a relation
// points at. When the relation is the object's stage (its stage behaviour), columns are the
// stages in order, limited to the pipeline the board's filter names, so a Deals board shows
// Lead → Qualified → … → Won, Lost.
import type { Filter } from "@crm/core/client";
import { useQuery } from "@tanstack/react-query";
import { callOp } from "#/lib/operations";
import type { FieldInfo, ObjectInfo } from "#/lib/schema";

export interface BoardChoice {
  value: string;
  label: string;
}

interface Stages {
  field: string;
  group?: string;
  stage: { order: string; group?: string };
}

/** The value of an `eq` condition on `field` at the top of a filter (or of its `and`). */
export function eqValue(filter: Filter | null | undefined, field: string): string | null {
  if (!filter) return null;
  if ("field" in filter) {
    return filter.field === field && filter.op === "eq" && typeof filter.value === "string"
      ? filter.value
      : null;
  }
  if ("and" in filter) {
    for (const part of filter.and) {
      const found = eqValue(part, field);
      if (found) return found;
    }
  }
  return null;
}

function relationTarget(info: ObjectInfo, field: string): string {
  const to = info.fields.find((f) => f.name === field)?.options?.to;
  return typeof to === "string" ? to : "";
}

function selectChoices(field: FieldInfo): BoardChoice[] {
  const choices = field.options?.choices as { value: string; label?: string }[] | undefined;
  if (choices) return choices.map((c) => ({ value: c.value, label: c.label ?? c.value }));
  return (field.enumValues ?? []).map((v) => ({
    value: v,
    label: v.charAt(0).toUpperCase() + v.slice(1),
  }));
}

export function useBoardChoices(
  info: ObjectInfo,
  field: FieldInfo | undefined,
  filter: Filter | null | undefined,
): BoardChoice[] {
  const to = field?.fieldType === "relation" ? String(field.options?.to ?? "") : "";
  const stages = info.stages as Stages | null;
  const isStage = Boolean(field && stages && stages.field === field.name);
  const group = isStage && stages?.group ? eqValue(filter, stages.group) : null;
  const related = useQuery({
    queryKey: ["op", "record.list", to, "board-choices", isStage, group],
    enabled: Boolean(to),
    staleTime: 60_000,
    queryFn: () =>
      callOp("record.list", {
        object: to,
        limit: 200,
        ...(isStage && stages
          ? {
              sort: { field: stages.stage.order, direction: "asc" as const },
              ...(group && stages.stage.group
                ? { filter: { field: stages.stage.group, op: "eq" as const, value: group } }
                : {}),
            }
          : {}),
      }),
  });
  // Without a group in the filter, stages of every group show, grouped in the group object's
  // default order (pipelines by name) and then by stage order.
  const groupObject = isStage && !group && stages?.group ? relationTarget(info, stages.group) : "";
  const groups = useQuery({
    queryKey: ["op", "record.list", groupObject, "board-groups"],
    enabled: Boolean(groupObject),
    staleTime: 60_000,
    queryFn: () => callOp("record.list", { object: groupObject, limit: 200 }),
  });
  if (!field) return [];
  if (!to) return selectChoices(field);
  const items = related.data?.items ?? [];
  if (!groupObject || !stages?.stage.group) {
    return items.map((r) => ({ value: r.id, label: r.title ?? r.id }));
  }
  const order = new Map((groups.data?.items ?? []).map((g, i) => [g.id, i] as const));
  const titles = new Map((groups.data?.items ?? []).map((g) => [g.id, g.title] as const));
  const key = stages.stage.group;
  return items
    .map((r, i) => ({ r, i, g: String(r.values[key] ?? "") }))
    .sort((a, b) => (order.get(a.g) ?? 999) - (order.get(b.g) ?? 999) || a.i - b.i)
    .map(({ r, g }) => ({
      value: r.id,
      label: titles.size > 1 && titles.get(g) ? `${titles.get(g)}: ${r.title}` : (r.title ?? r.id),
    }));
}
