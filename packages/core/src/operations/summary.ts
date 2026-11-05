// summary.* and semantic search operations (ADR 0153, ADR 0155).
//
// summary.get reads a cached summary and says whether it is still fresh (no model call);
// summary.generate makes one on request; summary.activityLines / summary.activities do the same
// for the one-line summaries of long emails and notes on a timeline, in batches. Every summary is
// labelled AI-generated in the UI. search.hybrid and record.similar are semantic search.
import { z } from "zod";
import { hybridSearch, similarRecords } from "../ai/hybrid.ts";
import {
  activitySummaryInput,
  changeSetSummaryInput,
  meetingPrepInput,
  readCachedSummary,
  recordSummaryInput,
  type SummaryInput,
  storeSummaryStatement,
  summariseModel,
  summaryMessages,
} from "../ai/summaries.ts";
import { ConfigError, OperationError } from "../errors.ts";
import {
  checkSummary,
  parseSummaryCheck,
  type SummaryCheck,
  summaryCheckMessage,
} from "../judge/questions/summary-statements.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { searchHitSchema } from "./search.ts";

const subjectSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("record"),
    object: z.enum(["person", "organisation", "deals.deal"]),
    id: z.string().min(1).max(80),
  }),
  z.object({
    kind: z.literal("meeting"),
    id: z.string().min(1).max(80).describe("A meeting activity"),
  }),
  z.object({
    kind: z.literal("changeset"),
    id: z.string().min(1).max(80).describe("A change set id"),
  }),
]);
type Subject = z.infer<typeof subjectSchema>;

/**
 * The judge's check of the summary (`summary.statements`, ADR 0237), or null when it did not run
 * (no key, switched off, or written before it existed). `withheld`: a change-set summary that
 * could not be checked, so the approver reads the diff instead of words nothing read.
 */
const summaryCheckOutput = z
  .object({
    status: z.enum(["checked", "unchecked", "withheld"]),
    /** Statements removed because the records do not say them. */
    removed: z.number().int(),
    /** What to show beside the summary, written by code. */
    message: z.string(),
  })
  .nullable();

const summaryOutput = z.object({
  status: z.enum(["fresh", "stale", "missing", "unavailable"]),
  text: z.string().nullable(),
  model: z.string().nullable(),
  generatedAt: z.string().nullable(),
  /** Always true: the UI labels the text "AI-generated". */
  aiGenerated: z.literal(true),
  message: z.string().nullable(),
  check: summaryCheckOutput.default(null),
});

function checkView(check: SummaryCheck | null): z.infer<typeof summaryCheckOutput> {
  const message = summaryCheckMessage(check);
  return check && message ? { status: check.status, removed: check.removed.length, message } : null;
}

const WITHHELD =
  "The summary could not be checked against the records, so it is not shown: review the changes below.";

const NOT_CONFIGURED = "AI is not configured for this deployment (docs/deploying.md)";

async function inputFor(ctx: HandlerContext, subject: Subject): Promise<SummaryInput> {
  switch (subject.kind) {
    case "record":
      return recordSummaryInput(ctx.db, subject.object, subject.id);
    case "meeting":
      return meetingPrepInput(ctx.db, subject.id);
    case "changeset":
      return changeSetSummaryInput(ctx.db, subject.id);
  }
}

export const summaryGet = defineOperation({
  name: "summary.get",
  description:
    "Read the cached AI summary of a person, organisation or deal, a meeting's prep brief, or a " +
    "change set's plain-English description, and whether it is still fresh (stale once the " +
    "record, its timeline, tasks or deals change). Never calls a model. Read-only.",
  input: z.object({ subject: subjectSchema }),
  output: summaryOutput,
  permission: "records:read",
  risk: "read",
  mcp: { expose: false },
  async handler(input, ctx) {
    const summary = await inputFor(ctx, input.subject);
    const cached = await readCachedSummary(ctx.db, summary, await summariseModel(ctx.models));
    // Without AI the cached text is still shown, but it cannot be checked or refreshed.
    const status: "fresh" | "stale" | "missing" | "unavailable" = !ctx.models
      ? "unavailable"
      : cached
        ? cached.fresh
          ? "fresh"
          : "stale"
        : "missing";
    return {
      status,
      text: cached?.text ?? null,
      model: cached?.model ?? null,
      generatedAt: cached?.createdAt ?? null,
      aiGenerated: true as const,
      message: status === "unavailable" ? NOT_CONFIGURED : null,
      check: checkView(parseSummaryCheck(cached?.checks)),
    };
  },
});

