// Record embeddings for semantic search (ADR 0154).
//
//   write (pipeline) ──► core_embedding_queue (same D1 batch as the change)
//                              │  drained after the commit (waitUntil) and by the cron
//                              ▼
//   drainEmbeddingQueue: text per record ─► SHA-256 ─► unchanged? skip : embed (batches of ≤100)
//                              ─► Vectorize upsert / delete ─► core_embedding (hash) ─► dequeue
//
// The text is built here, from the live tables, so it is never embedded for a record that is
// deleted, private (`private_to`), or synced with less than full disclosure: ADR 0112's
// restricted reads are never written at all, and metadata-only and private activities are
// skipped. A record with nothing to embed has its vector deleted, which is also how an erase
// (ADR 0019) removes vectors.
//
// The seam (`EmbeddingProducer`): today the pipeline enqueues and crm-app drains after the commit;
// stage 5's event queue can call `enqueueEmbeddings` / `drainEmbeddingQueue` from its consumer
// instead, without changing what is embedded or how.
import type { CoreDatabase, CrmDb } from "@crm/db";
import { type Compilable, type CompiledQuery, type Kysely, sql } from "kysely";

type Statement = Compilable | CompiledQuery;
import { getObject, isCoreObject, listObjects } from "../fields/index.ts";
import type { RecordChange } from "../operation.ts";
import { jsonList } from "../records/common.ts";
import type { ModelRunner } from "./client.ts";
import { type VectorStore, vectorId } from "./vectors.ts";

/** Characters of text per record (the default embedding model reads 512 tokens). */
export const EMBED_TEXT_CHARS = 2000;
/** Texts per model call (Workers AI's bge models accept 100). */
export const EMBED_BATCH = 100;
/** Queue rows taken per drain round. */
export const DRAIN_BATCH = 100;
/** A queue row that failed this often is left for an admin to look at. */
export const MAX_ATTEMPTS = 8;

/**
 * Operations that queue embeddings themselves (their writes are not RecordChanges the pipeline
 * sees: synced activities, everything an erase touches), so the post-commit drain still runs.
 */
export const SELF_ENQUEUEING: ReadonlySet<string> = new Set([
  "sync.ingest",
  "person.erase",
  "organisation.erase",
]);

/** Activity types worth embedding (not `system` posts like "Stage changed"). */
const ACTIVITY_TYPES = ["note", "email", "call", "meeting"];

/** Fields whose change can change a record's embedding text, per core object. */
const TEXT_FIELDS: Record<string, readonly string[]> = {
  person: ["displayName", "givenName", "familyName", "jobTitle", "organisationId", "description", "tags"],
  organisation: ["name", "industry", "description", "domains", "primaryDomain", "tags"],
  activity: ["subject", "body", "type", "private", "privateTo", "disclosure"],
  task: ["title", "notes"],
};

/** Is `object` embedded at all? Core objects, and extension objects with a title field. */
export function isEmbeddable(object: string): boolean {
  if (isCoreObject(object)) return object in TEXT_FIELDS;
  const def = getObject(object);
  return Boolean(def?.extension && def.titleField);
}

function extensionTextFields(object: string): { name: string; column: string; label: string }[] {
  const def = getObject(object);
  if (!def) return [];
  const title = def.titleField;
  return def.fields
    .filter((f) => f.type === "text" && f.column && f.name !== "id")
    .filter((f) => f.name === title || !f.readOnly)
    .slice(0, 8)
    .map((f) => ({ name: f.name, column: f.column as string, label: f.label }));
}

/** Would this change alter the record's embedding text? Creates and deletes always do. */
export function changeAffectsEmbedding(change: RecordChange): boolean {
  if (!isEmbeddable(change.object)) return false;
  if (change.action !== "update") return true;
  const fields = isCoreObject(change.object)
    ? TEXT_FIELDS[change.object]
    : extensionTextFields(change.object).map((f) => f.name);
  if (!fields) return false;
  const keys = change.diff
    ? Object.keys(change.diff)
    : [...new Set([...Object.keys(change.before ?? {}), ...Object.keys(change.after ?? {})])].filter(
        (k) => JSON.stringify(change.before?.[k]) !== JSON.stringify(change.after?.[k]),
      );
  return keys.some((k) => fields.includes(k));
}

export interface EmbeddingRef {
  object: string;
  id: string;
}

/**
 * One INSERT queueing `refs` (deduplicated, `json_each` so any number fits one statement).
 * Re-queueing a queued record moves it to the back and resets its attempts.
 */
