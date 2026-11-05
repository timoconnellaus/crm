# ADR 0155: Hybrid search, similar records and retrieval

Status: accepted, 2026-11-05 (stage 7a build). Builds on ADR 0154. The assistant that uses the
retrieval API is stage 7b.

## Decision
- **`search.hybrid { query, objects?, limit, withText? }`** (read, MCP-exposed, not curated) merges
  three ranked lists by weighted **reciprocal rank fusion**, score = Σ weight / (60 + rank)
  (`packages/core/src/ai/hybrid.ts`):
  1. full-text, every word as a prefix (search.global's FTS5 query), weight 1.0;
  2. full-text, any word of 3+ letters (recall for questions phrased in sentences), weight 0.5;
  3. semantic: the query embedded by the `embed` role, nearest 30 vectors in Vectorize (filtered
     by object type), weight 1.0.
  A record found by several lists rises; each hit says how it matched (`text`, `meaning`). Hits
  are hydrated through the same `crm_*` views as search.global, so deleted and private records
  never appear even if a vector is briefly stale. Without AI or Vectorize the semantic list is
  empty and the ranking is full-text only; a model or Vectorize error also falls back.
- **Cmd-K** keeps search.global for type-ahead and asks search.hybrid only after typing pauses
  (and for 3+ characters), showing extra hits under "Related by meaning". Query embeddings are
  cached per isolate (200 entries), so a repeated query costs no model call.
- **`record.similar { object, id }`** queries Vectorize with the record's **stored** vector
  (`getByIds`), so it costs no model call; it says `not_indexed` before the record is embedded
  and `unavailable` without Vectorize. Record pages show it as "Similar records".
- **Retrieval for the assistant (7b)**: `retrieve(deps, { query, objects?, limit })` returns hybrid
  hits with the text each was indexed by (`withText`), ready for a prompt, under the same
  visibility rules. `search.hybrid { withText: true }` is the same thing over MCP.

## Relevance set (stage 7 AC 7)
`packages/core/test/fixtures/relevance.ts` is a small CRM (8 organisations, 7 people, 8 notes, 3
tasks) and 20 queries, each with the record it must find in the top 5, phrased mostly without the
record's own words. `ai-relevance.test.ts` runs it with the deterministic fake embedder (word stems
and character trigrams): 19 of 20 in the top 5, against fewer than 17 for full-text alone, which
the same test asserts. `pnpm --filter @relationship-os/core relevance:real` runs the set with the real
Workers AI embedding model (needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`) and prints
the report.

## Consequences
- Fusion by rank needs no score calibration between BM25 and cosine similarity, and is cheap: at
  most 90 candidates, then one hydration query per object type.
- Natural-language queries do two FTS queries plus one embedding and one Vectorize query; the
  rows-read budget for search.hybrid is in `ai-rows-read.test.ts`.
- The weights are fixed in code; tune them with the real-model relevance run before making them
  settings.
