// The compaction review data in D1 (ADR 0341, spec W2 "Review data"): every cache observation, every
// planner decision with what the following turns really cost, and the learned cache lifetime per
// provider and model with its history. The thread's Durable Object sends these with the turn's one
// bookkeeping write; `ai.cacheReport` exports them in agent-core's export schema, and
// `pnpm ai:replay-cache` reruns the maths over that export. Sizes, prices and times only: never a
// prompt, a reply or anyone's words.
import {
  type CacheLifetimeState,
  type CacheReportExport,
  cacheObservationRecordSchema,
  compactionDecisionRecordSchema,
  DEFAULT_RAILS,
  emptyCacheLifetimeState,
  estimateCacheLifetime,
  type EstimateChange,
  observeCache,
  parseCacheReportExport,
} from "@relationship-os/agent-core/compaction";
import type { CoreDatabase } from "@relationship-os/db";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { HandlerContext } from "../operation.ts";

/** How long observations and decisions are kept. */
export const CACHE_REVIEW_RETENTION_DAYS = 180;

/** The rails' row in core_settings: separate from `ai_settings`, which only holds the registry. */
export const CACHE_RAILS_SETTING = "ai_compaction";

/** Admin settings for compaction: the planner's rails and the idle fallback (ADR 0341). */
export const cacheRailsSchema = z.object({
  minTokens: z.number().int().min(1_000).max(2_000_000),
  maxShareOfWindow: z.number().min(0.1).max(1),
  fallbackIdleMinutes: z.number().int().min(1).max(1_440),
});
export type CacheRails = z.infer<typeof cacheRailsSchema>;

export const DEFAULT_CACHE_RAILS: CacheRails = { ...DEFAULT_RAILS, fallbackIdleMinutes: 10 };

/** The admin's rails. A missing or unreadable setting means the defaults. */
export async function loadCacheRails(db: Kysely<CoreDatabase>): Promise<CacheRails> {
  const row = await db
    .selectFrom("core_settings")
    .select("value")
    .where("key", "=", CACHE_RAILS_SETTING)
    .executeTakeFirst();
  if (!row) return DEFAULT_CACHE_RAILS;
  try {
    return cacheRailsSchema.parse(JSON.parse(row.value));
  } catch {
    return DEFAULT_CACHE_RAILS;
  }
}

/** What a thread sends with a turn, or after an idle alarm or a compaction. */
export const cacheReviewSchema = z.object({
  role: z.string().min(1).max(60),
  /** The model to answer with an estimate for, and its published lifetime. */
  model: z.object({
    provider: z.string().min(1).max(60),
    model: z.string().min(1).max(200),
    publishedLifetimeSeconds: z.number().positive().nullable(),
  }),
  observations: z.array(cacheObservationRecordSchema).max(64),
  decisions: z.array(compactionDecisionRecordSchema).max(4),
  /** Decisions whose following turns have now run. */
  actuals: z
    .array(
      z.object({
        id: z.string().min(1),
        turns: z.number().int().positive(),
        cost: z.number().finite().nonnegative(),
      }),
    )
    .max(32),
});
export type CacheReview = z.infer<typeof cacheReviewSchema>;

/** The lifetime to plan with for one model. */
export const cacheEstimateSchema = z.object({
  provider: z.string(),
  model: z.string(),
  seconds: z.number().positive().nullable(),
  source: z.enum(["published", "learned", "fallback"]),
  confidence: z.number().min(0).max(1).nullable(),
});
export type CacheEstimate = z.infer<typeof cacheEstimateSchema>;

function readState(raw: string | undefined): CacheLifetimeState {
  if (!raw) return emptyCacheLifetimeState();
  try {
    return JSON.parse(raw) as CacheLifetimeState;
  } catch {
    return emptyCacheLifetimeState();
  }
}

/** D1 takes at most 100 bound values a statement, and an observation has nine columns. */
const INSERT_CHUNK = 9;

/**
 * Queues the review rows and the learner's update on the operation's batch, and returns the model's
 * estimate. The update is guarded by `version`: one that lost a race with another person's turn is
 * dropped, and its observations are still in core_ai_cache_observation for a replay.
 */
