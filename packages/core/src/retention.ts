// Storage retention (ADR 0090, docs/research/cloudflare-cost-audit.md decision D3): the audit
// retention setting, and the daily cron's housekeeping that keeps D1 under its 10 GB cap:
//
// - runAuditPurge: deletes write audits older than the retention setting through the sanctioned
//   purge path (migration 0061), by calling `audit.purge` as an automation, so each round is
//   gated and leaves one summary audit row;
// - purgeRunHistory: extension and automation runs after 30 days, failed ones after 90;
// - compactPendingActions: decided or expired pending actions (and their extension proposals)
//   after 30 days keep a summary;
// - measureStorage: the storage gauge's cached size and row counts.
//
// Every delete and update here works in index-ordered chunks (EXPLAIN QUERY PLAN and rows-read
// budgets in test/retention.test.ts), so no step scans a whole table or nears D1's limits.
import type { CoreDatabase, CrmDb } from "@relationship-os/db";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import type { GateFloor } from "./gate.ts";
import { jsonList } from "./records/common.ts";
import { SYSTEM_USER } from "./users.ts";

export const AUDIT_RETENTION_SETTING = "audit_retention";
/** Retention choices besides "forever" (null), in years. */
export const AUDIT_RETENTION_YEARS = [1, 2, 7] as const;
export type AuditRetentionYears = (typeof AUDIT_RETENTION_YEARS)[number];

export const auditRetentionSchema = z.object({
  years: z
    .union([z.literal(1), z.literal(2), z.literal(7)])
    .nullable()
    .describe("Years to keep write audits; null keeps them forever"),
});

/** Successful runs are kept this long, failed (error, timeout) runs longer. */
export const RUN_RETENTION_DAYS = { ok: 30, failed: 90 } as const;
/** Decided or expired pending actions keep full detail this long, then only a summary. */
export const PENDING_COMPACT_DAYS = 30;

const DAY_MS = 86_400_000;

export function daysBefore(now: string, days: number): string {
  return new Date(Date.parse(now) - days * DAY_MS).toISOString();
}

export function yearsBefore(now: string, years: number): string {
  const d = new Date(now);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString();
}

/**
 * The audit retention in years, or null for forever. A missing or unreadable setting means
 * forever: a broken setting must never delete audit history.
 */
export async function loadAuditRetention(
  db: Kysely<CoreDatabase>,
): Promise<AuditRetentionYears | null> {
  const row = await db
    .selectFrom("core_settings")
    .select("value")
    .where("key", "=", AUDIT_RETENTION_SETTING)
    .executeTakeFirst();
  if (!row) return null;
  try {
    const parsed = auditRetentionSchema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data.years : null;
  } catch {
    return null;
  }
}

/** True when audit rows or read counts are older than the retention cutoff. Index-only. */
export async function auditPurgeDue(db: Kysely<CoreDatabase>, now: string): Promise<boolean> {
  const years = await loadAuditRetention(db);
  if (years === null) return false;
  const cutoff = yearsBefore(now, years);
  const row = await db
    .selectNoFrom((eb) => [
      eb.exists(eb.selectFrom("core_audit").select("id").where("at", "<", cutoff)).as("audit"),
      eb
        .exists(eb.selectFrom("core_audit_read_counts").select("hour").where("hour", "<", cutoff))
        .as("reads"),
    ])
    .executeTakeFirst();
  return Boolean(row?.audit || row?.reads);
}

export interface AuditPurgeOptions {
  floor?: GateFloor;
  clock?: () => Date;
  /** Upper bound on rounds per run; the next run picks up anything left. Default 10. */
  maxRounds?: number;
}

/**
 * Runs `audit.purge` until nothing more is due (or maxRounds). Does nothing, and writes no audit
 * row, while retention is "forever" or nothing is old enough.
 */
export async function runAuditPurge(
  db: CrmDb,
  { floor, clock, maxRounds = 10 }: AuditPurgeOptions = {},
): Promise<{
  auditRows: number;
  changeRows: number;
  readCountRows: number;
  rounds: number;
  more: boolean;
}> {
  const totals = { auditRows: 0, changeRows: 0, readCountRows: 0, rounds: 0, more: false };
  const now = (clock?.() ?? new Date()).toISOString();
  if (!(await auditPurgeDue(db.query, now))) return totals;
  // Loaded lazily: invoke.ts imports every operation, and operations/retention.ts imports this
  // module, so a static import is a cycle that breaks module evaluation order in dev (vite SSR).
  const { invoke } = await import("./invoke.ts");
  let more = true;
  while (more && totals.rounds < maxRounds) {
    totals.rounds += 1;
    const result = await invoke(
      "audit.purge",
      {},
      {
        actor: "automation",
        user: SYSTEM_USER,
        origin: { surface: "system", automationId: "audit.purge" },
        db,
        ...(floor ? { floor } : {}),
        ...(clock ? { clock } : {}),
      },
    );
    totals.auditRows += result.auditRows;
    totals.changeRows += result.changeRows;
    totals.readCountRows += result.readCountRows;
    more = result.more;
  }
  totals.more = more;
  return totals;
}

