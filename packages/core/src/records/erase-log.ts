// What survives outside the live database after an erase (ADR 0320):
//
// - The erase log: one R2 object per erase (`erase-log/<at>-<uuid>.json`), holding only SHA-256
//   hashes of the erased record ids and addresses and the time. R2 is not part of D1's Time
//   Travel, so after a restore `erasure.reapply` reads the log, finds live records whose id hashes
//   match and erases them again, and puts the addresses back on the erased-address list.
//   `erasure.allowAddress` appends an `allow` entry, so a re-apply keeps that decision.
// - The blob deletion queue (core_blob_deletion): R2 objects (synced email bodies) whose activity
//   was deleted or lost its body. Filled by trigger in the deleting batch, drained right after the
//   commit and by the 10-minute cron, with retries, like the embedding queue.
import type { CoreDatabase } from "@relationship-os/db";
import { type Kysely, sql } from "kysely";
import type { BlobStore } from "../integrations/runtime.ts";
import type { HandlerContext } from "../operation.ts";
import { jsonList } from "./common.ts";

export const ERASE_LOG_PREFIX = "erase-log/";

/** One erase-log object. Hashes only: `sha256:<hex>` of the id or the lower-cased address. */
export interface EraseLogEntry {
  v: 1;
  kind: "erase" | "allow";
  at: string;
  object?: "person" | "organisation";
  /** Hashes of the erased record ids (the record and anything merged into it). */
  records?: string[];
  /** Hashes of addresses added to (erase) or removed from (allow) the erased-address list. */
  addresses: string[];
}

/** `sha256:` and the hex digest of `value` (an id as is; an address lower-cased and trimmed). */
export async function sha256Ref(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Stores one entry. Keys sort by time, so a listing replays them in order. */
export async function putEraseLog(blobs: BlobStore, entry: EraseLogEntry): Promise<void> {
  await blobs.put(
    `${ERASE_LOG_PREFIX}${entry.at}-${crypto.randomUUID()}.json`,
    JSON.stringify(entry),
  );
}

/**
 * The erase's log entry, written before the commit (a failure fails the erase, which can be
 * retried; an entry for an erase whose commit then failed only erases that record again on a
 * re-apply, which is what was asked for). Without blob storage (tests, scripts) there is nothing
 * outside the database to write to, and it is skipped: ros-app always binds BLOBS.
 */
export async function writeEraseLog(
  ctx: HandlerContext,
  subject: {
    object: "person" | "organisation";
    recordIds: readonly string[];
    addresses: readonly string[];
  },
): Promise<void> {
  if (!ctx.blobs) return;
  const [records, addresses] = await Promise.all([
    Promise.all(subject.recordIds.map(sha256Ref)),
    Promise.all(subject.addresses.map((a) => sha256Ref(a.trim().toLowerCase()))),
  ]);
  await putEraseLog(ctx.blobs, {
    v: 1,
    kind: "erase",
    at: ctx.now,
    object: subject.object,
    records,
    addresses,
  });
}

/** Every erase-log entry, oldest first. */
export async function readEraseLog(blobs: BlobStore): Promise<EraseLogEntry[]> {
  if (!blobs.list) throw new Error("This blob store cannot list the erase log");
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await blobs.list(ERASE_LOG_PREFIX, cursor);
    keys.push(...page.keys);
    cursor = page.cursor;
  } while (cursor);
  keys.sort();
  const entries: EraseLogEntry[] = [];
  for (const key of keys) {
    const text = await blobs.get(key);
    if (!text) continue;
    try {
      const entry = JSON.parse(text) as EraseLogEntry;
      if (entry.v === 1) entries.push(entry);
    } catch {
      // A damaged entry is skipped, not fatal: the rest still apply.
    }
  }
  return entries;
}

