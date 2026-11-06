// Placement `memory.condition` (ADR 0342, stage 17 W3): a conditional memory line holds a
// view-style filter the assistant wrote from the person's words ("when I'm on an organisation with
// more than 500 people"). Does the filter pick out the records the person described? Asked once in
// `memory.propose` for a conditional line, from the person's words and the filter in words
// (composed by code from the field registry: "Organisations where Employees is more than 500").
// No record content is sent.
//
// What follows (code): a confident match goes on the read-back card as "Checked: matches what you
// said", and the person confirms. Anything else is not saved: the assistant is told the filter
// does not match and rewrites it or asks. When the judge is off or cannot answer, the read-back
// alone decides: the person sees the condition in words and confirms (fails closed).
import { choice } from "../questions.ts";
import { failureOf, type Judge, type JudgeUnavailableReason } from "../types.ts";

export const MEMORY_CONDITION_PLACEMENT = "memory.condition" as const;

// ---------------------------------------------------------------------------------------------
// The question. Changing a word here changes its hash: recalibrate (`pnpm eval:calibrate --only
// memory.condition`) and commit the recordings and calibration.json in the same PR.

export const MEMORY_CONDITION_QUESTION = choice(
  "A CRM assistant will remember `line` only on records that match `condition`, a filter it wrote from what the person said (`said`). `condition` is written out in words: the kind of record, then each field, comparison and value. Does `condition` pick out the records the person described?",
  {
    as_said:
      "Yes: the kind of record the person named, and fields, comparisons and values that mean what they said. A field that clearly means the person's word counts, such as Employees for people working there",
    different:
      "No: it picks out other records than the person described: the wrong kind of record (organisations where the person meant people, or people where they meant organisations), another field, a different comparison (such as at least for more than), another value, or a part of what they said left out or added",
    unclear: "`said` does not say which records the person means",
  },
);

export type MemoryConditionLabel = keyof typeof MEMORY_CONDITION_QUESTION.criteria;

/**
 * P(as_said) at or above this is a match. Set from the labelled set
 * (evals/judge/sets/memory-condition.ts, calibration.json). A false match puts a wrong condition
 * on a card the person still reads and confirms; a missed one sends the assistant back to rewrite
 * a correct filter once. The person's confirmation backs both, so the threshold sits mid-gap,
 * leaning low: a vague "the bigger ones" sits just under it, and the person still reads it.
 */
export const MEMORY_CONDITION_THRESHOLD = 0.55;

export interface MemoryConditionState {
  said: string;
  condition: string;
  line: string;
}

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

export function memoryConditionState(input: {
  said: string;
  condition: string;
  line: string;
}): MemoryConditionState {
  return {
    said: clip(input.said, 1_000),
    condition: clip(input.condition, 600),
    line: clip(input.line, 300),
  };
}

export type MemoryConditionAsked =
  | {
      status: "answered";
      probabilities: Record<MemoryConditionLabel, number>;
      /** P(as_said) at or above the threshold. */
      matches: boolean;
      model: string;
      inputTokens: number;
    }
  | { status: "failed"; reason: JudgeUnavailableReason | "fault" };

/** Asks whether the filter matches the person's words, in one call. Never throws. */
export async function askMemoryCondition(
  judge: Judge,
  state: MemoryConditionState,
  options: { signal?: AbortSignal } = {},
): Promise<MemoryConditionAsked> {
  const outcome = await judge.ask({
    placement: MEMORY_CONDITION_PLACEMENT,
    state: state as unknown as Record<string, unknown>,
    questions: { matches: MEMORY_CONDITION_QUESTION },
    signal: options.signal,
  });
  if (outcome.status !== "answered") return { status: "failed", reason: failureOf(outcome) };
  const probabilities = outcome.answers.matches.probabilities as Record<
    MemoryConditionLabel,
    number
  >;
  return {
    status: "answered",
    probabilities,
    matches: (probabilities.as_said ?? 0) >= MEMORY_CONDITION_THRESHOLD,
    model: outcome.model,
    inputTokens: outcome.inputTokens,
  };
}

/** The calibrated question of this placement, by calibration key. */
export const MEMORY_CONDITION_CALIBRATED: Record<
  string,
  { question: typeof MEMORY_CONDITION_QUESTION; threshold: number }
> = {
  [`${MEMORY_CONDITION_PLACEMENT}/as_said`]: {
    question: MEMORY_CONDITION_QUESTION,
    threshold: MEMORY_CONDITION_THRESHOLD,
  },
};
