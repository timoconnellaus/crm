// Audit retention, read counts and the storage gauge (ADR 0090):
// - audit.retention / audit.setRetention: how long write audits are kept (human admins only);
// - audit.purge: one round of the retention purge, run by the daily cron as an automation;
// - audit.readCounts: hourly counts of non-human reads, which replaced one audit row per read;
// - storage.status / storage.refresh: the D1 size against its 10 GB cap and the big tables.
import { sql } from "kysely";
import { z } from "zod";
import { ValidationError } from "../errors.ts";
import { decodeCursor, encodeCursor, pageSchema } from "../list.ts";
import { defineOperation } from "../operation.ts";
import { ACTORS } from "../principals.ts";
import { jsonList } from "../records/common.ts";
import {
  AUDIT_RETENTION_SETTING,
  auditRetentionSchema,
  D1_MAX_BYTES,
  loadAuditRetention,
  loadStorageStats,
  measureStorage,
  STORAGE_CRITICAL_BYTES,
  STORAGE_WARN_BYTES,
  yearsBefore,
} from "../retention.ts";

const retentionOutput = z.object({
  years: auditRetentionSchema.shape.years,
  cutoff: z
    .string()
    .nullable()
    .describe("Write audits from before this are purged by the daily cron; null: kept forever"),
});

export const auditRetention = defineOperation({
  name: "audit.retention",
  description:
    "How long the audit log keeps write audits: forever (years null, the default) or 1, 2 or 7 " +
    "years, and the cutoff that implies today. Only a human admin can change it. Read-only.",
  input: z.object({}),
  output: retentionOutput,
  permission: "audit:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(_input, ctx) {
    const years = await loadAuditRetention(ctx.db);
    return { years, cutoff: years === null ? null : yearsBefore(ctx.now, years) };
  },
});

export const auditSetRetention = defineOperation({
  name: "audit.setRetention",
  description:
    "Set how long write audits are kept: null keeps them forever; 1, 2 or 7 years lets the " +
    "daily cron delete older audit rows, their field diffs and read counts for good. Admins " +
    "only, and only a person in the app: AI assistants, MCP clients and automations are " +
    "refused. The change and every purge are themselves audited.",
  input: auditRetentionSchema,
  output: retentionOutput.extend({ previousYears: auditRetentionSchema.shape.years }),
  permission: "policy:manage",
  risk: "destructive",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const before = await loadAuditRetention(ctx.db);
    const value = JSON.stringify({ years: input.years });
    ctx.write(
      ctx.db
        .insertInto("core_settings")
        .values({
          key: AUDIT_RETENTION_SETTING,
          value,
          updated_at: ctx.now,
          updated_by: ctx.user.id,
        })
        .onConflict((oc) =>
          oc.column("key").doUpdateSet({ value, updated_at: ctx.now, updated_by: ctx.user.id }),
        ),
    );
    ctx.recordChange({
      object: "settings",
      id: AUDIT_RETENTION_SETTING,
      action: "update",
      before: { years: before },
      after: { years: input.years },
    });
    return {
      years: input.years,
      cutoff: input.years === null ? null : yearsBefore(ctx.now, input.years),
      previousYears: before,
    };
  },
});

/** Audit rows per purge round, and the field-change rows a round may delete with them. */
export const AUDIT_PURGE_MAX = 2_000;
export const AUDIT_PURGE_CHANGES_MAX = 20_000;
const READ_COUNTS_PURGE_MAX = 5_000;

