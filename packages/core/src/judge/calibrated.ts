// Every calibrated question of every built placement, by calibration key, with the threshold the
// code holds it to (ADR 0231). The calibration-record test walks this: a placement adds its
// questions here when it ships.

import { POLICY_CALIBRATED } from "./questions/adjudicator-policy.ts";
import {
  CALIBRATED_QUESTIONS as INTENT_QUESTIONS_BY_KEY,
  INTENT_THRESHOLDS,
  type IntentQuestionId,
} from "./questions/authoring-intent.ts";
import { MEMORY_CONDITION_CALIBRATED } from "./questions/memory-condition.ts";
import { MEMORY_WRITE_CALIBRATED } from "./questions/memory-write.ts";
import { OUTBOUND_CALIBRATED } from "./questions/outbound-message.ts";
import { STATEMENTS_CALIBRATED } from "./questions/summary-statements.ts";
import { JOB_CHANGE_CALIBRATED } from "./questions/sync-job-change.ts";
import { SHAPE_CALIBRATED } from "./questions/widget-shape.ts";
import type { Question } from "./types.ts";

export const CALIBRATED: Record<string, { question: Question; threshold: number }> = {
  ...Object.fromEntries(
    Object.entries(INTENT_QUESTIONS_BY_KEY).map(([key, question]) => [
      key,
      { question, threshold: INTENT_THRESHOLDS[key.split("/")[1] as IntentQuestionId] },
    ]),
  ),
  ...POLICY_CALIBRATED,
  ...STATEMENTS_CALIBRATED,
  ...OUTBOUND_CALIBRATED,
  ...SHAPE_CALIBRATED,
  ...JOB_CHANGE_CALIBRATED,
  ...MEMORY_WRITE_CALIBRATED,
  ...MEMORY_CONDITION_CALIBRATED,
};
