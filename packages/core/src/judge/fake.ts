// Judges without Jev: `offJudge` (no key, or a placement switched off: answers `off` and makes no
// network call) and `fakeJudge` (scripted, for tests).
import type { JudgePlacementId } from "./placements.ts";
import { validateAnswers } from "./questions.ts";
import type {
  Judge,
  Judged,
  JudgeFault,
  JudgeOutcome,
  JudgeRequest,
  JudgeState,
  JudgeUnavailable,
  JudgeUnavailableReason,
  Questions,
} from "./types.ts";

/** The judge when it is off: every call is `unavailable: off`, with no network call. */
export const offJudge: Judge = {
  provider: "off",
  async ask() {
    return { status: "unavailable", reason: "off" };
  },
};

/** A judge that is unavailable for one reason (tests of every fail path). */
export function unavailableJudge(reason: JudgeUnavailableReason, detail?: string): Judge {
  return {
    provider: "fake",
    async ask() {
      return { status: "unavailable", reason, ...(detail ? { detail } : {}) };
    },
  };
}

/** One call a fake judge saw. */
export interface FakeJudgeCall {
  placement: JudgePlacementId;
  state: JudgeState;
  questions: Questions;
}

/**
 * What a scripted judge answers: the raw answers by question id (validated as Jev's would be,
 * so a script that leaves a question out is `incomplete-answer`), or a non-answer.
 */
export type FakeJudgeReply =
  | Record<string, unknown>
  | JudgeUnavailable
  | JudgeFault
  | ((call: FakeJudgeCall) => Record<string, unknown> | JudgeUnavailable | JudgeFault);

export interface FakeJudge extends Judge {
  readonly calls: FakeJudgeCall[];
}

const isNonAnswer = (value: unknown): value is JudgeUnavailable | JudgeFault =>
  Boolean(value) &&
  typeof value === "object" &&
  ((value as { status?: unknown }).status === "unavailable" ||
    (value as { status?: unknown }).status === "fault");

/**
 * A scripted judge. `script` answers each call (a function sees the call), or per placement. It
 * records every call, so a test can count calls and read exactly what went in `state`.
 */
export function fakeJudge(
  script: FakeJudgeReply | Partial<Record<JudgePlacementId, FakeJudgeReply>>,
  options: { byPlacement?: boolean } = {},
): FakeJudge {
  const calls: FakeJudgeCall[] = [];
  return {
    provider: "fake",
    calls,
    async ask<const Q extends Questions>(request: JudgeRequest<Q>): Promise<JudgeOutcome<Q>> {
      const call: FakeJudgeCall = {
        placement: request.placement,
        state: request.state,
        questions: request.questions,
      };
      calls.push(call);
      const entry = options.byPlacement
        ? (script as Partial<Record<JudgePlacementId, FakeJudgeReply>>)[request.placement]
        : (script as FakeJudgeReply);
      if (entry === undefined) return { status: "unavailable", reason: "off" };
      const reply = typeof entry === "function" ? entry(call) : entry;
      if (isNonAnswer(reply)) return reply;
      const valid = validateAnswers(request.questions, reply);
      if (!valid.ok) return valid.unavailable;
      return {
        status: "answered",
        model: "fake",
        answers: valid.answers as Judged<Q>["answers"],
        inputTokens: 0,
        latencyMs: 0,
        source: "fake",
      };
    },
  };
}

/** A choice answer for a script: all probability on `label`, or the distribution given. */
export function choiceAnswer<L extends string>(
  labels: readonly L[],
  chosen: L | Partial<Record<L, number>>,
): { type: "choice"; choice: L; probabilities: Record<L, number>; confidence: number } {
  const probabilities = Object.fromEntries(
    labels.map((l) => [l, typeof chosen === "string" ? (l === chosen ? 1 : 0) : (chosen[l] ?? 0)]),
  ) as Record<L, number>;
  let best = labels[0] as L;
  for (const l of labels) if (probabilities[l] > probabilities[best]) best = l;
  return { type: "choice", choice: best, probabilities, confidence: probabilities[best] };
}