/** Deletes `limit` rows at a time; returns how many went. */
async function deleteInChunks(
  run: () => Promise<number>,
  limit: number,
  maxChunks: number,
): Promise<{ deleted: number; more: boolean }> {
  let deleted = 0;
  for (let i = 0; i < maxChunks; i++) {
    const n = await run();
    deleted += n;
    if (n < limit) return { deleted, more: false };
  }
  return { deleted, more: true };
}

export interface ChunkOptions {
  /** Rows per statement. */
  chunk?: number;
  /** Statements per kind per run; the next run picks up anything left. */
  maxChunks?: number;
}

/**
 * Deletes extension and automation run history: successful runs older than 30 days, failed
 * (error or timeout) runs older than 90. Each statement takes the oldest `chunk` rows of one
 * outcome through core_extension_runs_outcome_idx.
 */
export async function purgeRunHistory(
  db: Kysely<CoreDatabase>,
  now: string,
  { chunk = 500, maxChunks = 20 }: ChunkOptions = {},
): Promise<{ deleted: number; more: boolean }> {
  let deleted = 0;
  let more = false;
  const plans = [
    { outcome: "ok", days: RUN_RETENTION_DAYS.ok },
    { outcome: "error", days: RUN_RETENTION_DAYS.failed },
    { outcome: "timeout", days: RUN_RETENTION_DAYS.failed },
  ] as const;
  for (const { outcome, days } of plans) {
    const cutoff = daysBefore(now, days);
    const result = await deleteInChunks(
      async () => {
        const r = await db
          .deleteFrom("core_extension_runs")
          .where("id", "in", (eb) =>
            eb
              .selectFrom("core_extension_runs")
              .select("id")
              .where("outcome", "=", outcome)
              .where("started_at", "<", cutoff)
              .orderBy("started_at")
              .limit(chunk),
          )
          .executeTakeFirst();
        return Number(r.numDeletedRows ?? 0);
      },
      chunk,
      maxChunks,
    );
    deleted += result.deleted;
    more ||= result.more;
  }
  const automation = await purgeAutomationRuns(db, now, { chunk, maxChunks });
  return { deleted: deleted + automation.deleted, more: more || automation.more };
}

/** Automation run counters (rails) are kept this long. */
export const COUNTER_RETENTION_DAYS = 2;

/**
 * Automation run history (ADR 0130): finished runs older than 30 days (failed ones 90) with their
 * run records, and rate-limit counters older than two days. Each chunk takes the oldest runs of
 * one status through core_automation_runs_status_idx; running and waiting runs are never touched.
 */
export async function purgeAutomationRuns(
  db: Kysely<CoreDatabase>,
  now: string,
  { chunk = 500, maxChunks = 20 }: ChunkOptions = {},
): Promise<{ deleted: number; more: boolean }> {
  let deleted = 0;
  let more = false;
  const plans = [
    { status: "completed", days: RUN_RETENTION_DAYS.ok },
    { status: "cancelled", days: RUN_RETENTION_DAYS.ok },
    { status: "expired", days: RUN_RETENTION_DAYS.ok },
    { status: "skipped", days: RUN_RETENTION_DAYS.ok },
    { status: "failed", days: RUN_RETENTION_DAYS.failed },
  ] as const;
  for (const { status, days } of plans) {
    const cutoff = daysBefore(now, days);
    const result = await deleteInChunks(
      async () => {
        const due = await db
          .selectFrom("core_automation_runs")
          .select("id")
          .where("status", "=", status)
          .where("started_at", "<", cutoff)
          .orderBy("started_at")
          .limit(chunk)
          .execute();
        if (!due.length) return 0;
        const ids = jsonList(due.map((r) => r.id));
        await db.deleteFrom("core_automation_run_records").where("run_id", "in", ids).execute();
        const r = await db
          .deleteFrom("core_automation_runs")
          .where("id", "in", ids)
          .executeTakeFirst();
        return Number(r.numDeletedRows ?? 0);
      },
      chunk,
      maxChunks,
    );
    deleted += result.deleted;
    more ||= result.more;
  }
  const hour = daysBefore(now, COUNTER_RETENTION_DAYS).slice(0, 13);
  await db.deleteFrom("core_automation_counters").where("hour", "<", hour).execute();
  return { deleted, more };
}

/** The key compaction orders and filters by (matches core_pending_action_compact_idx). */
const decidedKey = sql<string>`coalesce(decided_at, expires_at)`;

/**
 * Compacts pending actions decided (or expired) more than 30 days ago: input, preview and
 * simulated records are replaced by empty values and `summary` keeps what they held (records
 * touched, by action, and sizes). Operation, actor, user, status, decider, decision time, result
 * and error stay. Rows already compacted, and those still pending, are never touched.
 */
