// Global search for the command palette, behind an adapter.
//
// TODO(stage-1-wire): replace `interimSearch` with `search.global` { query, limit } → ranked
// hits across people, organisations, activities and tasks (FTS5, core_search). Until then it
// searches people by name and email through `person.list`.
import type { Filter } from "@crm/core/client";
import { callOp } from "./operations.ts";

export interface SearchHit {
  object: "person" | "organisation" | "activity" | "task";
  id: string;
  title: string;
  subtitle?: string | null;
  /** Router path to open the hit. */
  href: string;
}

export interface SearchAdapter {
  search(query: string, options?: { limit?: number }): Promise<SearchHit[]>;
}

export const interimSearch: SearchAdapter = {
  async search(query, { limit = 8 } = {}) {
    const q = query.trim();
    if (!q) return [];
    const filter: Filter = {
      or: [
        { field: "displayName", op: "contains", value: q },
        { field: "emails", op: "contains", value: q },
      ],
    };
    const page = await callOp("person.list", {
      filter,
      limit,
      fields: ["displayName", "primaryEmail", "organisationName"],
    });
    return page.items.map((person) => ({
      object: "person",
      id: person.id,
      title: person.displayName ?? person.id,
      subtitle: [person.primaryEmail, person.organisationName].filter(Boolean).join(" · ") || null,
      href: `/people/${person.id}`,
    }));
  },
};

/** The adapter the palette uses. Swap here when `search.global` lands. */
export const searchAdapter: SearchAdapter = interimSearch;