export async function writeCacheReview(
  ctx: HandlerContext,
  review: CacheReview,
): Promise<CacheEstimate> {
  const rows = review.observations.map((o) => ({
    at: o.at,
    provider: o.provider,
    model: o.model,
    role: o.role ?? review.role,
    gap_seconds: o.gapSeconds,
    prefix_unchanged: o.prefixUnchanged ? 1 : 0,
    cached_tokens: o.cachedTokens,
    prompt_tokens: o.promptTokens,
    prefix_tokens: o.prefixTokens ?? null,
  }));
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    ctx.write(ctx.db.insertInto("core_ai_cache_observation").values(rows.slice(i, i + INSERT_CHUNK)));
  }
  for (const d of review.decisions) {
    ctx.write(
      ctx.db.insertInto("core_ai_compaction_decision").values({
        id: d.id,
        at: d.at,
        provider: d.provider,
        model: d.model,
        role: d.role ?? review.role,
        decision: d.result.decision,
        rule: d.result.rule,
        input: JSON.stringify(d.input),
        result: JSON.stringify(d.result),
        actual_turns: null,
        actual_cost: null,
        actual_at: null,
      }),
    );
  }
  for (const a of review.actuals) {
    ctx.write(
      ctx.db
        .updateTable("core_ai_compaction_decision")
        .set({ actual_turns: a.turns, actual_cost: a.cost, actual_at: ctx.now })
        .where("id", "=", a.id),
    );
  }

  // One learner per model seen; a fallback model's observations teach its own estimate.
  const key = (provider: string, model: string) => `${provider}\n${model}`;
  const wanted = key(review.model.provider, review.model.model);
  const groups = new Map<string, CacheReview["observations"]>([[wanted, []]]);
  for (const o of review.observations) {
    const k = key(o.provider, o.model);
    groups.set(k, [...(groups.get(k) ?? []), o]);
  }
  let answer: CacheEstimate = {
    provider: review.model.provider,
    model: review.model.model,
    seconds: review.model.publishedLifetimeSeconds,
    source: review.model.publishedLifetimeSeconds === null ? "fallback" : "published",
    confidence: null,
  };
  for (const [k, observations] of groups) {
    const [provider = "", model = ""] = k.split("\n");
    const row = await ctx.db
      .selectFrom("core_ai_cache_estimate")
      .select(["state", "version", "published_seconds"])
      .where("provider", "=", provider)
      .where("model", "=", model)
      .executeTakeFirst();
    const published =
      k === wanted ? review.model.publishedLifetimeSeconds : (row?.published_seconds ?? null);
    const context = { publishedLifetimeSeconds: published };
    let state = readState(row?.state);
    const changes: EstimateChange[] = [];
    for (const o of observations) {
      const result = observeCache(
        state,
        {
          at: Date.parse(o.at),
          gapSeconds: o.gapSeconds,
          prefixUnchanged: o.prefixUnchanged,
          cachedTokens: o.cachedTokens,
          promptTokens: o.promptTokens,
          prefixTokens: o.prefixTokens ?? null,
        },
        context,
      );
      state = result.state;
      if (result.change) changes.push(result.change);
    }
    const estimate = estimateCacheLifetime(state, context);
    if (k === wanted) {
      answer = {
        provider,
        model,
        seconds: estimate.seconds,
        source: estimate.source,
        confidence: estimate.confidence,
      };
    }
    if (!observations.length) continue;
    const values = {
      state: JSON.stringify(state),
      learned_seconds: estimate.learnedSeconds,
      published_seconds: estimate.publishedSeconds,
      confidence: estimate.confidence,
      sample_size: estimate.sampleSize,
      updated_at: ctx.now,
    };
    const version = (row?.version ?? 0) + 1;
    if (row) {
      ctx.write(
        ctx.db
          .updateTable("core_ai_cache_estimate")
          .set({ ...values, version })
          .where("provider", "=", provider)
          .where("model", "=", model)
          .where("version", "=", row.version),
      );
    } else {
      ctx.write(
        ctx.db
          .insertInto("core_ai_cache_estimate")
          .values({ ...values, provider, model, version })
          .onConflict((oc) => oc.columns(["provider", "model"]).doNothing()),
      );
    }
    // Only if this update won: the row now carries our version and time.
    for (const change of changes) {
      ctx.write(
        ctx.db
          .insertInto("core_ai_cache_estimate_history")
          .columns(["provider", "model", "at", "from_seconds", "to_seconds", "reason", "sample_size"])
          .expression(
          ctx.db
            .selectFrom("core_ai_cache_estimate")
            .select((eb) => [
              eb.val(provider).as("provider"),
              eb.val(model).as("model"),
              eb.val(new Date(change.at).toISOString()).as("at"),
              eb.val(change.fromSeconds).as("from_seconds"),
              eb.val(change.toSeconds).as("to_seconds"),
              eb.val(change.reason).as("reason"),
              eb.val(change.sampleSize).as("sample_size"),
            ])
            .where("provider", "=", provider)
            .where("model", "=", model)
            .where("version", "=", version)
            .where("updated_at", "=", ctx.now),
        ),
      );
    }
  }
  return answer;
}