/** What a re-apply must do: records to erase again and the addresses the list should hold. */
export async function planReapply(
  db: Kysely<CoreDatabase>,
  entries: readonly EraseLogEntry[],
): Promise<{
  people: string[];
  organisations: string[];
  addresses: string[];
}> {
  const records = { person: new Set<string>(), organisation: new Set<string>() };
  const addresses = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "erase") {
      for (const r of entry.records ?? []) records[entry.object ?? "person"].add(r);
      for (const a of entry.addresses) addresses.add(a);
    } else {
      for (const a of entry.addresses) addresses.delete(a);
    }
  }
  // Ids are stored hashed, so live records are hashed to compare: a scan, run only after a
  // restore.
  const match = async (table: "core_person" | "core_organisation", wanted: Set<string>) => {
    if (!wanted.size) return [];
    const found: string[] = [];
    let after = "";
    for (;;) {
      const rows = await db
        .selectFrom(table)
        .select("id")
        .where("id", ">", after)
        .orderBy("id")
        .limit(1000)
        .execute();
      for (const row of rows) if (wanted.has(await sha256Ref(row.id))) found.push(row.id);
      if (rows.length < 1000) break;
      after = rows[rows.length - 1]?.id ?? after;
    }
    return found;
  };
  return {
    // Merged-away records are erased with their survivor; listing them too is harmless.
    people: await match("core_person", records.person),
    organisations: await match("core_organisation", records.organisation),
    addresses: [...addresses],
  };
}

// --- Blob deletion queue ------------------------------------------------------------------------

/** Keys taken per drain round. */
export const BLOB_DRAIN_BATCH = 100;
/** A key that failed this often is left for an admin (it stays visible in the table). */
export const BLOB_MAX_ATTEMPTS = 10;

const BODY_PREFIX = "email-bodies/";

/**
 * Deletes queued R2 objects. A key an activity references again (the same message synced anew
 * after the delete was queued) is dequeued without deleting. Never throws: failures are counted
 * and retried by the next drain.
 */
export async function drainBlobDeletions(
  db: Kysely<CoreDatabase>,
  blobs: BlobStore,
  limit = BLOB_DRAIN_BATCH,
): Promise<{ deleted: number; kept: number; failed: number }> {
  const rows = await db
    .selectFrom("core_blob_deletion")
    .select("key")
    .where("attempts", "<", BLOB_MAX_ATTEMPTS)
    .orderBy("attempts")
    .orderBy("queued_at")
    .limit(limit)
    .execute();
  if (!rows.length) return { deleted: 0, kept: 0, failed: 0 };
  const keys = rows.map((r) => r.key);
  // Email bodies are keyed by their activity's external key: look references up by its index.
  const externals = keys
    .filter((k) => k.startsWith(BODY_PREFIX))
    .map((k) => {
      try {
        return decodeURIComponent(k.slice(BODY_PREFIX.length));
      } catch {
        return null;
      }
    })
    .filter((k): k is string => k !== null);
  const referenced = new Set(
    externals.length
      ? (
          await db
            .selectFrom("core_activity")
            .select("body_ref")
            .where("external_key", "in", jsonList(externals))
            .where("body_ref", "is not", null)
            .execute()
        ).map((r) => r.body_ref as string)
      : [],
  );
  const doomed = keys.filter((k) => !referenced.has(k));
  try {
    if (doomed.length) await blobs.delete(doomed);
  } catch (error) {
    const message = error instanceof Error ? error.name : "error";
    await db
      .updateTable("core_blob_deletion")
      .set({ attempts: sql`attempts + 1`, last_error: message })
      .where("key", "in", jsonList(doomed))
      .execute();
    return { deleted: 0, kept: keys.length - doomed.length, failed: doomed.length };
  }
  await db.deleteFrom("core_blob_deletion").where("key", "in", jsonList(keys)).execute();
  return { deleted: doomed.length, kept: keys.length - doomed.length, failed: 0 };
}

/** Drains until empty (or `rounds`). For the post-commit hook and the cron. */
export async function drainAllBlobDeletions(
  db: Kysely<CoreDatabase>,
  blobs: BlobStore,
  rounds = 5,
): Promise<{ deleted: number; failed: number }> {
  let deleted = 0;
  let failed = 0;
  for (let i = 0; i < rounds; i++) {
    const r = await drainBlobDeletions(db, blobs);
    deleted += r.deleted;
    failed += r.failed;
    if (r.deleted + r.kept + r.failed < BLOB_DRAIN_BATCH || r.failed) break;
  }
  return { deleted, failed };
}
