// The duplicate scan (stage 16, ADR 0247). Three jobs share one state row in core_settings
// ('duplicate_scan'), and `duplicate.scan` runs a bounded amount of each per call, so ros-runner's
// minute cron (and "Scan now") can call it until it is done:
//
// 1. Backfill: fills name_key on rows written before migration 0320, by id, without touching
//    updated_at. The scan waits for it.
// 2. Full scan: walks the name-key index once per object, then live phone numbers (people) and
//    websites (organisations), and upserts every pair it finds. Pairs it did not find again are
//    dropped; dismissed and merged pairs are kept. Runs once after the backfill and on demand.
// 3. Incremental scan (nightly, and after an import): only records changed since the cursor
//    (updated_at), each looked up against the name-key index, phone numbers and domains. Reads
//    follow the number of changed records, not the table size.
import type { CoreDatabase } from "@relationship-os/db";
import { type Kysely, type SqlBool, sql } from "kysely";
import { z } from "zod";
import { zonedTime } from "../automations/cron.ts";
import type { HandlerContext } from "../operation.ts";
import { tryNormaliseDomain } from "../operations/organisation.ts";
import { jsonList } from "../records/common.ts";
import { loadGeneralSettings } from "../settings.ts";
import { internalDomains } from "../sync/ingest.ts";
import { organisationNameKey, personNameKey } from "./normalise.ts";
import { type FoundPair, queueDropStalePairs, queueUpsertPairs } from "./pairs.ts";
import {
  type DuplicateObject,
  loadDuplicateSettings,
  loadOrganisationProfiles,
  loadPersonProfiles,
  loadPhoneHolders,
  match,
  type OrganisationProfile,
  type PersonProfile,
  type Profile,
  pairKey,
} from "./rules.ts";

export const DUPLICATE_SCAN_KEY = "duplicate_scan";
const OBJECTS: readonly DuplicateObject[] = ["person", "organisation"];

/** Rows read per chunk. */
const CHUNK = 500;
const CHANGED_CHUNK = 200;
/** Chunks per call: a call stays well inside a Worker's limits; the next call continues. */
const CHUNKS_PER_CALL = 20;
/** People sharing a name key or a number beyond this are compared only in part (a common name). */
export const GROUP_MAX = 50;

const cursorSchema = z.object({ at: z.string(), id: z.string() });
const fullSchema = z.object({
  startedAt: z.string(),
  phase: z.number().int().min(0),
  after: z.string().nullable(),
});
export const scanStateSchema = z.object({
  backfill: z
    .object({
      person: z.string().nullable().default(null),
      organisation: z.string().nullable().default(null),
      done: z.boolean().default(false),
    })
    .default({ person: null, organisation: null, done: false }),
  cursors: z
    .object({
      person: cursorSchema.nullable().default(null),
      organisation: cursorSchema.nullable().default(null),
    })
    .default({ person: null, organisation: null }),
  full: fullSchema.nullable().default(null),
  needsFull: z.boolean().default(true),
  incrementalMore: z.boolean().default(false),
  lastIncrementalAt: z.string().nullable().default(null),
  lastIncrementalDate: z.string().nullable().default(null),
  lastFullAt: z.string().nullable().default(null),
});
export type ScanState = z.infer<typeof scanStateSchema>;

export async function loadScanState(db: Kysely<CoreDatabase>): Promise<ScanState> {
  const row = await db
    .selectFrom("core_settings")
    .select("value")
    .where("key", "=", DUPLICATE_SCAN_KEY)
    .executeTakeFirst();
  try {
    return scanStateSchema.parse(row ? JSON.parse(row.value) : {});
  } catch {
    return scanStateSchema.parse({});
  }
}

/**
 * After an import: asks for an incremental scan on the runner's next tick, which covers the
 * imported records (they are what changed since the cursor). One statement in the import's batch;
 * before the first scan there is no state row and the first full scan covers them anyway.
 */
export function queueScanAfterImport(ctx: ScanContext): void {
  ctx.write(
    ctx.db
      .updateTable("core_settings")
      .set({
        value: sql<string>`json_set(value, '$.incrementalMore', json('true'))`,
        updated_at: ctx.now,
      })
      .where("key", "=", DUPLICATE_SCAN_KEY),
  );
}