export const summaryGenerate = defineOperation({
  name: "summary.generate",
  description:
    "Generate (or regenerate) the AI summary of a person, organisation or deal, a meeting's " +
    "prep brief, or a change set's description with the summarise model role, and cache it. " +
    "Returns the cached one without a model call when it is still fresh. When the judge is on " +
    "(summary.statements), each statement is checked against the facts and any the records do " +
    "not support is removed before it is stored.",
  input: z.object({ subject: subjectSchema }),
  output: summaryOutput,
  permission: "records:read",
  risk: "write",
  // It only fills a cache; nothing for an approver to review.
  bookkeeping: true,
  actors: ["human", "assistant"],
  mcp: { expose: false },
  async handler(input, ctx) {
    if (!ctx.models) throw new ConfigError(NOT_CONFIGURED);
    const summary = await inputFor(ctx, input.subject);
    const hashModel = await summariseModel(ctx.models);
    const cached = await readCachedSummary(ctx.db, summary, hashModel);
    if (cached?.fresh) {
      return {
        status: "fresh" as const,
        text: cached.text,
        model: cached.model,
        generatedAt: cached.createdAt,
        aiGenerated: true as const,
        message: null,
        check: checkView(parseSummaryCheck(cached.checks)),
      };
    }
    let answer: { text: string; model: string };
    try {
      answer = await ctx.models.run("summarise", summaryMessages(summary));
    } catch (error) {
      throw new OperationError(
        "config",
        `The summarise model failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!answer.text) throw new OperationError("config", "The summarise model returned nothing");
    // summary.statements (ADR 0237): each statement against the facts it was written from, once,
    // before storing. Off changes nothing.
    const checked = await checkSummary({
      judge: ctx.judge,
      text: answer.text,
      facts: summary.judgeFacts ?? summary.facts,
      now: ctx.now,
    });
    if (checked.status === "unchecked" && summary.kind === "changeset") {
      // Fails closed: an approver must not decide from words nothing read. Nothing is stored, so
      // the next request writes and checks it again.
      return {
        status: "missing" as const,
        text: null,
        model: answer.model,
        generatedAt: null,
        aiGenerated: true as const,
        message: WITHHELD,
        check: { status: "withheld" as const, removed: 0, message: WITHHELD },
      };
    }
    const text = checked.status === "off" ? answer.text : checked.text;
    const check = checked.status === "off" ? null : checked.check;
    ctx.write(
      await storeSummaryStatement(
        ctx.db,
        summary,
        hashModel,
        { text, model: answer.model },
        ctx.now,
        ctx.user.id,
        check ? JSON.stringify(check) : null,
      ),
    );
    return {
      status: "fresh" as const,
      text,
      model: answer.model,
      generatedAt: ctx.now,
      aiGenerated: true as const,
      message: null,
      check: checkView(check),
    };
  },
});

const lineSchema = z.object({ id: z.string(), text: z.string(), fresh: z.boolean() });

export const summaryActivityLines = defineOperation({
  name: "summary.activityLines",
  description:
    "Cached one-line AI summaries for long emails and notes on a timeline, by activity id. " +
    "`missing` lists long activities with no fresh line yet (generate them with " +
    "summary.activities). Short, private and system activities have none. Read-only.",
  input: z.object({ ids: z.array(z.string().min(1).max(80)).max(50) }),
  output: z.object({
    lines: z.array(lineSchema),
    missing: z.array(z.string()),
    available: z.boolean(),
  }),
  permission: "records:read",
  risk: "read",
  mcp: { expose: false },
  async handler(input, ctx) {
    const model = await summariseModel(ctx.models);
    const lines: z.infer<typeof lineSchema>[] = [];
    const missing: string[] = [];
    for (const id of [...new Set(input.ids)]) {
      const summary = await activitySummaryInput(ctx.db, id, ctx.blobs);
      if (!summary) continue;
      const cached = await readCachedSummary(ctx.db, summary, model);
      if (cached) lines.push({ id, text: cached.text, fresh: cached.fresh });
      if (!cached?.fresh) missing.push(id);
    }
    return { lines, missing, available: Boolean(ctx.models) };
  },
});

/** Activities per summary.activities call: the batch the timeline asks for at once. */
export const ACTIVITY_BATCH = 10;

export const summaryActivities = defineOperation({
  name: "summary.activities",
  description:
    "Generate one-line AI summaries for up to 10 long emails or notes (a timeline's visible " +
    "batch) with the summarise role, and cache them. Fresh ones are returned without a model call.",
  input: z.object({ ids: z.array(z.string().min(1).max(80)).min(1).max(ACTIVITY_BATCH) }),
  output: z.object({ lines: z.array(lineSchema) }),
  permission: "records:read",
  risk: "write",
  bookkeeping: true,
  actors: ["human", "assistant"],
  mcp: { expose: false },
  async handler(input, ctx) {
    if (!ctx.models) throw new ConfigError(NOT_CONFIGURED);
    const models = ctx.models;
    const hashModel = await summariseModel(models);
    const lines: z.infer<typeof lineSchema>[] = [];
    const work: Promise<void>[] = [];
    for (const id of [...new Set(input.ids)]) {
      const summary = await activitySummaryInput(ctx.db, id, ctx.blobs);
      if (!summary) continue;
      const cached = await readCachedSummary(ctx.db, summary, hashModel);
      if (cached?.fresh) {
        lines.push({ id, text: cached.text, fresh: true });
        continue;
      }
      work.push(
        models
          .run("summarise", summaryMessages(summary), { maxTokens: 80 })
          .then(async (answer) => {
            const text = answer.text.split("\n")[0]?.trim() ?? "";
            if (!text) return;
            lines.push({ id, text, fresh: true });
            ctx.write(
              await storeSummaryStatement(
                ctx.db,
                summary,
                hashModel,
                { ...answer, text },
                ctx.now,
                ctx.user.id,
              ),
            );
          }),
      );
    }
    const settled = await Promise.allSettled(work);
    const failed = settled.find((s) => s.status === "rejected");
    if (failed && !lines.length) {
      throw new OperationError(
        "config",
        `The summarise model failed: ${String((failed as PromiseRejectedResult).reason)}`,
      );
    }
    return { lines: input.ids.flatMap((id) => lines.filter((l) => l.id === id)) };
  },
});

const hybridHitSchema = searchHitSchema.extend({
  score: z.number(),
  matchedBy: z.array(z.enum(["text", "meaning"])),
  text: z.string().optional(),
});

export const searchHybrid = defineOperation({
  name: "search.hybrid",
  description:
    "Search by meaning as well as words: full-text matches and semantic (embedding) matches " +
    "merged and ranked together, so 'customers worried about pricing' finds notes that never " +
    "use those words. Use it for natural-language questions; search.global is faster for names " +
    "as you type. withText adds each hit's indexed text (for answering from the results). " +
    "Falls back to full-text only when semantic search is not configured. Read-only.",
  input: z.object({
    query: z.string().trim().min(1).max(500),
    objects: z.array(z.string().min(1).max(80)).min(1).max(50).optional(),
    limit: z.number().int().min(1).max(30).default(10),
    withText: z.boolean().default(false),
  }),
  output: z.object({ hits: z.array(hybridHitSchema), semantic: z.boolean() }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    return hybridSearch(
      { db: ctx.db, models: ctx.models, vectors: ctx.vectors },
      { query: input.query, objects: input.objects, limit: input.limit, withText: input.withText },
    );
  },
});

export const recordSimilar = defineOperation({
  name: "record.similar",
  description:
    "Records most similar in meaning to one record (people like this person, organisations " +
    "like this one, related notes), from its stored embedding. Status not_indexed when it has " +
    "not been embedded yet, unavailable without semantic search. Read-only.",
  input: z.object({
    object: z.string().min(1).max(80),
    id: z.string().min(1).max(80),
    objects: z.array(z.string().min(1).max(80)).min(1).max(20).optional(),
    limit: z.number().int().min(1).max(20).default(5),
  }),
  output: z.object({
    status: z.enum(["ok", "unavailable", "not_indexed"]),
    hits: z.array(hybridHitSchema),
    message: z.string().nullable(),
  }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const result = await similarRecords(
      { db: ctx.db, models: ctx.models, vectors: ctx.vectors },
      { object: input.object, id: input.id, limit: input.limit, objects: input.objects },
    );
    return {
      status: result.status,
      hits: result.status === "ok" ? result.hits : [],
      message: result.status === "unavailable" ? result.message : null,
    };
  },
});

export const summaryOperations = [
  summaryGet,
  summaryGenerate,
  summaryActivityLines,
  summaryActivities,
  searchHybrid,
  recordSimilar,
] as const;