export const auditPurge = defineOperation({
  name: "audit.purge",
  description:
    "One round of the audit retention purge: deletes the oldest audit rows from before the " +
    "retention cutoff (with their field diffs and redaction markers), and read counts from " +
    "before it, through the sanctioned purge path. Does nothing while retention is forever. " +
    "Run by the daily cron as an automation. Returns what was deleted and whether more is due.",
  input: z.object({
    limit: z.number().int().min(1).max(AUDIT_PURGE_MAX).default(AUDIT_PURGE_MAX),
  }),
  output: z.object({
    years: auditRetentionSchema.shape.years,
    cutoff: z.string().nullable(),
    auditRows: z.number(),
    changeRows: z.number(),
    redactions: z.number(),
    readCountRows: z.number(),
    more: z.boolean().describe("True when more is due; call again"),
  }),
  permission: "policy:manage",
  // The destructive decision was the admin's retention setting (audit.setRetention, risk
  // destructive). Carrying it out is a system write, like the Trash purge (ADR 0018 amendment).
  risk: "write",
  actors: ["automation"],
  mcp: { expose: false },
  auditSummary: (output) => output,
  async handler(input, ctx) {
    const years = await loadAuditRetention(ctx.db);
    const none = { auditRows: 0, changeRows: 0, redactions: 0, readCountRows: 0, more: false };
    if (years === null) return { years, cutoff: null, ...none };
    const cutoff = yearsBefore(ctx.now, years);
    if (!(cutoff < ctx.now)) throw new ValidationError("Invalid clock");

    // Oldest first through core_audit_at_idx; one more than the limit says whether more is due.
    const due = await ctx.db
      .selectFrom("core_audit")
      .select("id")
      .where("at", "<", cutoff)
      .orderBy("at")
      .orderBy("id")
      .limit(input.limit + 1)
      .execute();
    let ids = due.slice(0, input.limit).map((r) => r.id);
    let more = due.length > input.limit;

    // Bound the change rows too: a bulk import's one audit row can own 20k of them.
    let changeRows = 0;
    if (ids.length) {
      const counts = await ctx.db
        .selectFrom("core_audit_changes")
        .select(["audit_id", sql<number>`count(*)`.as("n")])
        .where("audit_id", "in", jsonList(ids))
        .groupBy("audit_id")
        .execute();
      const perAudit = new Map(counts.map((c) => [c.audit_id, Number(c.n)]));
      const kept: string[] = [];
      for (const id of ids) {
        const n = perAudit.get(id) ?? 0;
        if (kept.length && changeRows + n > AUDIT_PURGE_CHANGES_MAX) {
          more = true;
          break;
        }
        kept.push(id);
        changeRows += n;
      }
      ids = kept;
    }

    let redactions = 0;
    if (ids.length) {
      const changesOf = ctx.db
        .selectFrom("core_audit_changes")
        .select("id")
        .where("audit_id", "in", jsonList(ids));
      const row = await ctx.db
        .selectFrom("core_audit_redactions")
        .select(sql<number>`count(*)`.as("n"))
        .where((eb) =>
          eb.or([eb("audit_id", "in", jsonList(ids)), eb("change_id", "in", changesOf)]),
        )
        .executeTakeFirst();
      redactions = Number(row?.n ?? 0);

      // The marker first: the delete guards (migration 0061) allow only rows older than it.
      ctx.write(
        ctx.db.insertInto("core_audit_purges").values({
          cutoff,
          retention_years: years,
          audit_id: ctx.auditId ?? null,
          user_id: ctx.user.id,
          at: ctx.now,
        }),
        ctx.db
          .deleteFrom("core_audit_redactions")
          .where((eb) =>
            eb.or([eb("audit_id", "in", jsonList(ids)), eb("change_id", "in", changesOf)]),
          ),
        ctx.db.deleteFrom("core_audit_changes").where("audit_id", "in", jsonList(ids)),
        ctx.db.deleteFrom("core_audit").where("id", "in", jsonList(ids)),
      );
    }

    // Read counts are not append-only (they are upserted); they follow the same retention.
    const oldCounts = await ctx.db
      .selectFrom("core_audit_read_counts")
      .select(["hour", "actor", "user_id", "caller", "operation"])
      .where("hour", "<", cutoff)
      .orderBy("hour")
      .limit(READ_COUNTS_PURGE_MAX + 1)
      .execute();
    const readCountRows = Math.min(oldCounts.length, READ_COUNTS_PURGE_MAX);
    if (oldCounts.length > READ_COUNTS_PURGE_MAX) more = true;
    if (readCountRows) {
      const last = oldCounts[readCountRows - 1];
      ctx.write(
        ctx.db
          .deleteFrom("core_audit_read_counts")
          .where(
            sql<boolean>`hour < ${cutoff} AND (hour, actor, user_id, caller, operation) <= (${last?.hour}, ${last?.actor}, ${last?.user_id}, ${last?.caller}, ${last?.operation})`,
          ),
      );
    }

    return { years, cutoff, auditRows: ids.length, changeRows, redactions, readCountRows, more };
  },
});

const readCountSchema = z.object({
  hour: z.string(),
  actor: z.string(),
  userId: z.string(),
  userName: z.string().nullable(),
  caller: z.string().describe("Connected app (cap_…), extension or automation id, or ''"),
  operation: z.string(),
  count: z.number(),
  simulated: z.number().describe("How many saw the session's pending changes simulated"),
  firstAt: z.string(),
  lastAt: z.string(),
});

const READ_COUNTS_SORT = { field: "hour", direction: "desc" } as const;

