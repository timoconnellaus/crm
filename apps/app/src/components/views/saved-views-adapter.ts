// Persistence for saved views, behind a small adapter so the UI does not care where views live.
//
// TODO(stage-1-wire): replace `localSavedViews` with an adapter over the `view.*` operations
// (`view.list` { object } → views, `view.create` { object, name, spec }, `view.update`
// { id, name?, spec? }, `view.delete` { id }), stored per user in `core_views`. Until then views
// are kept in this browser's localStorage so the UI is usable end to end.
import type { Filter, Sort } from "@crm/core/client";

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
  list(object: string): Promise<SavedView[]>;
  create(input: { object: string; name: string; spec: SavedViewSpec }): Promise<SavedView>;
  update(id: string, input: { name?: string; spec?: SavedViewSpec }): Promise<SavedView>;
  remove(id: string): Promise<void>;
}

const STORAGE_KEY = "crm-saved-views";

function readAll(): SavedView[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SavedView[]) : [];
  } catch {
    return [];
  }
}

function writeAll(views: SavedView[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(views));
  } catch {
    // Storage unavailable (private mode): views last for this page view only.
  }
}

/** Interim adapter: this browser's localStorage. */
export const localSavedViews: SavedViewsAdapter = {
  async list(object) {
    return readAll().filter((view) => view.object === object);
  },
  async create({ object, name, spec }) {
    const view: SavedView = { id: `view_local_${crypto.randomUUID()}`, name, object, spec };
    writeAll([...readAll(), view]);
    return view;
  },
  async update(id, input) {
    const views = readAll();
    const current = views.find((view) => view.id === id);
    if (!current) throw new Error("That view no longer exists");
    const next = { ...current, ...input };
    writeAll(views.map((view) => (view.id === id ? next : view)));
    return next;
  },
  async remove(id) {
    writeAll(readAll().filter((view) => view.id !== id));
  },
};

/** The adapter the app uses. Swap here when `view.*` operations land. */
export const savedViews: SavedViewsAdapter = localSavedViews;