export async function compactPendingActions(
  db: Kysely<CoreDatabase>,
  now: string,
  { chunk = 200, maxChunks = 10 }: ChunkOptions = {},
): Promise<{ compacted: number; more: boolean }> {
  const cutoff = daysBefore(now, PENDING_COMPACT_DAYS);
  const { deleted, more } = await deleteInChunks(
    async () => {
      const due = await db
        .selectFrom("core_pending_action")
        .select("id")
        // Literal, not bound, so the planner can match the partial index's WHERE.
        .where(sql<boolean>`compacted_at IS NULL AND status <> 'pending'`)
        .where(decidedKey, "<", cutoff)
        .orderBy(decidedKey)
        .limit(chunk)
        .execute();
      const ids = due.map((r) => r.id);
      if (!ids.length) return 0;
      // An extension proposal (stage 3b) keeps its files' paths, statuses and line counts, its
      // impact and whether its check passed; hunks and check details go.
      await db
        .updateTable("core_extension_proposals")
        .set({
          diff: sql<string>`(SELECT coalesce(json_group_array(json_object(
              'path', json_extract(f.value, '$.path'),
              'status', json_extract(f.value, '$.status'),
              'additions', json_extract(f.value, '$.additions'),
              'deletions', json_extract(f.value, '$.deletions'),
              'hunks', json('[]'),
              'truncated', json('true'))), json('[]'))
            FROM json_each(core_extension_proposals.diff) f)`,
          check_result: sql<string>`json_object(
            'ok', json(coalesce(check_result -> '$.ok', 'null')), 'compacted', json('true'))`,
        })
        .where("action_id", "in", jsonList(ids))
        .execute();
      const r = await db
        .updateTable("core_pending_action")
        .set({
          summary: sql<string>`json_object(
            'records', json_array_length(preview)
              + coalesce(json_extract(simulated, '$.truncated.previewOmitted'), 0),
            'actions', (SELECT coalesce(json_group_object(a, n), json('{}')) FROM (
              SELECT json_extract(p.value, '$.action') AS a, count(*) AS n
              FROM json_each(preview) p GROUP BY a)),
            'inputBytes', length(input),
            'previewBytes', length(preview),
            'simulatedBytes', length(simulated))`,
          input: "null",
          preview: "[]",
          simulated: JSON.stringify({ output: null, records: [] }),
          compacted_at: now,
        })
        .where("id", "in", jsonList(ids))
        .where("compacted_at", "is", null)
        .executeTakeFirst();
      return Number(r.numUpdatedRows ?? 0);
    },
    chunk,
    maxChunks,
  );
  return { compacted: deleted, more };
}

/** D1's hard cap on one database (developers.cloudflare.com/d1/platform/limits/). */
export const D1_MAX_BYTES = 10_000_000_000;
/** The gauge warns from here (cost audit D3). */
export const STORAGE_WARN_BYTES = 6_000_000_000;
export const STORAGE_CRITICAL_BYTES = 8_000_000_000;

/** The tables the gauge counts: the ones that grow with use. */
export const STORAGE_TABLES = [
  "core_person",
  "core_organisation",
  "core_activity",
  "core_task",
  "core_search_docs",
  "core_audit",
  "core_audit_changes",
  "core_audit_read_counts",
  "core_pending_action",
  "core_extension_runs",
  "core_extension_proposals",
] as const;

export interface StorageStats {
  sizeBytes: number | null;
  tables: Record<string, number>;
  measuredAt: string;
}

/**
 * Measures the database (size and row counts) and caches it in core_storage_stats. Counting
 * reads every row of the counted tables, so it runs once a day in the cron and on an admin's
 * explicit refresh, never on a page view.
 */
export async function measureStorage(crm: CrmDb, now: string): Promise<StorageStats> {
  const row = await crm.query
    .selectNoFrom(
      STORAGE_TABLES.map((table) =>
        sql<number>`(SELECT count(*) FROM ${sql.table(table)})`.as(table),
      ),
    )
    .executeTakeFirstOrThrow();
  const tables = Object.fromEntries(
    STORAGE_TABLES.map((t) => [t, Number((row as Record<string, unknown>)[t] ?? 0)]),
  );
  const sizeBytes = crm.size ? await crm.size() : null;
  await crm.batch([
    crm.query
      .insertInto("core_storage_stats")
      .values({ id: 1, size_bytes: sizeBytes, tables: JSON.stringify(tables), measured_at: now })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({
          size_bytes: sizeBytes,
          tables: JSON.stringify(tables),
          measured_at: now,
        }),
      ),
  ]);
  return { sizeBytes, tables, measuredAt: now };
}

export async function loadStorageStats(db: Kysely<CoreDatabase>): Promise<StorageStats | null> {
  const row = await db
    .selectFrom("core_storage_stats")
    .selectAll()
    .where("id", "=", 1)
    .executeTakeFirst();
  if (!row) return null;
  let tables: Record<string, number> = {};
  try {
    tables = JSON.parse(row.tables) as Record<string, number>;
  } catch {}
  return { sizeBytes: row.size_bytes, tables, measuredAt: row.measured_at };
}
