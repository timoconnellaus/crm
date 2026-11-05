// The Judge seam (ADR 0204 amendment, 2026-11-05): a typed-decision interface the policy
// adjudicator asks its questions through. A judge only judges: it answers a question with
// probabilities over the allowed answers, or says it is unavailable. Code decides what follows
// (thresholds, approve or escalate), never the judge.
//
// Two question kinds, modelled on typed-judgment models such as TypeSafe AI's Jev:
// - `choice`: pick one of a fixed set of labels → a probability per label;
// - `noul`: a yes / no question that may also be unknowable → probabilities for yes, no, unknown.
//
// Implementations: `llmJudge` (here), any chat model through the registry's `review` role, in
// JSON mode with zod validation. A Jev implementation is planned for "Stage 11: Jev"; this module
// adds no Jev SDK or provider.
//
// Failing closed: an implementation that cannot answer (model error, no valid reply, not
// configured) returns `{ status: "unavailable" }`. Callers treat that as "ask a person", never as
// an approval.
//
// Free of Worker-only imports (the adjudicator eval runs it in plain Node).
import { z } from "zod";

/** Text the judge reads. `instructions` and `context` are trusted; `subject` is untrusted data. */
interface QuestionBase {
  /** What to decide and how (trusted: written by us). */
  instructions: string;
  /** Background the decision rests on, e.g. the org's written policy (trusted: written by admins). */
  context?: string | undefined;
  /** The thing being judged (untrusted: it may contain text written to sway the judge). */
  subject: unknown;
  /** Upper bound on the judge's output, where it applies. */
  maxTokens?: number | undefined;
}

export interface ChoiceQuestion<L extends string> extends QuestionBase {
  kind: "choice";
  labels: readonly L[];
}

export interface NoulQuestion extends QuestionBase {
  kind: "noul";
}

export const NOUL_LABELS = ["yes", "no", "unknown"] as const;
export type NoulLabel = (typeof NOUL_LABELS)[number];

export interface JudgeIdentity {
  /** `llm` today; `jev` from Stage 11. */
  kind: string;
  provider?: string | undefined;
  model?: string | undefined;
}

export type JudgeAnswer<L extends string> =
  | {
      status: "answered";
      /** A probability per label, summing to 1. */
      probabilities: Record<L, number>;
      /** Why, for the human reviewer (when the judge gives one). */
      rationale?: string | undefined;
      judge: JudgeIdentity;
      attempts: number;
    }
  | {
      status: "unavailable";
      code: "model_error" | "invalid_reply" | "not_configured";
      reason: string;
      judge?: JudgeIdentity | undefined;
      attempts: number;
    };

export interface Judge {
  readonly kind: string;
  choice<L extends string>(question: ChoiceQuestion<L>): Promise<JudgeAnswer<L>>;
  noul(question: NoulQuestion): Promise<JudgeAnswer<NoulLabel>>;
}

/** The most likely label and its probability (ties go to the label listed first). */
export function topLabel<L extends string>(
  probabilities: Record<L, number>,
  labels: readonly L[],
): { label: L; probability: number } {
  let best = labels[0] as L;
  for (const label of labels) {
    if ((probabilities[label] ?? 0) > (probabilities[best] ?? 0)) best = label;
  }
  return { label: best, probability: probabilities[best] ?? 0 };
}

// --- The LLM judge ------------------------------------------------------------------------------

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
interface ChatResult {
  text: string;
  model: string;
  provider?: string | undefined;
  finishReason?: string | undefined;
}
/** A chat model in JSON mode: `models.run("review", messages, { json: true })` or an eval client. */
export type JudgeModel = (
  messages: ChatMessage[],
  options: { maxTokens?: number; json?: boolean },
) => Promise<ChatResult>;

export interface LlmJudgeOptions {
  /** The reply's field naming the chosen label (default `choice`). */
  answerKey?: string;
  /** Wraps the untrusted subject in these tags (default `subject`). */
  subjectTag?: string;
  /** How a subject is serialised (default pretty JSON). */
  serialise?: (subject: unknown) => string;
}

const probability = z.preprocess(
  (v) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v),
  z.number().min(0).max(1),
);

/** Builds the messages for a question: trusted text in the system message, the subject fenced. */
export function judgeMessages(
  question: QuestionBase & { labels: readonly string[] },
  options: LlmJudgeOptions = {},
): ChatMessage[] {
  const tag = options.subjectTag ?? "subject";
  const key = options.answerKey ?? "choice";
  const body = (options.serialise ?? ((s) => JSON.stringify(s, null, 2)))(question.subject);
  // `<` only occurs inside JSON strings, where < is the same character: the tags hold.
  const fenced = body.replace(/</g, "\\u003c");
  const format =
    `Reply with only a JSON object and nothing else: {"${key}": ${question.labels
      .map((l) => JSON.stringify(l))
      .join(" | ")}, "confidence": <a number from 0 to 1: how sure you are>, ` +
    `"reason": "<one or two sentences>"}`;
  return [
    {
      role: "system",
      content: [question.instructions.trim(), question.context?.trim(), format]
        .filter(Boolean)
        .join("\n\n"),
    },
    { role: "user", content: `Judge this.\n\n<${tag}>\n${fenced}\n</${tag}>` },
  ];
}