/** Every learned estimate, for Settings → AI. */
export async function listCacheEstimates(db: Kysely<CoreDatabase>) {
  const rows = await db
    .selectFrom("core_ai_cache_estimate")
    .select([
      "provider",
      "model",
      "learned_seconds",
      "published_seconds",
      "confidence",
      "sample_size",
      "updated_at",
    ])
    .orderBy("provider")
    .orderBy("model")
    .execute();
  return rows.map((r) => ({
    provider: r.provider,
    model: r.model,
    seconds: r.published_seconds ?? r.learned_seconds,
    source: (r.published_seconds !== null
      ? "published"
      : r.learned_seconds !== null
        ? "learned"
        : "fallback") as CacheEstimate["source"],
    learnedSeconds: r.learned_seconds,
    publishedSeconds: r.published_seconds,
    confidence: r.confidence,
    sampleSize: r.sample_size,
    updatedAt: r.updated_at,
  }));
}

/**
 * The tables as agent-core's export schema (`ai.cacheReport`). `limit` keeps the newest rows of each
 * table. A row that no longer fits the schema fails loudly here rather than in the replay.
 */
export async function buildCacheReport(
  db: Kysely<CoreDatabase>,
  options: { now: string; since?: string | undefined; limit: number },
): Promise<{ report: CacheReportExport; truncated: boolean }> {
  const since = options.since ?? "";
  const observations = await db
    .selectFrom("core_ai_cache_observation")
    .selectAll()
    .where("at", ">=", since)
    .orderBy("at", "desc")
    .orderBy("id", "desc")
    .limit(options.limit)
    .execute();
  const decisions = await db
    .selectFrom("core_ai_compaction_decision")
    .selectAll()
    .where("at", ">=", since)
    .orderBy("at", "desc")
    .limit(options.limit)
    .execute();
  const history = await db
    .selectFrom("core_ai_cache_estimate_history")
    .selectAll()
    .where("at", ">=", since)
    .orderBy("at", "desc")
    .orderBy("id", "desc")
    .limit(options.limit)
    .execute();
  const estimates = await db
    .selectFrom("core_ai_cache_estimate")
    .select(["provider", "model", "published_seconds"])
    .execute();
  const rails = await loadCacheRails(db);

  const models = new Map<string, CacheReportExport["models"][number]>();
  const seen = (provider: string, model: string, published: number | null = null) => {
    const k = `${provider}\n${model}`;
    const known = models.get(k);
    models.set(k, {
      provider,
      model,
      publishedLifetimeSeconds: published ?? known?.publishedLifetimeSeconds ?? null,
    });
  };
  for (const e of estimates) seen(e.provider, e.model, e.published_seconds);
  for (const row of [...observations, ...decisions, ...history]) seen(row.provider, row.model);

  const report = parseCacheReportExport({
    format: "relationship-os.ai-cache-report",
    version: 1,
    exportedAt: options.now,
    models: [...models.values()],
    params: {
      rails: { minTokens: rails.minTokens, maxShareOfWindow: rails.maxShareOfWindow },
    },
    observations: observations.reverse().map((o) => ({
      provider: o.provider,
      model: o.model,
      role: o.role,
      at: o.at,
      gapSeconds: o.gap_seconds,
      prefixUnchanged: o.prefix_unchanged === 1,
      cachedTokens: o.cached_tokens,
      promptTokens: o.prompt_tokens,
      prefixTokens: o.prefix_tokens,
    })),
    decisions: decisions.reverse().map((d) => ({
      id: d.id,
      provider: d.provider,
      model: d.model,
      role: d.role,
      at: d.at,
      input: JSON.parse(d.input) as unknown,
      result: JSON.parse(d.result) as unknown,
      actual:
        d.actual_turns !== null && d.actual_cost !== null
          ? { turns: d.actual_turns, cost: d.actual_cost }
          : null,
    })),
    estimateHistory: history.reverse().map((h) => ({
      provider: h.provider,
      model: h.model,
      at: h.at,
      fromSeconds: h.from_seconds,
      toSeconds: h.to_seconds,
      reason: h.reason,
      sampleSize: h.sample_size,
    })),
  });
  const truncated = [observations, decisions, history].some((rows) => rows.length >= options.limit);
  return { report, truncated };
}