function queueSaveState(ctx: ScanContext, state: ScanState): void {
  const value = JSON.stringify(state);
  ctx.write(
    ctx.db
      .insertInto("core_settings")
      .values({ key: DUPLICATE_SCAN_KEY, value, updated_at: ctx.now })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value, updated_at: ctx.now })),
  );
}

export type ScanContext = Pick<HandlerContext, "db" | "write" | "now">;

/** What a scan needs besides the database: internal domains and the phone share limit. */
export interface ScanEnv {
  internal: ReadonlySet<string>;
  phoneShareLimit: number;
}

export async function loadScanEnv(db: Kysely<CoreDatabase>): Promise<ScanEnv> {
  const [internal, settings] = await Promise.all([internalDomains(db), loadDuplicateSettings(db)]);
  return { internal, phoneShareLimit: settings.phoneShareLimit };
}

export function websiteDomain(website: string | null): string | null {
  return website ? tryNormaliseDomain(website) : null;
}

// --- Profiles and pairs ------------------------------------------------------------------------

/** Person profiles with only shareable numbers kept (held by 2..limit live people). */
export async function personProfiles(
  db: Kysely<CoreDatabase>,
  ids: readonly string[],
  env: ScanEnv,
): Promise<Map<string, PersonProfile>> {
  const profiles = await loadPersonProfiles(db, ids, env.internal, () => true);
  const numbers = [...profiles.values()].flatMap((p) => [...p.phones.keys()]);
  const holders = await loadPhoneHolders(db, numbers);
  for (const profile of profiles.values()) {
    for (const number of [...profile.phones.keys()]) {
      const n = holders.get(number)?.size ?? 0;
      if (n < 2 || n > env.phoneShareLimit) profile.phones.delete(number);
    }
  }
  return profiles;
}

export async function profilesFor(
  db: Kysely<CoreDatabase>,
  object: DuplicateObject,
  ids: readonly string[],
  env: ScanEnv,
): Promise<Map<string, Profile>> {
  return object === "person"
    ? personProfiles(db, ids, env)
    : loadOrganisationProfiles(db, ids, websiteDomain);
}

/** Evaluates candidate pairs: the ones matching at least one rule. */
export async function evaluatePairs(
  db: Kysely<CoreDatabase>,
  object: DuplicateObject,
  candidates: Iterable<[string, string]>,
  env: ScanEnv,
): Promise<FoundPair[]> {
  const keyed = new Map<string, [string, string]>();
  for (const [x, y] of candidates) {
    if (x === y) continue;
    const [a, b] = pairKey(x, y);
    keyed.set(`${a}|${b}`, [a, b]);
  }
  if (!keyed.size) return [];
  const ids = [...new Set([...keyed.values()].flat())];
  const profiles = await profilesFor(db, object, ids, env);
  const out: FoundPair[] = [];
  for (const [a, b] of keyed.values()) {
    const pa = profiles.get(a);
    const pb = profiles.get(b);
    if (!pa || !pb) continue;
    const m = match(object, pa, pb);
    if (m.rules.length) out.push({ aId: a, bId: b, rules: m.rules, details: m.details });
  }
  return out;
}

/** Every pair within each group (a group is capped at GROUP_MAX members). */
function pairsWithin(groups: Iterable<string[]>): [string, string][] {
  const out: [string, string][] = [];
  for (const group of groups) {
    const members = [...new Set(group)].slice(0, GROUP_MAX);
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        out.push([members[i] as string, members[j] as string]);
      }
    }
  }
  return out;
}

/**
 * Candidates for `sources` (live profiles): records sharing a name key, a shareable phone
 * number (people) or a domain their website names (organisations). A fixed number of indexed
 * reads, whatever the number of sources.
 */
