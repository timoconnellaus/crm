// Hybrid search (ADR 0155): FTS5 and vector results merged by weighted reciprocal rank fusion.
//
//   lexical, all words    (search.global's prefix match)        weight 1.0
//   lexical, any word     (recall for natural-language queries) weight 0.5
//   semantic              (embed role → Vectorize nearest)      weight 1.0
//
// score = Σ weight / (K + rank). A record found by several lists rises; one found by only one
// still ranks by how high that list put it. Without AI or Vectorize the semantic list is empty
// and the ranking is the lexical one. Query embeddings are cached per isolate, and callers embed
// only when typing pauses (Cmd-K), never per keystroke.
import type { CoreDatabase } from "@crm/db";
import { type Kysely, sql } from "kysely";
import { listObjects } from "../fields/index.ts";
import {
  ftsQuery,
  highlight,
  loadDisplays,
  type SearchHit,
  SNIPPET_CLOSE,
  SNIPPET_OPEN,
  searchTerms,
  snippetSegments,
} from "../operations/search.ts";
import { jsonList } from "../records/common.ts";
import type { ModelRunner } from "./client.ts";
import { embeddingTexts, isEmbeddable } from "./embedding.ts";
import { type VectorStore, vectorId } from "./vectors.ts";

export const RRF_K = 60;
const WEIGHTS = { all: 1, any: 0.5, vector: 1 } as const;
const CANDIDATES = 30;

export type MatchSource = "text" | "meaning";

export interface HybridHit extends SearchHit {
  score: number;
  matchedBy: MatchSource[];
  /** The record's indexed text, when asked for (retrieval for the assistant). */
  text?: string;
}

export interface HybridDeps {
  db: Kysely<CoreDatabase>;
  models?: ModelRunner | undefined;
  vectors?: VectorStore | undefined;
}

const queryCache = new Map<string, number[]>();
const QUERY_CACHE_SIZE = 200;

/** The query's embedding, cached per isolate (LRU by insertion order). */
async function embedQuery(models: ModelRunner, query: string): Promise<number[] | null> {
  if (!models.embed) return null;
  const key = query.trim().toLowerCase();
  const hit = queryCache.get(key);
  if (hit) {
    queryCache.delete(key);
    queryCache.set(key, hit);
    return hit;
  }
  const { vectors } = await models.embed([key]);
  const vector = vectors[0];
  if (!vector) return null;
  queryCache.set(key, vector);
  if (queryCache.size > QUERY_CACHE_SIZE)
    queryCache.delete(queryCache.keys().next().value as string);
  return vector;
}

/** Test hook: forget cached query embeddings. */
export function clearQueryEmbeddingCache(): void {
  queryCache.clear();
}

interface Ranked {
  object: string;
  id: string;
  snip?: string | null;
}

async function lexical(
  db: Kysely<CoreDatabase>,
  match: string,
  objects: readonly string[],
): Promise<Ranked[]> {
  const rows = await sql<{ object_type: string; record_id: string; snip: string | null }>`
    SELECT d.object_type, d.record_id,
      snippet(core_search, 1, ${SNIPPET_OPEN}, ${SNIPPET_CLOSE}, '…', 10) AS snip
    FROM core_search JOIN core_search_docs d ON d.id = core_search.rowid
    WHERE core_search MATCH ${match} AND d.object_type IN ${jsonList([...objects])}
    ORDER BY bm25(core_search, 10.0, 1.0), d.id
    LIMIT ${CANDIDATES}`.execute(db);
  return rows.rows.map((r) => ({ object: r.object_type, id: r.record_id, snip: r.snip }));
}

export interface HybridOptions {
  query: string;
  objects?: readonly string[] | undefined;
  limit: number;
  /** Use the semantic list (default true when AI and Vectorize are configured). */
  semantic?: boolean;
  /** Attach each hit's indexed text (for retrieval). */
  withText?: boolean;
}

export interface HybridResult {
  hits: HybridHit[];
  /** Whether the semantic list took part. */
  semantic: boolean;
}

export async function hybridSearch(
  deps: HybridDeps,
  options: HybridOptions,
): Promise<HybridResult> {
  const terms = searchTerms(options.query);
  const objects = options.objects?.length ? [...options.objects] : listObjects().map((o) => o.name);
  const lists: { weight: number; source: MatchSource; items: Ranked[] }[] = [];
  if (terms.length) {
    lists.push({
      weight: WEIGHTS.all,
      source: "text",
      items: await lexical(deps.db, ftsQuery(terms), objects),
    });
    if (terms.length > 1) {
      const any = terms
        .filter((t) => t.length >= 3)
        .map((t) => `"${t}"*`)
        .join(" OR ");
      if (any)
        lists.push({
          weight: WEIGHTS.any,
          source: "text",
          items: await lexical(deps.db, any, objects),
        });
    }
  }
  let semantic = false;
  if (
    options.semantic !== false &&
    deps.models?.embed &&
    deps.vectors &&
    options.query.trim().length >= 3
  ) {
    try {
      const vector = await embedQuery(deps.models, options.query);
      if (vector) {
        const matches = await deps.vectors.query(vector, {
          topK: CANDIDATES,
          objects: objects.filter(isEmbeddable),
        });
        lists.push({
          weight: WEIGHTS.vector,
          source: "meaning",
          items: matches.map((m) => ({ object: m.object, id: m.id })),
        });
        semantic = true;
      }
    } catch (error) {
      // Semantic search is an enhancement: a model or Vectorize failure falls back to text.
      console.error("semantic search failed", error);
    }
  }
  return { hits: await fuse(deps.db, lists, terms, options), semantic };
}

