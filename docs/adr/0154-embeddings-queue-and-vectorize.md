# ADR 0154: Record embeddings: a queue, a text hash and Vectorize

Status: accepted, 2026-11-05 (stage 7a build). The stage spec says embeddings are "updated through
the stage-5 event queue"; stage 5 is being built in parallel, so this ADR adds a seam it can take
over (see Consequences).

## Context
Semantic search needs an embedding per record, kept current as records change, at low cost. The
cost audit (U9) found the naive design (re-embed on every update event, embed every keystroke)
would cost about $40 a month, mostly re-embedding unchanged text. Vectorize has no local
simulation ([local development](https://developers.cloudflare.com/workers/local-development/)).

## Decision

### What is embedded
`embeddingTexts` builds each record's text from live tables:
- people: name, title, organisation, location, tags, description;
- organisations: name, industry, domains, tags, description;
- activities: notes, emails, calls and meetings (not `system` posts), subject and body, **only**
  when not deleted, not private (`private_to IS NULL`) and synced with full disclosure
  (`disclosure IS NULL OR 'full'`). Restricted reads (ADR 0112) are never written to D1 at all;
- tasks: title and notes;
- extension objects with a title field: the title and up to 8 text fields (a deal's name, next
  step, …).
Text is capped at 2,000 characters (the default model reads 512 tokens). A record with no text has
no vector.

### The queue (`core_embedding_queue`, migration 0150)
- The pipeline adds one statement to a write's own D1 batch: `INSERT … ON CONFLICT` of the
  embeddable records it changed (`embeddingQueueStatement`). Updates only queue when a field that
  feeds the text changed (a timezone edit queues nothing); an affiliation change queues its person.
  Operations whose writes are not record changes queue themselves: `sync.ingest` (synced
  activities) and `person.erase` / `organisation.erase` (the records, their own and shared
  activities and tasks).
- This is the only cost on the write path: one small row per changed record, in a batch that is
  already being written; no extra round trip and nothing on reads.

### The drain (`drainEmbeddingQueue`)
- Takes up to 100 queued rows, builds their texts, hashes `provider:model + text` (SHA-256) and
  compares with `core_embedding.text_hash`. **Only changed texts are embedded**, in calls of at
  most 100 (the bge models' limit,
  [bge-small-en-v1.5](https://developers.cloudflare.com/workers-ai/models/bge-small-en-v1.5/)).
  Records with no text have their vector deleted (`deleteByIds`) and their state row removed.
- Vectorize `upsert` in batches of up to 1,000 ([limits](https://developers.cloudflare.com/vectorize/platform/limits/)),
  ids `<object>:<id>` (a SHA-256 prefix when that would pass 64 bytes), metadata `{ object, id }`
  with a metadata index on `object` so queries can filter by type
  ([metadata filtering](https://developers.cloudflare.com/vectorize/reference/metadata-filtering/)).
- Then one D1 batch: state rows upserted, queue rows deleted only if not re-queued meanwhile.
  A failure leaves the rows queued with `attempts + 1`; after 8 attempts a row is left for an
  admin to look at (Settings → AI shows the queue size).
- **When it runs**: ros-app's **post-commit hook** (`InvocationContext.onCommitted`, called after
  a successful batch) starts a drain with `waitUntil` when the write queued anything, one drain at
  a time per isolate, coalescing writes that arrive meanwhile. A **10-minute cron** catches up
  whatever a drain missed and walks existing records once (`backfillEmbeddingQueue`, a rowid
  cursor over `core_search_docs` stored in `core_settings`) so a deployment upgraded to stage 7
  gets its history indexed without a scan per run.

### Vectorize
One index, `ros-records`, cosine, 384 dimensions (the shipped `bge-small-en-v1.5`), with a string
metadata index on `object`. `pnpm run deploy` creates it when missing
(`wrangler vectorize create … --dimensions=384 --metric=cosine` and
`create-metadata-index --property-name=object --type=string`,
[client API](https://developers.cloudflare.com/vectorize/reference/client-api/)) and binds it as
`VECTORIZE` (ADR 0156). Changing the embed role to a model of another size needs a new index; the
registry refuses a model whose dimensions differ from `VECTORIZE_DIMENSIONS` (ADR 0150).

### Erase (ADR 0019)
An erase queues every record that held the subject's text and drains right after its commit, so
their vectors are deleted (or re-embedded from the scrubbed text) within the request's
`waitUntil`; the cron retries if that fails. `core_embedding` holds ids and hashes only, nothing
to redact. Tested in `packages/core/test/ai-embeddings.test.ts`.

## Cost
Per the Vectorize pricing ([pricing](https://developers.cloudflare.com/vectorize/platform/pricing/)),
100,000 records × 384 dimensions is 38.4M stored dimensions: Workers Paid includes 10M and charges
$0.05 per further 100M, about 1.5 cents a month. Queried dimensions are counted as (queries +
stored vectors) × dimensions; 30,000 searches a month over 100,000 records is about 50M, the
included amount, then $0.01 per million. A 768- or 1,024-dimension model would cost 2–3 times
as much, which is why the default is 384 (cost audit U9). Embedding is $0.02 per million tokens
for bge-small; re-embedding only on hash changes keeps that to new and edited text.

## Consequences
- **The seam for stage 5.** The producer side is replaceable without touching what is embedded or
  how: stage 7b can drop the pipeline's queue statement and have stage 5's event-queue consumer
  call `enqueueEmbeddings(refs)` (or `drainEmbeddingQueue` directly), and set `onCommitted` to
  nothing. `drainEmbeddingQueue`, the hash and the texts stay the same.
- Freshness is seconds after a write (the post-commit drain), at worst 10 minutes (the cron).
- Vectorize mutations are asynchronous ("a few seconds"), so a record may not appear in semantic
  results immediately after being embedded.
- In local development and e2e there is no Vectorize: with `AI_FAKE_MODEL=true` ros-app keeps
  vectors in memory per isolate (ADR 0156).

## Amendment, 2026-11-05 (merged with stage 5: embeddings move onto the event queue)
Stage 5 (ADR 0130) landed while 7a was in review: after every commit the pipeline sends the
record changes to the `ros-automation-events` queue, consumed by ros-runner in batches of up to
100 messages. Embeddings now use that path:

- **Where a deployment has Vectorize** (the deploy script binds `VECTORIZE` and `AI` on both
  Workers), ros-app and ros-runner set `InvocationContext.embedViaEvents`. The pipeline then
  writes **no** `core_embedding_queue` row: the cost on the write path is zero beyond the event
  stage 5 already sends. ros-runner's queue handler calls `embedRecordEvents` after dispatching
  automations. It maps the batch's record changes to records whose embedded text may have changed
  (the same field rules; an affiliation event re-embeds its person, looked up by id), then embeds
  only changed hashes, at most 100 per model call. A redelivered batch costs no model call because
  the hash matches. If the model or Vectorize fails, those records are written to
  `core_embedding_queue` for the cron to retry, and the queue batch is not failed, so automations
  are not redelivered for an embedding problem.
- **Exactly once.** For each write, either the event path embeds it (`embedViaEvents`) or the
  pipeline queues it in its batch (no Vectorize: local development, e2e, tests and scripts), never
  both. Erase and sync are unchanged: stage 5 emits no event for an erase (the record is gone), and
  `sync.ingest` writes activities without record changes, so both still queue their records
  themselves and ros-app drains right after the commit.
- ros-app's 10-minute cron still runs the one-time backfill and drains the queue: the failures
  above, erase, sync, and anything written without `embedViaEvents`.
- The in-memory vector store of local development lives in ros-app, so locally ros-app keeps the
  queue path even though events are sent.

