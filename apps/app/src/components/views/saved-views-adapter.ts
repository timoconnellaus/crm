// Persistence for saved views: the `view.*` operations, stored in `core_views`, personal or
// shared with the org. The menu talks to this small adapter so it does not care where views live
// (tests can pass another). A saved view's spec is any object view type (ADR 0056).
import type { Filter, ObjectViewSpec, ObjectViewType, Sort } from "@crm/core/client";
import { callOp } from "#/lib/operations";
import type { LayoutConfig } from "./view-state.ts";

/** Objects a saved view can list: core objects and extension objects (`<extension>.<object>`). */
export type SavedViewObject = "person" | "organisation" | "activity" | "task" | (string & {});

/** A saved view, as the list pages apply it. */
export interface SavedView {
  id: string;
  name: string;
  object: string;
  spec: SavedViewSpec;
  /** Shared with the org (members see it; the owner and admins change it). */
  shared?: boolean;
  /** Whether the caller may update or delete it. */
  canEdit?: boolean;
}

export interface SavedViewSpec {
  type: ObjectViewType;
  filter?: Filter;
  sort?: Sort;
  columns?: string[];
  layout?: LayoutConfig;
}

export interface SavedViewsAdapter {
  list(object: SavedViewObject): Promise<SavedView[]>;
  create(input: {
    object: SavedViewObject;
    name: string;
    spec: SavedViewSpec;
    shared?: boolean;
  }): Promise<SavedView>;
  update(id: string, input: { name?: string; spec?: SavedViewSpec }): Promise<SavedView>;
  remove(id: string): Promise<void>;
}

type StoredView = Awaited<ReturnType<typeof callOp<"view.create">>>;

/** A stored spec → what the list page applies. */
export function fromStoredSpec(spec: ObjectViewSpec): SavedViewSpec {
  const common = {
    type: spec.type,
    ...(spec.filter ? { filter: spec.filter } : {}),
    ...("sort" in spec && spec.sort ? { sort: spec.sort as Sort } : {}),
  };
  switch (spec.type) {
    case "table":
      return { ...common, columns: spec.columns };
    case "board":
      return {
        ...common,
        layout: {
          groupBy: spec.groupBy,
          ...(spec.sumField ? { sumField: spec.sumField } : {}),
          ...(spec.columnOrder ? { columnOrder: spec.columnOrder } : {}),
          cardFields: spec.cardFields,
        },
      };
    case "calendar":
      return {
        ...common,
        layout: { dateField: spec.dateField, mode: spec.mode, cardFields: spec.cardFields },
      };
    case "gallery":
      return {
        ...common,
        layout: {
          ...(spec.imageField ? { imageField: spec.imageField } : {}),
          cardFields: spec.cardFields,
        },
      };
  }
}

function fromStored(view: StoredView): SavedView {
  return {
    id: view.id,
    name: view.name,
    object: view.object,
    spec: fromStoredSpec(view.spec),
    shared: view.shared,
    canEdit: view.canEdit,
  };
}

/** What the list page holds → a view spec for view.create / view.update. */
export function toStoredSpec(
  object: string,
  spec: SavedViewSpec,
  fallbackColumns: string[] = [],
): ObjectViewSpec {
  const filter = spec.filter ?? null;
  const sort = spec.sort ?? null;
  const layout = spec.layout ?? {};
  const cardFields = layout.cardFields ?? [];
  switch (spec.type) {
    case "board":
      return {
        type: "board",
        object,
        filter,
        sort,
        groupBy: layout.groupBy ?? "",
        sumField: layout.sumField ?? null,
        columnOrder: layout.columnOrder ?? null,
        cardFields,
      };
    case "calendar":
      return {
        type: "calendar",
        object,
        filter,
        dateField: layout.dateField ?? "",
        mode: layout.mode ?? "month",
        cardFields,
      };
    case "gallery":
      return {
        type: "gallery",
        object,
        filter,
        sort,
        imageField: layout.imageField ?? null,
        cardFields,
      };
    default:
      return {
        type: "table",
        object,
        filter,
        sort,
        columns: spec.columns?.length ? spec.columns : fallbackColumns,
      };
  }
}

export const operationSavedViews: SavedViewsAdapter = {
  async list(object) {
    const { items } = await callOp("view.list", { object });
    return items.map(fromStored);
  },
  async create({ object, name, spec, shared }) {
    return fromStored(
      await callOp("view.create", {
        name,
        spec: toStoredSpec(object, spec),
        shared: shared ?? false,
      }),
    );
  },
  async update(id, { name, spec }) {
    if (!spec) return fromStored(await callOp("view.update", { id, ...(name ? { name } : {}) }));
    // A spec names its object; keep the view's own.
    const current = await callOp("view.get", { id });
    const fallback = current.spec.type === "table" ? current.spec.columns : [];
    return fromStored(
      await callOp("view.update", {
        id,
        ...(name ? { name } : {}),
        spec: toStoredSpec(current.object, spec, fallback),
      }),
    );
  },
  async remove(id) {
    await callOp("view.delete", { id });
  },
};

/** The adapter the app uses. */
export const savedViews: SavedViewsAdapter = operationSavedViews;