export async function candidatePairs(
  db: Kysely<CoreDatabase>,
  object: DuplicateObject,
  sources: Profile[],
  env: ScanEnv,
): Promise<[string, string][]> {
  const out: [string, string][] = [];
  const keys = [...new Set(sources.map((s) => s.nameKey).filter((k): k is string => !!k))];
  if (keys.length) {
    const table = object === "person" ? "core_person" : "core_organisation";
    const rows = await db
      .selectFrom(table)
      .select(["id", "name_key"])
      .where("name_key", "in", jsonList(keys))
      .where("deleted_at", "is", null)
      .limit(keys.length * GROUP_MAX)
      .execute();
    const byKey = new Map<string, string[]>();
    for (const r of rows) {
      if (!r.name_key) continue;
      byKey.set(r.name_key, [...(byKey.get(r.name_key) ?? []), r.id]);
    }
    for (const s of sources) {
      for (const id of (s.nameKey && byKey.get(s.nameKey)) || []) out.push([s.id, id]);
    }
  }
  if (object === "person") {
    const people = sources as PersonProfile[];
    const holders = await loadPhoneHolders(
      db,
      people.flatMap((p) => [...p.phones.keys()]),
    );
    for (const p of people) {
      for (const number of p.phones.keys()) {
        const held = holders.get(number);
        if (!held || held.size > env.phoneShareLimit) continue;
        for (const id of held) out.push([p.id, id]);
      }
    }
  } else {
    const orgs = sources as OrganisationProfile[];
    const domains = [...new Set(orgs.map((o) => o.websiteDomain).filter((d): d is string => !!d))];
    if (domains.length) {
      const owners = await db
        .selectFrom("core_organisation_domains")
        .select(["domain", "organisation_id"])
        .where("live", "=", 1)
        .where("domain", "in", jsonList(domains))
        .execute();
      for (const o of orgs) {
        for (const owner of owners) {
          if (owner.domain === o.websiteDomain) out.push([o.id, owner.organisation_id]);
        }
      }
    }
  }
  return out;
}

// --- Backfill ----------------------------------------------------------------------------------

/** Fills name_key for up to CHUNK rows per object after the cursor. Returns whether it is done. */
async function backfillChunk(
  ctx: ScanContext,
  state: ScanState,
  object: DuplicateObject,
): Promise<boolean> {
  const after = state.backfill[object] ?? "";
  const rows =
    object === "person"
      ? (
          await ctx.db
            .selectFrom("core_person")
            .select(["id", "display_name as name"])
            .where("name_key", "is", null)
            .where("id", ">", after)
            .orderBy("id")
            .limit(CHUNK)
            .execute()
        ).map((r) => ({ id: r.id, key: personNameKey(r.name) }))
      : (
          await ctx.db
            .selectFrom("core_organisation")
            .select(["id", "name"])
            .where("name_key", "is", null)
            .where("id", ">", after)
            .orderBy("id")
            .limit(CHUNK)
            .execute()
        ).map((r) => ({ id: r.id, key: organisationNameKey(r.name) }));
  const keyed = rows.filter((r) => r.key !== null);
  if (keyed.length) {
    const table = object === "person" ? "core_person" : "core_organisation";
    ctx.write(
      sql`${sql.raw(`UPDATE ${table} SET name_key = j.k FROM (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.key') AS k FROM json_each(`)}${JSON.stringify(keyed)}${sql.raw(`)) AS j WHERE ${table}.id = j.id`)}`.compile(
        ctx.db,
      ),
    );
  }
  const last = rows.at(-1);
  if (last) state.backfill[object] = last.id;
  return rows.length < CHUNK;
}

// --- Full scan ---------------------------------------------------------------------------------

const FULL_PHASES = [
  { object: "person", walk: "name" },
  { object: "person", walk: "phone" },
  { object: "organisation", walk: "name" },
  { object: "organisation", walk: "website" },
] as const;