export const auditReadCounts = defineOperation({
  name: "audit.readCounts",
  description:
    "Reads by AI assistants, MCP clients, extensions and automations, counted per hour, actor, " +
    "user, caller (connected app, extension or automation) and operation, newest hour first. " +
    "Successful non-human reads are counted here instead of getting an audit.list entry each; " +
    "failed or refused reads are still in audit.list. Filter by actor, userId, operation and " +
    "an hour range (from inclusive, to exclusive). Admins only. Read-only.",
  input: z.object({
    actor: z.enum(ACTORS).optional(),
    userId: z.string().max(64).optional(),
    operation: z.string().max(100).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    cursor: z.string().max(1000).optional(),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  output: pageSchema(readCountSchema),
  permission: "audit:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    let query = ctx.db
      .selectFrom("core_audit_read_counts as r")
      .leftJoin("core_user as u", "u.id", "r.user_id")
      .selectAll("r")
      .select("u.name as user_name");
    if (input.actor) query = query.where("r.actor", "=", input.actor);
    if (input.userId) query = query.where("r.user_id", "=", input.userId);
    if (input.operation) query = query.where("r.operation", "=", input.operation);
    if (input.from) query = query.where("r.hour", ">=", new Date(input.from).toISOString());
    if (input.to) query = query.where("r.hour", "<", new Date(input.to).toISOString());
    if (input.cursor) {
      const c = decodeCursor(input.cursor, READ_COUNTS_SORT);
      const [actor, userId, caller, operation] = JSON.parse(c.id) as string[];
      query = query.where(
        sql<boolean>`(r.hour, r.actor, r.user_id, r.caller, r.operation) < (${c.v}, ${actor}, ${userId}, ${caller}, ${operation})`,
      );
    }
    const rows = await query
      .orderBy("r.hour", "desc")
      .orderBy("r.actor", "desc")
      .orderBy("r.user_id", "desc")
      .orderBy("r.caller", "desc")
      .orderBy("r.operation", "desc")
      .limit(input.limit + 1)
      .execute();
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      items: page.map((r) => ({
        hour: r.hour,
        actor: r.actor,
        userId: r.user_id,
        userName: r.user_name,
        caller: r.caller,
        operation: r.operation,
        count: r.count,
        simulated: r.simulated,
        firstAt: r.first_at,
        lastAt: r.last_at,
      })),
      nextCursor:
        rows.length > input.limit && last
          ? encodeCursor({
              f: READ_COUNTS_SORT.field,
              d: "desc",
              v: last.hour,
              id: JSON.stringify([last.actor, last.user_id, last.caller, last.operation]),
            })
          : null,
    };
  },
});

const storageOutput = z.object({
  sizeBytes: z.number().nullable().describe("Database size now, when the runtime reports it"),
  capBytes: z.number().describe("D1's hard limit per database"),
  warnBytes: z.number(),
  criticalBytes: z.number(),
  level: z.enum(["ok", "warning", "critical", "unknown"]),
  tables: z.array(z.object({ table: z.string(), rows: z.number() })),
  measuredAt: z.string().nullable().describe("When the row counts were taken (daily, or refresh)"),
  measuredSizeBytes: z.number().nullable(),
});

function storageView(
  live: number | null,
  stats: Awaited<ReturnType<typeof loadStorageStats>>,
): z.infer<typeof storageOutput> {
  const size = live ?? stats?.sizeBytes ?? null;
  return {
    sizeBytes: size,
    capBytes: D1_MAX_BYTES,
    warnBytes: STORAGE_WARN_BYTES,
    criticalBytes: STORAGE_CRITICAL_BYTES,
    level:
      size === null
        ? "unknown"
        : size >= STORAGE_CRITICAL_BYTES
          ? "critical"
          : size >= STORAGE_WARN_BYTES
            ? "warning"
            : "ok",
    tables: Object.entries(stats?.tables ?? {})
      .map(([table, rows]) => ({ table, rows }))
      .sort((a, b) => b.rows - a.rows),
    measuredAt: stats?.measuredAt ?? null,
    measuredSizeBytes: stats?.sizeBytes ?? null,
  };
}

export const storageStatus = defineOperation({
  name: "storage.status",
  description:
    "How full the database is: its size against D1's 10 GB limit (warning from 6 GB, critical " +
    "from 8 GB) and row counts of the largest tables as of the last daily measurement. " +
    "Admins only. Read-only.",
  input: z.object({}),
  output: storageOutput,
  permission: "audit:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(_input, ctx) {
    // The size is one statement that reads no rows; the counts are the cached measurement.
    const crm = ctx.pipeline.crm;
    const live = crm.size ? await crm.size() : null;
    return storageView(live, await loadStorageStats(ctx.db));
  },
});

/** A refresh within this long of the last measurement returns the cached one. */
const REFRESH_MIN_MS = 10 * 60_000;

export const storageRefresh = defineOperation({
  name: "storage.refresh",
  description:
    "Measure the database again now (size and row counts of the largest tables) instead of " +
    "waiting for the daily measurement. Counting reads every row of those tables, so a refresh " +
    "within 10 minutes of the last returns that one. Admins only.",
  input: z.object({}),
  output: storageOutput,
  permission: "audit:read",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  auditSummary: (output) => ({ sizeBytes: output.sizeBytes, measuredAt: output.measuredAt }),
  async handler(_input, ctx) {
    const cached = await loadStorageStats(ctx.db);
    if (cached && Date.parse(ctx.now) - Date.parse(cached.measuredAt) < REFRESH_MIN_MS) {
      return storageView(null, cached);
    }
    // Measured directly: a cache row, not record data, so it is not part of the audited batch.
    const stats = await measureStorage(ctx.pipeline.crm, ctx.now);
    return storageView(stats.sizeBytes, stats);
  },
});

export const retentionOperations = [
  auditRetention,
  auditSetRetention,
  auditPurge,
  auditReadCounts,
  storageStatus,
  storageRefresh,
] as const;
