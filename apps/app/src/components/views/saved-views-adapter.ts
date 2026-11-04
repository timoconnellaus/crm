// Persistence for saved views: the `view.*` operations, stored per user in `core_views`. The
// menu talks to this small adapter so it does not care where views live (tests can pass another).
import type { Filter, Sort } from "@crm/core/client";
import { callOp } from "#/lib/operations";

/** Objects a saved view can list. */
export type SavedViewObject = "person" | "organisation" | "activity" | "task";

/**
 * A saved view: `{ object, filter, sort, columns }`, the stage-1 form of a stage-4 `table` view
 * spec (`spec` is what goes in `core_views.spec`).
 */
export interface SavedView {
  id: string;
  name: string;
  object: string;
  spec: SavedViewSpec;
}

export interface SavedViewSpec {
  type: "table";
  filter?: Filter;
  sort?: Sort;
  columns?: string[];
}

export interface SavedViewsAdapter {
  list(object: SavedViewObject): Promise<SavedView[]>;
  create(input: { object: SavedViewObject; name: string; spec: SavedViewSpec }): Promise<SavedView>;
  update(id: string, input: { name?: string; spec?: SavedViewSpec }): Promise<SavedView>;
  remove(id: string): Promise<void>;
}

type StoredView = Awaited<ReturnType<typeof callOp<"view.create">>>;

function fromStored(view: StoredView): SavedView {
  const { spec } = view;
  return {
    id: view.id,
    name: view.name,
    object: view.object,
    spec: {
      type: "table",
      ...(spec.filter ? { filter: spec.filter } : {}),
      ...(spec.sort ? { sort: spec.sort as Sort } : {}),
      columns: spec.columns,
    },
  };
}

function toStored(object: string, spec: SavedViewSpec, fallbackColumns?: string[]) {
  return {
    type: "table" as const,
    object: object as SavedViewObject,
    filter: spec.filter ?? null,
    sort: spec.sort ?? null,
    columns: spec.columns?.length ? spec.columns : (fallbackColumns ?? []),
  };
}

export const operationSavedViews: SavedViewsAdapter = {
  async list(object) {
    const { items } = await callOp("view.list", { object });
    return items.map(fromStored);
  },
  async create({ object, name, spec }) {
    return fromStored(await callOp("view.create", { name, spec: toStored(object, spec) }));
  },
  async update(id, { name, spec }) {
    if (!spec) return fromStored(await callOp("view.update", { id, ...(name ? { name } : {}) }));
    // A spec names its object; keep the view's own.
    const current = (await callOp("view.list", {})).items.find((v) => v.id === id);
    if (!current) throw new Error("That view no longer exists");
    return fromStored(
      await callOp("view.update", {
        id,
        ...(name ? { name } : {}),
        spec: toStored(current.object, spec, current.spec.columns),
      }),
    );
  },
  async remove(id) {
    await callOp("view.delete", { id });
  },
};

/** The adapter the app uses. */
export const savedViews: SavedViewsAdapter = operationSavedViews;