export function enqueueEmbeddings(db: Kysely<CoreDatabase>, refs: readonly EmbeddingRef[], now: string): Statement | null {
  const unique = [...new Map(refs.map((r) => [`${r.object}\u0000${r.id}`, r])).values()];
  if (!unique.length) return null;
  const json = JSON.stringify(unique.map((r) => [r.object, r.id]));
  return sql`
    INSERT INTO core_embedding_queue (object_type, record_id, queued_at, attempts)
    SELECT json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), ${now}, 0
    FROM json_each(${json}) j
    WHERE true
    ON CONFLICT (object_type, record_id) DO UPDATE SET queued_at = excluded.queued_at, attempts = 0
  `.compile(db);
}

/** The pipeline's hook: queue the embeddable records a call changed. Null when there are none. */
export function embeddingQueueStatement(
  db: Kysely<CoreDatabase>,
  changes: readonly RecordChange[],
  now: string,
): Statement | null {
  const refs = changes.filter(changeAffectsEmbedding).map((c) => ({ object: c.object, id: c.id }));
  return enqueueEmbeddings(db, refs, now);
}

const clip = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, EMBED_TEXT_CHARS);
const line = (label: string, value: unknown) =>
  value === null || value === undefined || value === "" ? "" : `${label}: ${String(value)}\n`;

function jsonNames(value: string | null): string {
  try {
    const list = JSON.parse(value ?? "[]") as unknown;
    return Array.isArray(list) ? list.filter((v) => typeof v === "string").join(", ") : "";
  } catch {
    return "";
  }
}

/**
 * The text embedded for each record, by id. Records that are gone, private, metadata-only or
 * empty are absent: their vectors must not exist.
 */
