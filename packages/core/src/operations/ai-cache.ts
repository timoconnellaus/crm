// ai.* operations for prompt caching and compaction (ADR 0341): Settings → AI's read-only cache
// lifetimes and the admin rails, the review export, and the bookkeeping write the thread uses when
// it has no turn to ride on (an idle alarm, a compaction).
import { z } from "zod";
import {
  buildCacheReport,
  CACHE_RAILS_SETTING,
  cacheEstimateSchema,
  cacheRailsSchema,
  cacheReportRows,
  cacheReviewSchema,
  DEFAULT_CACHE_RAILS,
  listCacheEstimates,
  loadCacheRails,
  writeCacheReview,
} from "../ai/cache-review.ts";
import { cacheReportExportSchema } from "@relationship-os/agent-core/compaction";
import { defineOperation } from "../operation.ts";
import { toCsv } from "./import.ts";

const estimateRow = z.object({
  provider: z.string(),
  model: z.string(),
  seconds: z.number().nullable(),
  source: z.enum(["published", "learned", "fallback"]),
  learnedSeconds: z.number().nullable(),
  publishedSeconds: z.number().nullable(),
  confidence: z.number().nullable(),
  sampleSize: z.number(),
  updatedAt: z.string(),
});

export const aiCacheSettings = defineOperation({
  name: "ai.cacheSettings",
  description:
    "Settings → AI (admins): the prompt cache lifetime in use per provider and model, where it " +
    "comes from (published or learned) and how sure it is, and the compaction rails. Read-only.",
  input: z.object({}),
  output: z.object({
    rails: cacheRailsSchema,
    defaults: cacheRailsSchema,
    estimates: z.array(estimateRow),
  }),
  permission: "settings:manage",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(_input, ctx) {
    return {
      rails: await loadCacheRails(ctx.db),
      defaults: DEFAULT_CACHE_RAILS,
      estimates: await listCacheEstimates(ctx.db),
    };
  },
});

export const aiUpdateCacheRails = defineOperation({
  name: "ai.updateCacheRails",
  description:
    "Set the compaction rails (admins): never compact a chat smaller than this many tokens, " +
    "always compact before it reaches this share of the model's window, and how many idle " +
    "minutes to wait while no cache lifetime is known. Between the rails, cost decides.",
  input: cacheRailsSchema,
  output: cacheRailsSchema,
  permission: "settings:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const before = await loadCacheRails(ctx.db);
    const value = JSON.stringify(input);
    ctx.write(
      ctx.db
        .insertInto("core_settings")
        .values({ key: CACHE_RAILS_SETTING, value, updated_at: ctx.now, updated_by: ctx.user.id })
        .onConflict((oc) =>
          oc.column("key").doUpdateSet({ value, updated_at: ctx.now, updated_by: ctx.user.id }),
        ),
    );
    ctx.recordChange({
      object: "ai_settings",
      id: CACHE_RAILS_SETTING,
      action: "update",
      before: { rails: before },
      after: { rails: input },
    });
    return input;
  },
});

export const aiCacheReport = defineOperation({
  name: "ai.cacheReport",
  description:
    "Export the prompt cache review data (admins): cache observations, compaction decisions " +
    "with what the following turns really cost, and each change of a learned lifetime. Sizes, " +
    "prices and times only, never message content. The JSON is what `pnpm ai:replay-cache` reads; " +
    "the CSV is one table for a spreadsheet. Read-only.",
  input: z.object({
    format: z.enum(["json", "csv"]).default("json"),
    since: z.iso.datetime().optional().describe("Only rows at or after this time"),
    limit: z.number().int().min(1).max(50_000).default(50_000).describe("Newest rows per table"),
  }),
  output: z.discriminatedUnion("format", [
    z.object({
      format: z.literal("json"),
      report: cacheReportExportSchema,
      truncated: z.boolean(),
    }),
    z.object({ format: z.literal("csv"), csv: z.string(), truncated: z.boolean() }),
  ]),
  permission: "settings:manage",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const { report, truncated } = await buildCacheReport(ctx.db, {
      now: ctx.now,
      since: input.since,
      limit: input.limit,
    });
    return input.format === "csv"
      ? { format: "csv" as const, csv: toCsv(cacheReportRows(report)), truncated }
      : { format: "json" as const, report, truncated };
  },
});

export const aiRecordCacheReview = defineOperation({
  name: "ai.recordCacheReview",
  description:
    "Record cache observations and compaction decisions from your assistant thread when no turn " +
    "is finishing (an idle alarm, a compaction). Called by the thread itself.",
  input: cacheReviewSchema,
  output: z.object({ estimate: cacheEstimateSchema }),
  permission: "records:read",
  risk: "write",
  bookkeeping: true,
  actors: ["human"],
  mcp: { expose: false },
  redact: ["observations", "decisions", "actuals"],
  async handler(input, ctx) {
    return { estimate: await writeCacheReview(ctx, input) };
  },
});

export const aiCacheOperations = [
  aiCacheSettings,
  aiUpdateCacheRails,
  aiCacheReport,
  aiRecordCacheReview,
] as const;