/** One chunk of the full scan's current phase. Returns the pairs found and the next cursor. */
async function fullChunk(
  ctx: ScanContext,
  phase: (typeof FULL_PHASES)[number],
  after: string | null,
  env: ScanEnv,
): Promise<{ pairs: FoundPair[]; next: string | null }> {
  const { object, walk } = phase;
  if (walk === "website") {
    const rows = await ctx.db
      .selectFrom("core_organisation")
      .select(["id", "website"])
      .where("deleted_at", "is", null)
      .where("id", ">", after ?? "")
      .orderBy("id")
      .limit(CHUNK)
      .execute();
    const sources = rows
      .filter((r) => r.website)
      .map(
        (r) =>
          ({
            id: r.id,
            title: "",
            nameKey: null,
            createdAt: "",
            domains: new Set<string>(),
            websiteDomain: websiteDomain(r.website),
          }) satisfies OrganisationProfile,
      );
    const candidates = await candidatePairs(ctx.db, object, sources, env);
    const pairs = await evaluatePairs(ctx.db, object, candidates, env);
    return { pairs, next: rows.length < CHUNK ? null : (rows.at(-1)?.id ?? null) };
  }

  // Walk an ordered key (name key, or phone number) and compare records sharing one. The cursor
  // is "=<key>" (resume at that key) or "><key>" (resume after it). The last key of a full chunk
  // may continue in the next one, so it is held back, unless the chunk holds that key alone.
  const inclusive = after === null || after.startsWith("=");
  const cursor = after === null ? "" : after.slice(1);
  const rows: { key: string; id: string }[] =
    walk === "phone"
      ? await ctx.db
          .selectFrom("core_person_phones as ph")
          .innerJoin("core_person as p", "p.id", "ph.person_id")
          .select(["ph.number_normalised as key", "ph.person_id as id"])
          .where("ph.number_normalised", inclusive ? ">=" : ">", cursor)
          .where("p.deleted_at", "is", null)
          .orderBy("ph.number_normalised")
          .limit(CHUNK)
          .execute()
      : (
          await ctx.db
            .selectFrom(object === "person" ? "core_person" : "core_organisation")
            .select(["name_key as key", "id"])
            .where("deleted_at", "is", null)
            .where("name_key", inclusive ? ">=" : ">", cursor)
            .orderBy("name_key")
            .orderBy("id")
            .limit(CHUNK)
            .execute()
        ).filter((r): r is { key: string; id: string } => r.key !== null);
  const groups = new Map<string, string[]>();
  for (const r of rows) groups.set(r.key, [...(groups.get(r.key) ?? []), r.id]);
  let next: string | null = null;
  if (rows.length >= CHUNK) {
    const lastKey = rows.at(-1)?.key as string;
    if (groups.size > 1) {
      groups.delete(lastKey);
      next = `=${lastKey}`;
    } else {
      next = `>${lastKey}`;
    }
  }
  const candidates = pairsWithin(
    [...groups.values()].filter(
      (g) => g.length > 1 && (walk === "name" || g.length <= env.phoneShareLimit),
    ),
  );
  const pairs = await evaluatePairs(ctx.db, object, candidates, env);
  return { pairs, next };
}

// --- Incremental scan --------------------------------------------------------------------------

async function incrementalChunk(
  ctx: ScanContext,
  state: ScanState,
  object: DuplicateObject,
  env: ScanEnv,
): Promise<{ pairs: FoundPair[]; changed: string[]; more: boolean }> {
  const table = object === "person" ? "core_person" : "core_organisation";
  const cursor = state.cursors[object];
  let query = ctx.db
    .selectFrom(table)
    .select(["id", "updated_at", "deleted_at"])
    .orderBy("updated_at")
    .orderBy("id")
    .limit(CHANGED_CHUNK);
  if (cursor) {
    // A row-value comparison, so the (updated_at, id) index serves it as a range.
    query = query.where(sql<SqlBool>`(updated_at, id) > (${cursor.at}, ${cursor.id})`);
  }
  const rows = await query.execute();
  const last = rows.at(-1);
  if (last) state.cursors[object] = { at: last.updated_at, id: last.id };
  const live = rows.filter((r) => r.deleted_at === null).map((r) => r.id);
  const sources = [...(await profilesFor(ctx.db, object, live, env)).values()];
  const candidates = await candidatePairs(ctx.db, object, sources, env);
  const pairs = await evaluatePairs(ctx.db, object, candidates, env);
  return { pairs, changed: rows.map((r) => r.id), more: rows.length === CHANGED_CHUNK };
}

// --- Driver ------------------------------------------------------------------------------------

export type ScanMode = "incremental" | "full" | "continue";

export interface ScanResult {
  /** What this call worked on. */
  ran: ("backfill" | "full" | "incremental")[];
  /** Pairs found (new or still matching) in this call. */
  found: number;
  /** Changed records the incremental scan looked at in this call. */
  changed: number;
  /** False when another call is needed to finish (the backfill, a full scan or a backlog). */
  done: boolean;
  state: ScanState;
}

/** True when the nightly incremental scan is due at `localDate` (the org's date, 02:00 or later). */
export function nightlyDue(state: ScanState, localDate: string, localHour: number): boolean {
  return localHour >= 2 && state.lastIncrementalDate !== localDate;
}

