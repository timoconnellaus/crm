// Every judge question ships calibrated (ADR 0231): each question a placement asks has a record in
// calibration.json for its current wording, shape and model, with the threshold the code uses. A
// reworded question has no record until `pnpm eval:calibrate` runs it against its labelled set, so
// this test fails until the new recordings and record are committed with it.
import { describe, expect, it } from "vitest";
import {
  CALIBRATED_QUESTIONS,
  CALIBRATION,
  calibrationFor,
  choice,
  INTENT_THRESHOLDS,
  type IntentQuestionId,
  JEV_MODEL,
  OUTBOUND_CALIBRATED,
  questionHash,
  SHAPE_CALIBRATED,
  STATEMENTS_CALIBRATED,
} from "../src/index.ts";

/** Every calibrated question of every built placement, by calibration key. */
const ALL: Record<string, { question: Parameters<typeof questionHash>[0]; threshold: number }> = {
  ...Object.fromEntries(
    Object.entries(CALIBRATED_QUESTIONS).map(([key, question]) => [
      key,
      {
        question,
        threshold: INTENT_THRESHOLDS[key.split("/")[1] as IntentQuestionId],
      },
    ]),
  ),
  ...STATEMENTS_CALIBRATED,
  ...OUTBOUND_CALIBRATED,
  ...SHAPE_CALIBRATED,
};

/** Fewest cases a question's labelled set may have (docs/jev.md, "Thresholds and calibration"). */
const MIN_CASES: Record<string, number> = {
  "summary.statements/statement": 40,
  "outbound.message/part": 30,
  "outbound.message/recipients": 10,
};
const minCases = (key: string) => MIN_CASES[key] ?? (key.startsWith("widget.shape/") ? 24 : 25);

describe("calibration records", () => {
  it.each(Object.keys(ALL))(
    "%s has a record for its current wording and threshold",
    async (key) => {
      const entry = ALL[key] as (typeof ALL)[string];
      const record = await calibrationFor(key, entry.question);
      expect(
        record,
        `${key} was reworded or never calibrated: run pnpm eval:calibrate`,
      ).not.toBeNull();
      expect(record?.model).toBe(JEV_MODEL);
      expect(record?.threshold).toBe(entry.threshold);
      expect(record?.wrong).toBe(0);
      expect(record?.unanswered).toBe(0);
      expect(record?.cases).toBeGreaterThanOrEqual(minCases(key));
    },
  );

  it("a reworded question has no record", async () => {
    const [key, question] = Object.entries(CALIBRATED_QUESTIONS)[0] as [
      string,
      (typeof CALIBRATED_QUESTIONS)[string],
    ];
    const reworded = choice(`${String(question.instructions)} Be strict.`, question.criteria);
    expect(await calibrationFor(key, reworded)).toBeNull();
    // A new model is a new calibration too.
    const record = CALIBRATION.questions[key];
    expect(record?.hash).not.toBe(await questionHash(question, "jev-9.9.9"));
  });

  it("holds no record for a question nobody asks", () => {
    expect(Object.keys(CALIBRATION.questions).sort()).toEqual(Object.keys(ALL).sort());
  });
});
