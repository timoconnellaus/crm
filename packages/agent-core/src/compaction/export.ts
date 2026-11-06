// The cache report export (spec W2, "Review data"). `ai.cacheReport` produces exactly this JSON from
// the D1 tables, and `pnpm ai:replay-cache <export.json>` reruns the learner and planner over it.
// No message content: only sizes, prices, times and decisions.
//
// Record times (`at`, `exportedAt`) are ISO 8601 strings. A decision's `input` is the planner's
// input verbatim, so its `now` and `lastRequestAt` stay epoch milliseconds.

import { z } from "zod";
import type { PlanInput } from "./plan.ts";

export const CACHE_REPORT_FORMAT = "relationship-os.ai-cache-report";
export const CACHE_REPORT_VERSION = 1;

const nonNegative = z.number().finite().nonnegative();
const isoTime = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: "expected an ISO 8601 time" });

/** One row of `core_ai_cache_observation`. */
export const cacheObservationRecordSchema = z.object({
  workspaceId: z.string().optional(),
  provider: z.string().min(1),
  model: z.string().min(1),
  role: z.string().optional(),
  at: isoTime,
  gapSeconds: nonNegative,
  prefixUnchanged: z.boolean(),
  cachedTokens: nonNegative,
  promptTokens: nonNegative,
  prefixTokens: nonNegative.nullable().optional(),
});

const priceSchema = nonNegative.nullable().optional();

/** The planner's input, verbatim. */
export const planInputSchema = z.object({
  moment: z.enum(["turn-end", "idle"]),
  now: z.number().finite(),
  lastRequestAt: z.number().finite(),
  contextTokens: nonNegative,
  compactedTokens: nonNegative,
  noteTokens: nonNegative,
  contextWindow: z.number().finite().positive(),
  prices: z.object({
    input: nonNegative.nullable(),
    output: nonNegative.nullable(),
    cacheWrite: priceSchema,
    cachedInput: priceSchema,
  }),
  lifetime: z.object({
    seconds: z.number().finite().positive().nullable(),
    source: z.enum(["published", "learned", "fallback"]),
    confidence: z.number().min(0).max(1).nullable().optional(),
  }),
  usage: z.object({
    gapShares: z.array(nonNegative),
    addedTokensPerTurn: nonNegative,
    outputTokensPerTurn: nonNegative,
  }),
  rails: z
    .object({ minTokens: nonNegative.optional(), maxShareOfWindow: z.number().optional() })
    .optional(),
  params: z
    .object({
      maxHorizonTurns: z.number().optional(),
      fallbackIdleSeconds: z.number().optional(),
      alarmMarginMinSeconds: z.number().optional(),
      alarmMarginShare: z.number().optional(),
      fallbackWarmSeconds: z.number().optional(),
    })
    .optional(),
});

// The schema must describe a valid PlanInput; this line fails to compile if they drift apart.
type Assert<T extends true> = T;
export type _PlanInputSchemaMatches = Assert<
  z.infer<typeof planInputSchema> extends PlanInput ? true : false
>;

/** One row of `core_ai_compaction_decision`. */
export const compactionDecisionRecordSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().optional(),
  provider: z.string().min(1),
  model: z.string().min(1),
  role: z.string().optional(),
  at: isoTime,
  input: planInputSchema,
  result: z.object({
    decision: z.enum(["compact", "continue"]),
    rule: z.enum(["ceiling", "floor", "cost", "fallback", "unknown-prices"]),
    costContinue: z.number().finite().nullable(),
    costCompact: z.number().finite().nullable(),
    horizonTurns: z.number().finite().positive(),
    nextAlarmAt: z.number().finite().nullable(),
  }),
  /** What the following turns actually cost (filled in afterwards), or null if not yet known. */
  actual: z.object({ turns: z.number().int().positive(), cost: nonNegative }).nullable(),
});

/** One change of a learned estimate (the estimate's history). */
export const cacheEstimateChangeRecordSchema = z.object({
  workspaceId: z.string().optional(),
  provider: z.string().min(1),
  model: z.string().min(1),
  at: isoTime,
  fromSeconds: z.number().positive().nullable(),
  toSeconds: z.number().positive().nullable(),
  reason: z.enum(["rise", "fall"]),
  sampleSize: nonNegative,
});

/** Learner parameters that can be exported or overridden (the bucket edges are fixed). */
export const learnerOverridesSchema = z
  .object({
    halfLifeDays: z.number().positive(),
    hitShare: z.number(),
    hitBar: z.number(),
    lowerQuantile: z.number(),
    upperQuantile: z.number(),
    publishedPriorStrength: z.number(),
    publishedPriorAgreement: z.number(),
    minPrefixTokens: z.number(),
  })
  .partial();

export const cacheReportExportSchema = z.object({
  format: z.literal(CACHE_REPORT_FORMAT),
  version: z.literal(CACHE_REPORT_VERSION),
  exportedAt: isoTime,
  workspaceId: z.string().optional(),
  /** Every model that appears, with its published cache lifetime (null when none is published). */
  models: z.array(
    z.object({
      provider: z.string().min(1),
      model: z.string().min(1),
      publishedLifetimeSeconds: z.number().positive().nullable(),
    }),
  ),
  /** The parameters that produced the recorded estimates and decisions, where they differ from defaults. */
  params: z
    .object({
      learner: learnerOverridesSchema.optional(),
      rails: z
        .object({ minTokens: nonNegative.optional(), maxShareOfWindow: z.number().optional() })
        .optional(),
    })
    .optional(),
  observations: z.array(cacheObservationRecordSchema),
  decisions: z.array(compactionDecisionRecordSchema),
  estimateHistory: z.array(cacheEstimateChangeRecordSchema),
});

export type CacheObservationRecord = z.infer<typeof cacheObservationRecordSchema>;
export type CompactionDecisionRecord = z.infer<typeof compactionDecisionRecordSchema>;
export type CacheEstimateChangeRecord = z.infer<typeof cacheEstimateChangeRecordSchema>;
export type LearnerOverrides = z.infer<typeof learnerOverridesSchema>;
export type CacheReportExport = z.infer<typeof cacheReportExportSchema>;

/** Validate an export (for example `JSON.parse` of a file). Throws a ZodError naming the bad field. */
export function parseCacheReportExport(value: unknown): CacheReportExport {
  return cacheReportExportSchema.parse(value);
}
