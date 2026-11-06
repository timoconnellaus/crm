// The judge seam (ADR 0230, docs/jev.md "The seam"): typed questions about one piece of evidence,
// answered with probabilities, or "unavailable" with a reason. Code holds every threshold and
// decides what follows; an answer is a judgement, never permission.
//
// The question and answer shapes are Jev's wire format (`POST /v1/systemone`), as plain data, so
// a question built here is sent as it is and a recording of it replays byte for byte. Question ids
// (the keys of `questions`) never reach the model; labels, descriptions and instructions do.
//
// Free of Worker-only imports and erasable TypeScript: the eval runners import it in plain Node.
import type { JudgePlacementId } from "./placements.ts";

export type { JudgePlacementId };

/** What the judge reads: text, or JSON. Keep it small (lesson 13). */
export type JudgeState = string | Record<string, unknown> | unknown[];

/** An instruction or a criterion: text, or structured JSON where contrast reads better. */
export type Entry = string | Record<string, unknown> | unknown[];

export interface ChoiceQuestion<L extends string = string> {
  type: "choice";
  instructions: Entry;
  /** Every label on offer and what it means. Always include a way out (lesson 7). */
  criteria: Record<L, Entry>;
}

export interface NoulQuestion {
  type: "noul";
  instructions: Entry;
  criteria?: { true?: Entry; false?: Entry };
}

export interface ScoreQuestion {
  type: "score";
  instructions: Entry;
  /** 2 to 10 levels, ordered from level 0. */
  criteria: Entry[];
}

export type Question = ChoiceQuestion | NoulQuestion | ScoreQuestion;
export type Questions = Record<string, Question>;

export interface ChoiceAnswer<L extends string = string> {
  type: "choice";
  choice: L;
  /** A probability per label offered, summing to 1. */
  probabilities: Record<L, number>;
  confidence: number;
}

export interface NoulAnswer {
  type: "noul";
  /** The probability that the condition holds. */
  noul: number;
}

export interface ScoreAnswer {
  type: "score";
  /** The probability-weighted expected level. */
  score: number;
  /** Level index (as a string) → probability. */
  probabilities: Record<string, number>;
  confidence: number;
}

/** The answer to one question, typed by its kind. */
export type AnswerOf<Q> =
  Q extends ChoiceQuestion<infer L>
    ? ChoiceAnswer<L>
    : Q extends NoulQuestion
      ? NoulAnswer
      : Q extends ScoreQuestion
        ? ScoreAnswer
        : never;

/** Where an answer came from. */
export type JudgeSource = "live" | "replayed" | "fake";

/** A whole, validated set of answers. */
export interface Judged<Q extends Questions> {
  status: "answered";
  /** The model the response reported (`jev-1.14.0`). */
  model: string;
  answers: { [K in keyof Q]: AnswerOf<Q[K]> };
  inputTokens: number;
  latencyMs: number;
  source: JudgeSource;
}

/**
 * Why the judge gave no answer (ADR 0230). None of these is a "no": each placement takes its own
 * fail path, open or closed, for every one of them.
 */
export const JUDGE_UNAVAILABLE_REASONS = [
  /** The judge is off: no key, or this placement is switched off. Not a failure. */
  "off",
  /** A key was expected (BYOK claimed, or a key name set) but none is reachable. */
  "no-key",
  /** The network call failed (DNS, connection, TLS). */
  "unreachable",
  /** No answer within the placement's timeout. */
  "timeout",
  /** HTTP 429. */
  "rate-limited",
  /** HTTP 402: the account has no credit. */
  "no-credit",
  /** HTTP 401 or 403: the key was refused. */
  "key-refused",
  /** HTTP 5xx (529 is TypeSafe's "overloaded"). */
  "server-error",
  /** An answer that is not a whole distribution over the labels offered. */
  "incomplete-answer",
] as const;
export type JudgeUnavailableReason = (typeof JUDGE_UNAVAILABLE_REASONS)[number];

export interface JudgeUnavailable {
  status: "unavailable";
  reason: JudgeUnavailableReason;
  /** For the log, never shown as a judgement. */
  detail?: string | undefined;
  /** HTTP status, when there was a response. */
  httpStatus?: number | undefined;
}

/**
 * A request the judge refused as malformed (HTTP 400, 413, 415 or 422): a bug of ours. It is
 * logged as an error, and the placement takes its fail path exactly as for an unavailable judge.
 */
export interface JudgeFault {
  status: "fault";
  httpStatus: number;
  detail: string;
}

export type JudgeOutcome<Q extends Questions> = Judged<Q> | JudgeUnavailable | JudgeFault;

export interface JudgeRequest<Q extends Questions> {
  /** A named place in the code that asks the judge (`placements.ts`). */
  placement: JudgePlacementId;
  state: JudgeState;
  questions: Q;
  signal?: AbortSignal | undefined;
}

/**
 * The judge. `ask` never throws for any reason above: it returns the answers, `unavailable` or
 * `fault`. Questions in one call are answered independently (lesson 8).
 */
export interface Judge {
  /** For the log: `jev`, `off` or `fake`. */
  readonly provider: string;
  ask<const Q extends Questions>(request: JudgeRequest<Q>): Promise<JudgeOutcome<Q>>;
  /** Is this placement switched on? Absent: it is, when the judge is not `off`. No network call. */
  isOn?(placement: JudgePlacementId): Promise<boolean>;
}

/** Could `placement` be asked at all (a key, and its switch on)? For what a feature offers. */
export async function placementAvailable(
  judge: Judge | undefined,
  placement: JudgePlacementId,
): Promise<boolean> {
  if (!judge || judge.provider === "off") return false;
  return judge.isOn ? judge.isOn(placement) : true;
}

export function isAnswered<Q extends Questions>(outcome: JudgeOutcome<Q>): outcome is Judged<Q> {
  return outcome.status === "answered";
}

/**
 * The judge calls a placement made for one stored result, for its spend count (ADR 0234): a call
 * that failed counts with no tokens; `off` makes no call and counts nothing.
 */
export interface JudgeCallUsage {
  calls: number;
  inputTokens: number;
}

/** Why a non-answer happened, as one word for notes and logs (`fault` for a JudgeFault). */
export function failureOf(
  outcome: JudgeUnavailable | JudgeFault,
): JudgeUnavailableReason | "fault" {
  return outcome.status === "fault" ? "fault" : outcome.reason;
}