/** True when the cron should call `continue`: backfill, a full scan, or an incremental backlog. */
export function scanPending(state: ScanState): boolean {
  return !state.backfill.done || state.full !== null || state.needsFull || state.incrementalMore;
}

/**
 * Runs a bounded amount of scan work and queues its writes (pairs, name keys, the state).
 */
export async function runScan(ctx: ScanContext, mode: ScanMode): Promise<ScanResult> {
  const state = await loadScanState(ctx.db);
  const result: ScanResult = { ran: [], found: 0, changed: 0, done: true, state };
  let budget = CHUNKS_PER_CALL;

  // 1. The backfill first: its writes commit with this call, so nothing else runs alongside.
  if (!state.backfill.done) {
    result.ran.push("backfill");
    let doneObjects = 0;
    for (const object of OBJECTS) {
      let done = false;
      while (!done && budget > 0) {
        budget -= 1;
        done = await backfillChunk(ctx, state, object);
      }
      if (done) doneObjects += 1;
    }
    state.backfill.done = doneObjects === OBJECTS.length;
    result.done = false;
    queueSaveState(ctx, state);
    return result;
  }

  const env = await loadScanEnv(ctx.db);

  // 2. A full scan: on demand, the first time after the backfill, or one still in progress.
  if (!state.full && (mode === "full" || state.needsFull)) {
    state.full = { startedAt: ctx.now, phase: 0, after: null };
    // Everything changed before the start is covered by this scan.
    const from = { at: ctx.now, id: "" };
    state.cursors = { person: from, organisation: from };
  }
  if (state.full) {
    result.ran.push("full");
    const full = state.full;
    while (budget > 0 && full.phase < FULL_PHASES.length) {
      budget -= 1;
      const phase = FULL_PHASES[full.phase] as (typeof FULL_PHASES)[number];
      const { pairs, next } = await fullChunk(ctx, phase, full.after, env);
      queueUpsertPairs(ctx, phase.object, pairs);
      result.found += pairs.length;
      if (next === null) {
        full.phase += 1;
        full.after = null;
      } else {
        full.after = next;
      }
    }
    if (full.phase >= FULL_PHASES.length) {
      // Open pairs not found again no longer match; pairs of records gone from the database
      // (purged or erased) go whatever their status.
      ctx.write(
        ctx.db
          .deleteFrom("core_duplicate_pair")
          .where("status", "=", "open")
          .where("updated_at", "<", full.startedAt),
        sql`DELETE FROM core_duplicate_pair WHERE
          (object = 'person' AND (NOT EXISTS (SELECT 1 FROM core_person WHERE id = a_id)
                               OR NOT EXISTS (SELECT 1 FROM core_person WHERE id = b_id)))
          OR (object = 'organisation' AND (NOT EXISTS (SELECT 1 FROM core_organisation WHERE id = a_id)
                               OR NOT EXISTS (SELECT 1 FROM core_organisation WHERE id = b_id)))`.compile(
          ctx.db,
        ),
      );
      state.full = null;
      state.needsFull = false;
      state.lastFullAt = ctx.now;
    } else {
      result.done = false;
    }
    queueSaveState(ctx, state);
    return result;
  }

  // 3. The incremental scan.
  if (mode === "incremental" || state.incrementalMore) {
    result.ran.push("incremental");
    let more = false;
    for (const object of OBJECTS) {
      let objectMore = true;
      while (objectMore && budget > 0) {
        budget -= 1;
        const chunk = await incrementalChunk(ctx, state, object, env);
        queueUpsertPairs(ctx, object, chunk.pairs);
        queueDropStalePairs(ctx, object, chunk.changed);
        result.found += chunk.pairs.length;
        result.changed += chunk.changed.length;
        objectMore = chunk.more;
      }
      if (objectMore) more = true;
    }
    state.incrementalMore = more;
    state.lastIncrementalAt = ctx.now;
    // Only a nightly (or requested) run counts: a scan after an import leaves tonight's in place.
    if (mode === "incremental") {
      const { timezone } = await loadGeneralSettings(ctx.db);
      state.lastIncrementalDate = zonedTime(new Date(ctx.now), timezone).date;
    }
    result.done = !more;
    queueSaveState(ctx, state);
  }
  return result;
}