export async function embeddingTexts(
  db: Kysely<CoreDatabase>,
  object: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const list = jsonList([...ids]);
  if (object === "person") {
    const rows = await sql<{
      id: string;
      display_name: string;
      job_title: string | null;
      organisation_name: string | null;
      location: string | null;
      tags: string | null;
      description: string | null;
    }>`SELECT p.id, p.display_name, p.job_title, p.organisation_name, p.location, p.tags,
         cp.description
       FROM crm_people p JOIN core_person cp ON cp.id = p.id WHERE p.id IN ${list}`.execute(db);
    for (const r of rows.rows) {
      out.set(
        r.id,
        clip(
          `${r.display_name}\n${line("Title", r.job_title)}${line("Organisation", r.organisation_name)}` +
            `${line("Location", r.location)}${line("Tags", jsonNames(r.tags))}${line("About", r.description)}`,
        ),
      );
    }
  } else if (object === "organisation") {
    const rows = await sql<{
      id: string;
      name: string;
      industry: string | null;
      domains: string | null;
      tags: string | null;
      description: string | null;
    }>`SELECT o.id, o.name, o.industry, o.domains, o.tags, co.description
       FROM crm_organisations o JOIN core_organisation co ON co.id = o.id
       WHERE o.id IN ${list}`.execute(db);
    for (const r of rows.rows) {
      out.set(
        r.id,
        clip(
          `${r.name}\n${line("Industry", r.industry)}${line("Domains", jsonNames(r.domains))}` +
            `${line("Tags", jsonNames(r.tags))}${line("About", r.description)}`,
        ),
      );
    }
  } else if (object === "activity") {
    // core_activity directly, so the private / disclosure rules are explicit here.
    const rows = await sql<{ id: string; type: string; subject: string | null; body: string | null }>`
      SELECT id, type, subject, body FROM core_activity
      WHERE id IN ${list} AND deleted_at IS NULL AND private_to IS NULL
        AND (disclosure IS NULL OR disclosure = 'full')
        AND type IN ${jsonList(ACTIVITY_TYPES)}`.execute(db);
    for (const r of rows.rows) {
      const text = `${r.subject ?? ""}\n${r.body ?? ""}`.trim();
      if (text) out.set(r.id, clip(`${r.type}: ${text}`));
    }
  } else if (object === "task") {
    const rows = await sql<{ id: string; title: string; notes: string | null }>`
      SELECT id, title, notes FROM crm_tasks WHERE id IN ${list}`.execute(db);
    for (const r of rows.rows) out.set(r.id, clip(`Task: ${r.title}\n${r.notes ?? ""}`));
  } else {
    const def = getObject(object);
    const fields = extensionTextFields(object);
    if (!def?.extension || !fields.length) return out;
    const rows = await sql<Record<string, string | null>>`
      SELECT id, ${sql.join(fields.map((f) => sql`${sql.ref(f.column)} AS ${sql.ref(`f_${f.name}`)}`))}
      FROM ${sql.table(def.source)} WHERE id IN ${list}`.execute(db);
    for (const r of rows.rows) {
      const parts = fields
        .map((f, i) => (i === 0 ? (r[`f_${f.name}`] ?? "") : line(f.label, r[`f_${f.name}`])))
        .join("\n");
      const text = clip(`${def.label}: ${parts}`);
      if (text) out.set(String(r.id), text);
    }
  }
  return out;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface EmbeddingDeps {
  db: CrmDb;
  models: ModelRunner;
  vectors: VectorStore;
  clock?: () => Date;
}

export interface DrainResult {
  /** Queue rows taken. */
  taken: number;
  /** Texts sent to the embed role. */
  embedded: number;
  /** Unchanged since the last embedding: nothing sent. */
  unchanged: number;
  /** Vectors deleted (record gone, private, restricted or empty). */
  deleted: number;
  failed: number;
  /** More rows are waiting. */
  more: boolean;
}

/**
 * One round: up to DRAIN_BATCH queued records. Embeds only texts whose hash changed, in batches
 * of EMBED_BATCH; deletes vectors of records with nothing to embed. A failure leaves the rows
 * queued with one more attempt.
 */
export async function drainEmbeddingQueue(deps: EmbeddingDeps): Promise<DrainResult> {
  const { db } = deps;
  const now = (deps.clock?.() ?? new Date()).toISOString();
  const queued = await db.query
    .selectFrom("core_embedding_queue")
    .select(["object_type", "record_id", "queued_at"])
    .where("attempts", "<", MAX_ATTEMPTS)
    .orderBy("attempts")
    .orderBy("queued_at")
    .limit(DRAIN_BATCH + 1)
    .execute();
  const more = queued.length > DRAIN_BATCH;
  const rows = queued.slice(0, DRAIN_BATCH);
  const result: DrainResult = { taken: rows.length, embedded: 0, unchanged: 0, deleted: 0, failed: 0, more };
  if (!rows.length) return result;

  const byObject = new Map<string, string[]>();
  for (const r of rows) byObject.set(r.object_type, [...(byObject.get(r.object_type) ?? []), r.record_id]);
  const texts = new Map<string, string>();
  for (const [object, ids] of byObject) {
    const found = isEmbeddable(object) ? await embeddingTexts(db.query, object, ids) : new Map();
    for (const [id, text] of found) texts.set(`${object}\u0000${id}`, text);
  }
  const existing = await sql<{ object_type: string; record_id: string; text_hash: string; vector_id: string }>`
    SELECT e.object_type, e.record_id, e.text_hash, e.vector_id FROM core_embedding e
    JOIN json_each(${JSON.stringify(rows.map((r) => [r.object_type, r.record_id]))}) j
      ON e.object_type = json_extract(j.value, '$[0]') AND e.record_id = json_extract(j.value, '$[1]')
  `.execute(db.query);
  const state = new Map(existing.rows.map((e) => [`${e.object_type}\u0000${e.record_id}`, e]));

  // The model id is part of the hash: switching the embed role re-embeds everything once.
  const roles = await deps.models.roles?.();
  const model = roles ? `${roles.embed.provider}:${roles.embed.model}` : "embed";
  const toEmbed: { key: string; object: string; id: string; text: string; hash: string; vectorId: string }[] = [];
  const toDelete: { object: string; id: string; vectorId: string }[] = [];
  for (const r of rows) {
    const key = `${r.object_type}\u0000${r.record_id}`;
    const text = texts.get(key);
    const vid = state.get(key)?.vector_id ?? (await vectorId(r.object_type, r.record_id));
    if (!text) {
      toDelete.push({ object: r.object_type, id: r.record_id, vectorId: vid });
      continue;
    }
    const hash = await sha256(`${model}\n${text}`);
    if (state.get(key)?.text_hash === hash) {
      result.unchanged += 1;
      continue;
    }
    toEmbed.push({ key, object: r.object_type, id: r.record_id, text, hash, vectorId: vid });
  }

  const statements: Statement[] = [];
  const dequeue = (list: readonly { object_type: string; record_id: string; queued_at: string }[]) => {
    if (!list.length) return;
    // Only rows not re-queued meanwhile (queued_at unchanged).
    statements.push(
      sql`DELETE FROM core_embedding_queue WHERE (object_type, record_id, queued_at) IN
        (SELECT json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]')
         FROM json_each(${JSON.stringify(list.map((r) => [r.object_type, r.record_id, r.queued_at]))}) j)`.compile(
        db.query,
      ),
    );
  };
  try {
    if (toDelete.length) {
      await deps.vectors.deleteByIds(toDelete.map((d) => d.vectorId));
      result.deleted = toDelete.length;
      statements.push(
        sql`DELETE FROM core_embedding WHERE (object_type, record_id) IN
          (SELECT json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]')
           FROM json_each(${JSON.stringify(toDelete.map((d) => [d.object, d.id]))}) j)`.compile(
          db.query,
        ),
      );
    }
    for (let i = 0; i < toEmbed.length; i += EMBED_BATCH) {
      const batch = toEmbed.slice(i, i + EMBED_BATCH);
      if (!deps.models.embed) throw new Error("The model runner cannot embed");
      const { vectors } = await deps.models.embed(batch.map((b) => b.text));
      await deps.vectors.upsert(
        batch.map((b, j) => ({
          id: b.vectorId,
          values: vectors[j] ?? [],
          metadata: { object: b.object, id: b.id },
        })),
      );
      result.embedded += batch.length;
      statements.push(
        db.query
          .insertInto("core_embedding")
          .values(
            batch.map((b) => ({
              object_type: b.object,
              record_id: b.id,
              vector_id: b.vectorId,
              text_hash: b.hash,
              model,
              embedded_at: now,
            })),
          )
          .onConflict((oc) =>
            oc.columns(["object_type", "record_id"]).doUpdateSet((eb) => ({
              text_hash: eb.ref("excluded.text_hash"),
              vector_id: eb.ref("excluded.vector_id"),
              model: eb.ref("excluded.model"),
              embedded_at: eb.ref("excluded.embedded_at"),
            })),
          ),
      );
    }
    dequeue(rows);
  } catch (error) {
    console.error("embedding drain failed", error);
    result.failed = rows.length - result.embedded - result.deleted - result.unchanged;
    statements.push(
      sql`UPDATE core_embedding_queue SET attempts = attempts + 1 WHERE (object_type, record_id) IN
        (SELECT json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]')
         FROM json_each(${JSON.stringify(rows.map((r) => [r.object_type, r.record_id]))}) j)`.compile(
        db.query,
      ),
    );
  }
  if (statements.length) await db.batch(statements);
  return result;
}

/** Drains until the queue is empty or `maxRounds` is reached (cron catch-up). */
export async function drainAllEmbeddings(
  deps: EmbeddingDeps,
  maxRounds = 20,
): Promise<DrainResult & { rounds: number }> {
  const total = { taken: 0, embedded: 0, unchanged: 0, deleted: 0, failed: 0, more: false, rounds: 0 };
  for (let round = 0; round < maxRounds; round++) {
    const r = await drainEmbeddingQueue(deps);
    total.rounds += 1;
    total.taken += r.taken;
    total.embedded += r.embedded;
    total.unchanged += r.unchanged;
    total.deleted += r.deleted;
    total.failed += r.failed;
    total.more = r.more;
    if (!r.more || r.failed) break;
  }
  return total;
}

/** core_settings key: how far the one-time backfill has got through core_search_docs. */
export const EMBEDDING_BACKFILL_SETTING = "embedding_backfill";
const BACKFILL_PAGE = 500;

/**
 * Queues records that have never been embedded (existing data at upgrade time), one page of
 * core_search_docs per call, by rowid cursor, until it reaches the end. Later changes arrive
 * through the queue, so this is a one-time walk, not a recurring scan.
 */
export async function backfillEmbeddingQueue(
  db: CrmDb,
  now: string,
): Promise<{ queued: number; done: boolean }> {
  const setting = await db.query
    .selectFrom("core_settings")
    .select("value")
    .where("key", "=", EMBEDDING_BACKFILL_SETTING)
    .executeTakeFirst();
  const state = setting ? (JSON.parse(setting.value) as { after: number; done: boolean }) : { after: 0, done: false };
  if (state.done) return { queued: 0, done: true };
  const objects = listObjects()
    .map((o) => o.name)
    .filter(isEmbeddable);
  const docs = await db.query
    .selectFrom("core_search_docs as d")
    .leftJoin("core_embedding as e", (j) =>
      j.onRef("e.object_type", "=", "d.object_type").onRef("e.record_id", "=", "d.record_id"),
    )
    .select(["d.id", "d.object_type", "d.record_id", "e.record_id as embedded"])
    .where("d.id", ">", state.after)
    .orderBy("d.id")
    .limit(BACKFILL_PAGE)
    .execute();
  const refs = docs
    .filter((d) => d.embedded === null && objects.includes(d.object_type))
    .map((d) => ({ object: d.object_type, id: d.record_id }));
  const next = {
    after: docs.at(-1)?.id ?? state.after,
    done: docs.length < BACKFILL_PAGE,
  };
  const value = JSON.stringify(next);
  const statements: Statement[] = [
    db.query
      .insertInto("core_settings")
      .values({ key: EMBEDDING_BACKFILL_SETTING, value, updated_at: now, updated_by: null })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value, updated_at: now })),
  ];
  const enqueue = enqueueEmbeddings(db.query, refs, now);
  if (enqueue) statements.unshift(enqueue);
  await db.batch(statements);
  return { queued: refs.length, done: next.done };
}
