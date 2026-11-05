// Every calibrated question of every built placement, by calibration key, with the threshold the
// code holds it to (ADR 0231). The calibration-record test walks this: a placement adds its
// questions here when it ships.

import { POLICY_CALIBRATED } from "./questions/adjudicator-policy.ts";
import {
  CALIBRATED_QUESTIONS as INTENT_QUESTIONS_BY_KEY,
  INTENT_THRESHOLDS,
  type IntentQuestionId,
} from "./questions/authoring-intent.ts";
import type { Question } from "./types.ts";

export const CALIBRATED: Record<string, { question: Question; threshold: number }> = {
  ...Object.fromEntries(
    Object.entries(INTENT_QUESTIONS_BY_KEY).map(([key, question]) => [
      key,
      { question, threshold: INTENT_THRESHOLDS[key.split("/")[1] as IntentQuestionId] },
    ]),
  ),
  ...POLICY_CALIBRATED,
};