const CSV_COLUMNS = [
  "record",
  "at",
  "provider",
  "model",
  "role",
  "gapSeconds",
  "prefixUnchanged",
  "cachedTokens",
  "promptTokens",
  "prefixTokens",
  "decisionId",
  "decision",
  "rule",
  "costContinue",
  "costCompact",
  "horizonTurns",
  "nextAlarmAt",
  "input",
  "actualTurns",
  "actualCost",
  "fromSeconds",
  "toSeconds",
  "reason",
  "sampleSize",
] as const;

type CsvRow = Partial<Record<(typeof CSV_COLUMNS)[number], string | number | boolean | null>>;

/** The report as rows for a spreadsheet: one table, its `record` column saying which kind a row is. */
export function cacheReportRows(report: CacheReportExport): string[][] {
  const line = (row: CsvRow) => CSV_COLUMNS.map((c) => String(row[c] ?? ""));
  return [
    [...CSV_COLUMNS],
    ...report.observations.map((o) => line({ record: "observation", ...o })),
    ...report.decisions.map((d) =>
      line({
        record: "decision",
        at: d.at,
        provider: d.provider,
        model: d.model,
        role: d.role ?? null,
        decisionId: d.id,
        decision: d.result.decision,
        rule: d.result.rule,
        costContinue: d.result.costContinue,
        costCompact: d.result.costCompact,
        horizonTurns: d.result.horizonTurns,
        nextAlarmAt: d.result.nextAlarmAt,
        input: JSON.stringify(d.input),
        actualTurns: d.actual?.turns ?? null,
        actualCost: d.actual?.cost ?? null,
      }),
    ),
    ...report.estimateHistory.map((h) => line({ record: "estimate-change", ...h })),
  ];
}

/** Drops observations and decisions past retention (the daily cron), a chunk at a time. */
export async function purgeCacheReview(
  db: Kysely<CoreDatabase>,
  now: string,
  { chunk = 500, maxChunks = 20 }: { chunk?: number; maxChunks?: number } = {},
): Promise<{ deleted: number; more: boolean }> {
  const cutoff = new Date(
    Date.parse(now) - CACHE_REVIEW_RETENTION_DAYS * 86_400_000,
  ).toISOString();
  let deleted = 0;
  let more = false;
  for (let i = 0; i < maxChunks; i++) {
    const observations = await db
      .deleteFrom("core_ai_cache_observation")
      .where("id", "in", (eb) =>
        eb
          .selectFrom("core_ai_cache_observation")
          .select("id")
          .where("at", "<", cutoff)
          .orderBy("at")
          .limit(chunk),
      )
      .executeTakeFirst();
    const decisions = await db
      .deleteFrom("core_ai_compaction_decision")
      .where("id", "in", (eb) =>
        eb
          .selectFrom("core_ai_compaction_decision")
          .select("id")
          .where("at", "<", cutoff)
          .orderBy("at")
          .limit(chunk),
      )
      .executeTakeFirst();
    const n = Number(observations.numDeletedRows ?? 0);
    const m = Number(decisions.numDeletedRows ?? 0);
    deleted += n + m;
    more = n === chunk || m === chunk;
    if (!more) break;
  }
  return { deleted, more };
}
