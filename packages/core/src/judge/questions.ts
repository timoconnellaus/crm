// Building questions and validating answers (ADR 0230). Questions are plain data in Jev's wire
// shape. An answer is checked before any placement sees it: every question answered, of the kind
// asked, and every label offered given a finite probability between 0 and 1. Anything less is
// `incomplete-answer`, never a partial judgement.
import type {
  ChoiceQuestion,
  Entry,
  JudgeUnavailable,
  NoulQuestion,
  Question,
  Questions,
  ScoreQuestion,
} from "./types.ts";

/** One label from a closed set, each described. Always offer a way out (lesson 7). */
export function choice<const L extends string>(
  instructions: Entry,
  criteria: Record<L, Entry>,
): ChoiceQuestion<L> {
  const labels = Object.keys(criteria);
  if (labels.length < 2) throw new Error("A choice needs at least two labels");
  if (labels.length > 255) throw new Error("A choice takes at most 255 labels");
  return { type: "choice", instructions, criteria };
}

/** The probability that one condition holds, with what yes and no mean. */
export function noul(
  instructions: Entry,
  criteria?: { true?: Entry; false?: Entry },
): NoulQuestion {
  return { type: "noul", instructions, ...(criteria ? { criteria } : {}) };
}

/** A position on one ordered scale of 2 to 10 levels, from level 0. */
export function score(instructions: Entry, levels: Entry[]): ScoreQuestion {
  if (levels.length < 2 || levels.length > 10) throw new Error("A score takes 2 to 10 levels");
  return { type: "score", instructions, criteria: levels };
}

/** The labels a choice offers, in order. */
export function labelsOf<L extends string>(question: ChoiceQuestion<L>): L[] {
  return Object.keys(question.criteria) as L[];
}

const isProbability = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/** Tolerance on a distribution's sum (Jev rounds to two places). */
const SUM_TOLERANCE = 0.05;

function distributionProblem(
  name: string,
  probabilities: unknown,
  keys: readonly string[],
): string | null {
  if (!probabilities || typeof probabilities !== "object" || Array.isArray(probabilities)) {
    return `${name}: no probabilities`;
  }
  const record = probabilities as Record<string, unknown>;
  let sum = 0;
  for (const key of keys) {
    const p = record[key];
    if (!isProbability(p)) return `${name}: no finite probability for "${key}"`;
    sum += p;
  }
  if (Math.abs(sum - 1) > SUM_TOLERANCE) return `${name}: probabilities sum to ${sum.toFixed(3)}`;
  return null;
}

function answerProblem(name: string, question: Question, answer: unknown): string | null {
  if (!answer || typeof answer !== "object") return `${name}: not answered`;
  const a = answer as Record<string, unknown>;
  if (a.type !== question.type)
    return `${name}: answered as ${String(a.type)}, asked as ${question.type}`;
  switch (question.type) {
    case "noul":
      return isProbability(a.noul) ? null : `${name}: no finite probability`;
    case "choice": {
      const labels = Object.keys(question.criteria);
      if (typeof a.choice !== "string" || !labels.includes(a.choice)) {
        return `${name}: chose a label that was not offered`;
      }
      if (!isProbability(a.confidence)) return `${name}: no finite confidence`;
      return distributionProblem(name, a.probabilities, labels);
    }
    case "score": {
      const levels = question.criteria.map((_, i) => String(i));
      if (typeof a.score !== "number" || !Number.isFinite(a.score)) return `${name}: no score`;
      if (!isProbability(a.confidence)) return `${name}: no finite confidence`;
      return distributionProblem(name, a.probabilities, levels);
    }
  }
}

/**
 * The answers of a response body when they are whole, or `incomplete-answer` naming the first
 * problem. Only the questions asked are kept (an extra answer is ignored).
 */
export function validateAnswers(
  questions: Questions,
  answers: unknown,
): { ok: true; answers: Record<string, unknown> } | { ok: false; unavailable: JudgeUnavailable } {
  const incomplete = (detail: string) => ({
    ok: false as const,
    unavailable: { status: "unavailable" as const, reason: "incomplete-answer" as const, detail },
  });
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    return incomplete("the response has no answers");
  }
  const given = answers as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [name, question] of Object.entries(questions)) {
    const problem = answerProblem(name, question, given[name]);
    if (problem) return incomplete(problem);
    out[name] = given[name];
  }
  return { ok: true, answers: out };
}
