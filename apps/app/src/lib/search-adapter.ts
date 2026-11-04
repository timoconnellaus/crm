// Global search for the command palette: `search.global` (FTS5 over people, organisations,
// activities and tasks, prefix match as you type), with each hit's route.
import type { HighlightSegment } from "@crm/core";
import { callOp } from "./operations.ts";

export type { HighlightSegment };

export interface SearchHit {
  object: "person" | "organisation" | "activity" | "task";
  id: string;
  title: string;
  subtitle?: string | null;
  /** The title in plain and matching parts (render matches highlighted, never as HTML). */
  titleHighlight?: HighlightSegment[];
  /** A matching excerpt of other text (an email, a domain, a note), or null. */
  snippet?: HighlightSegment[] | null;
  /** Router path to open the hit. */
  href: string;
}

export interface SearchAdapter {
  search(query: string, options?: { limit?: number }): Promise<SearchHit[]>;
}

/** Where a hit opens. Activities and tasks have no page of their own: open a linked record. */
function hrefFor(hit: { object: SearchHit["object"]; id: string }): string {
  switch (hit.object) {
    case "person":
      return `/people/${hit.id}`;
    case "organisation":
      return `/organisations/${hit.id}`;
    case "task":
      return "/tasks";
    case "activity":
      return "/activity";
  }
}

export const globalSearch: SearchAdapter = {
  async search(query, { limit = 8 } = {}) {
    const q = query.trim();
    if (!q) return [];
    const { hits } = await callOp("search.global", { query: q, limit });
    return hits.map((hit) => ({ ...hit, href: hrefFor(hit) }));
  },
};

/** The adapter the palette uses. */
export const searchAdapter: SearchAdapter = globalSearch;
