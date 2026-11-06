// Placement `orchestrator.suggest` (ADR 0344, stage 17 W5): does the person's request look like
// longer work, the kind an agent should do? Asked at the start of a turn, from the person's words
// and how many records they have selected. No record content is sent.
//
// What follows (code): a confident `long_work` adds one hint to the front agent's turn ("this
// looks like work across 20 records"). It never forces a choice: the model decides. Nothing is
// stored, so its spend is not counted. When the judge is off or cannot answer, no hint is added
// (fails open: advice only). The short timeout keeps it from holding up the reply.
import { choice } from "../questions.ts";
import { failureOf, type Judge, type JudgeUnavailableReason } from "../types.ts";

export const ORCHESTRATOR_PLACEMENT = "orchestrator.suggest" as const;

// ---------------------------------------------------------------------------------------------
// The question. Changing a word here changes its hash: recalibrate (`pnpm eval:calibrate --only
// orchestrator.suggest`) and commit the recordings and calibration.json in the same PR.

export const ORCHESTRATOR_QUESTION = choice(
  "`said` is what a person asked their CRM assistant. `selected`, when there is one, is how many records they have selected. How much work is the request?",
  {
    single_lookup:
      "One lookup, count, total or list that one query answers, one small change to one record, or a plain answer",
    short_work: "A couple of tool calls: a few records at most, done in a few seconds",
    long_work:
      "Work on many records one by one, research, or a bulk clean-up: anything that would take more than a few seconds or a couple of tool calls",
    unclear: "`said` does not ask for any work, or does not say enough to tell",
  },
);

export type OrchestratorLabel = keyof typeof ORCHESTRATOR_QUESTION.criteria;

/**
 * P(long_work) at or above this adds the hint. Set from the labelled set
 * (evals/judge/sets/orchestrator-suggest.ts, calibration.json). A false hint is a line the model
 * can ignore; a missed one leaves the model to decide alone, as without the judge. Mild both
 * ways: mid-gap, which sits below a half because requests that are not long work score low.
 */
export const ORCHESTRATOR_THRESHOLD = 0.4;

/** What the judge reads. */
export interface OrchestratorState {
  said: string;
  /** Records selected on the page, when any are. */
  selected?: number;
}

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

export function orchestratorState(input: { said: string; selected?: number }): OrchestratorState {
  return {
    said: clip(input.said, 1_000),
    ...(input.selected ? { selected: input.selected } : {}),
  };
}

export type OrchestratorAsked =
  | {
      status: "answered";
      probabilities: Record<OrchestratorLabel, number>;
      /** P(long_work) at or above the threshold. */
      longWork: boolean;
      model: string;
      inputTokens: number;
    }
  | { status: "failed"; reason: JudgeUnavailableReason | "fault" };

/** Asks how much work the request is, in one call. Never throws. */
export async function askOrchestrator(
  judge: Judge,
  state: OrchestratorState,
  options: { signal?: AbortSignal } = {},
): Promise<OrchestratorAsked> {
  const outcome = await judge.ask({
    placement: ORCHESTRATOR_PLACEMENT,
    state: state as unknown as Record<string, unknown>,
    questions: { size: ORCHESTRATOR_QUESTION },
    signal: options.signal,
  });
  if (outcome.status !== "answered") return { status: "failed", reason: failureOf(outcome) };
  const probabilities = outcome.answers.size.probabilities as Record<OrchestratorLabel, number>;
  return {
    status: "answered",
    probabilities,
    longWork: (probabilities.long_work ?? 0) >= ORCHESTRATOR_THRESHOLD,
    model: outcome.model,
    inputTokens: outcome.inputTokens,
  };
}

/** The calibrated question of this placement, by calibration key. */
export const ORCHESTRATOR_CALIBRATED: Record<
  string,
  { question: typeof ORCHESTRATOR_QUESTION; threshold: number }
> = {
  [`${ORCHESTRATOR_PLACEMENT}/long_work`]: {
    question: ORCHESTRATOR_QUESTION,
    threshold: ORCHESTRATOR_THRESHOLD,
  },
};