async function fuse(
  db: Kysely<CoreDatabase>,
  lists: { weight: number; source: MatchSource; items: Ranked[] }[],
  terms: string[],
  options: Pick<HybridOptions, "limit" | "withText">,
): Promise<HybridHit[]> {
  const scored = new Map<
    string,
    { object: string; id: string; score: number; by: Set<MatchSource>; snip: string | null }
  >();
  for (const list of lists) {
    list.items.forEach((item, rank) => {
      const key = `${item.object}\u0000${item.id}`;
      const entry = scored.get(key) ?? {
        object: item.object,
        id: item.id,
        score: 0,
        by: new Set(),
        snip: null,
      };
      entry.score += list.weight / (RRF_K + rank + 1);
      entry.by.add(list.source);
      entry.snip ??= item.snip ?? null;
      scored.set(key, entry);
    });
  }
  const ranked = [...scored.values()].sort(
    (a, b) => b.score - a.score || a.object.localeCompare(b.object) || a.id.localeCompare(b.id),
  );
  // Over-fetch displays: some candidates may have been deleted since they were indexed.
  const top = ranked.slice(0, options.limit * 2);
  const ids = new Map<string, string[]>();
  for (const r of top) ids.set(r.object, [...(ids.get(r.object) ?? []), r.id]);
  const displays = await loadDisplays(db, ids);
  const texts = new Map<string, string>();
  if (options.withText) {
    for (const [object, list] of ids) {
      for (const [id, text] of await embeddingTexts(db, object, list))
        texts.set(`${object}\u0000${id}`, text);
    }
  }
  const hits: HybridHit[] = [];
  for (const r of top) {
    const display = displays.get(`${r.object}:${r.id}`);
    if (!display) continue;
    const text = texts.get(`${r.object}\u0000${r.id}`);
    hits.push({
      object: r.object,
      id: r.id,
      title: display.title,
      subtitle: display.subtitle,
      titleHighlight: highlight(display.title, terms),
      snippet: snippetSegments(r.snip),
      score: Math.round(r.score * 1e6) / 1e6,
      matchedBy: [...r.by].sort(),
      ...(text !== undefined ? { text } : {}),
    });
    if (hits.length >= options.limit) break;
  }
  return hits;
}

export type SimilarResult =
  | { status: "ok"; hits: HybridHit[] }
  | { status: "unavailable"; message: string }
  | { status: "not_indexed" };

/** Records whose embedding is closest to this record's (its stored vector; no model call). */
export async function similarRecords(
  deps: HybridDeps,
  options: { object: string; id: string; limit: number; objects?: readonly string[] | undefined },
): Promise<SimilarResult> {
  if (!deps.vectors) {
    return {
      status: "unavailable",
      message: "Semantic search is not configured (no Vectorize index)",
    };
  }
  const state = await deps.db
    .selectFrom("core_embedding")
    .select("vector_id")
    .where("object_type", "=", options.object)
    .where("record_id", "=", options.id)
    .executeTakeFirst();
  const vector = await deps.vectors.getVector(
    state?.vector_id ?? (await vectorId(options.object, options.id)),
  );
  if (!vector) return { status: "not_indexed" };
  const objects = options.objects?.length ? options.objects.filter(isEmbeddable) : undefined;
  const matches = await deps.vectors.query(vector, {
    topK: options.limit + 1,
    ...(objects ? { objects } : {}),
  });
  const items = matches.filter((m) => !(m.object === options.object && m.id === options.id));
  const hits = await fuse(deps.db, [{ weight: 1, source: "meaning", items }], [], {
    limit: options.limit,
  });
  return { status: "ok", hits };
}

/**
 * Retrieval for the assistant (stage 7b): the best records for a question, with the text each
 * was indexed by, ready to put in a prompt. Respects the same rules as search: deleted and
 * private records never appear.
 */
export async function retrieve(
  deps: HybridDeps,
  options: { query: string; objects?: readonly string[]; limit?: number },
): Promise<HybridHit[]> {
  const result = await hybridSearch(deps, {
    query: options.query,
    objects: options.objects,
    limit: options.limit ?? 8,
    withText: true,
  });
  return result.hits;
}