export type ParsedChoice<L extends string> =
  | { ok: true; label: L; confidence: number; reason: string }
  | { ok: false; problem: string };

/** Validates a reply's text. A reply cut off at the token limit is never accepted. */
export function parseChoiceReply<L extends string>(
  text: string,
  labels: readonly L[],
  finishReason?: string,
  answerKey = "choice",
): ParsedChoice<L> {
  if (finishReason === "length") {
    return { ok: false, problem: "the reply was cut off at the token limit" };
  }
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  if (!trimmed) return { ok: false, problem: "the reply was empty" };
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) return { ok: false, problem: "the reply was not a JSON object" };
  let json: unknown;
  try {
    json = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return { ok: false, problem: "the reply was not valid JSON" };
  }
  const schema = z.object({
    [answerKey]: z.preprocess(
      (v) => (typeof v === "string" ? v.trim().toLowerCase() : v),
      z.enum(labels as unknown as [L, ...L[]]),
    ),
    confidence: probability,
    reason: z.string().trim().min(1).max(2000),
  });
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      problem: `the JSON did not match the format (${parsed.error.issues
        .map((i) => `${i.path.join(".") || "reply"}: ${i.message}`)
        .join("; ")})`,
    };
  }
  const value = parsed.data as Record<string, unknown>;
  return {
    ok: true,
    label: value[answerKey] as L,
    confidence: value.confidence as number,
    reason: value.reason as string,
  };
}

/**
 * An LLM's single label and confidence as probabilities: the chosen label gets the confidence and
 * the others share the rest evenly. (An LLM states one confidence, not a distribution.)
 */
export function choiceProbabilities<L extends string>(
  labels: readonly L[],
  chosen: L,
  confidence: number,
): Record<L, number> {
  const rest = labels.length > 1 ? (1 - confidence) / (labels.length - 1) : 0;
  return Object.fromEntries(labels.map((l) => [l, l === chosen ? confidence : rest])) as Record<
    L,
    number
  >;
}

/** Any chat model as a Judge: JSON mode, zod validation, one repair round, fail closed. */
export function llmJudge(model: JudgeModel, options: LlmJudgeOptions = {}): Judge {
  const key = options.answerKey ?? "choice";
  const ask = async <L extends string>(
    question: QuestionBase & { labels: readonly L[] },
  ): Promise<JudgeAnswer<L>> => {
    const messages = judgeMessages(question, options);
    const runOptions = {
      json: true,
      ...(question.maxTokens ? { maxTokens: question.maxTokens } : {}),
    };
    let attempts = 0;
    let last: ChatResult | undefined;
    for (;;) {
      attempts += 1;
      try {
        last = await model(messages, runOptions);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          status: "unavailable",
          code: "model_error",
          reason: `The reviewer model failed: ${message.slice(0, 300)}`,
          attempts,
          ...(last ? { judge: { kind: "llm", provider: last.provider, model: last.model } } : {}),
        };
      }
      const judge: JudgeIdentity = { kind: "llm", provider: last.provider, model: last.model };
      const parsed = parseChoiceReply(last.text, question.labels, last.finishReason, key);
      if (parsed.ok) {
        return {
          status: "answered",
          probabilities: choiceProbabilities(question.labels, parsed.label, parsed.confidence),
          rationale: parsed.reason,
          judge,
          attempts,
        };
      }
      if (attempts >= 2) {
        return {
          status: "unavailable",
          code: "invalid_reply",
          reason: `The reviewer gave no valid answer: ${parsed.problem}`,
          judge,
          attempts,
        };
      }
      // One repair round: show it its reply and what was wrong.
      messages.push(
        { role: "assistant", content: last.text.slice(0, 2000) || "(empty)" },
        {
          role: "user",
          content: `That reply was not usable: ${parsed.problem}. Reply again with only the JSON object described in your instructions, and keep the reason short.`,
        },
      );
    }
  };
  return {
    kind: "llm",
    choice: (question) => ask(question),
    noul: (question) => ask({ ...question, labels: NOUL_LABELS }),
  };
}

/** A judge that is not configured: every question is unavailable (fails closed). */
export function unavailableJudge(reason: string): Judge {
  const answer = async () => ({
    status: "unavailable" as const,
    code: "not_configured" as const,
    reason,
    attempts: 0,
  });
  return { kind: "none", choice: answer, noul: answer };
}
