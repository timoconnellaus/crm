// Every judge question ships calibrated (ADR 0231): each question a placement asks has a record in
// calibration.json for its current wording, shape and model, with the threshold the code uses. A
// reworded question has no record until `pnpm eval:calibrate` runs it against its labelled set, so
// this test fails until the new recordings and record are committed with it.
import { describe, expect, it } from "vitest";
import {
  CALIBRATED,
  CALIBRATION,
  type ChoiceQuestion,
  calibrationFor,
  choice,
  JEV_MODEL,
  POLICY_TEMPLATE_RULES,
  policyQuestions,
  questionHash,
} from "../src/index.ts";

/** Fewest cases a question's labelled set may have (docs/jev.md, "Thresholds and calibration"). */
const MIN_CASES: Record<string, number> = {
  "summary.statements/statement": 40,
  "outbound.message/part": 30,
  "outbound.message/recipients": 10,
  "adjudicator.policy/breaks": 30,
  "adjudicator.policy/allowed_by": 30,
};
const minCases = (key: string) => MIN_CASES[key] ?? (key.startsWith("widget.shape/") ? 24 : 25);

describe("calibration records", () => {
  it.each(Object.keys(CALIBRATED))(
    "%s has a record for its current wording and threshold",
    async (key) => {
      const entry = CALIBRATED[key] as (typeof CALIBRATED)[string];
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
    const [key, entry] = Object.entries(CALIBRATED)[0] as [string, (typeof CALIBRATED)[string]];
    const question = entry.question as ChoiceQuestion;
    const reworded = choice(`${String(question.instructions)} Be strict.`, question.criteria);
    expect(await calibrationFor(key, reworded)).toBeNull();
    // A new model is a new calibration too.
    const record = CALIBRATION.questions[key];
    expect(record?.hash).not.toBe(await questionHash(entry.question, "jev-9.9.9"));
  });

  it("the policy questions are kept under their template, whatever the policy's rules", async () => {
    const template = policyQuestions(POLICY_TEMPLATE_RULES);
    expect(await calibrationFor("adjudicator.policy/breaks", template.breaks)).not.toBeNull();
    // A way out reworded is a new question.
    const reworded = choice(template.allowed_by.instructions, {
      ...template.allowed_by.criteria,
      none_allows: "Nothing allows it",
    });
    expect(await calibrationFor("adjudicator.policy/allowed_by", reworded)).toBeNull();
  });

  it("holds no record for a question nobody asks", () => {
    expect(Object.keys(CALIBRATION.questions).sort()).toEqual(Object.keys(CALIBRATED).sort());
  });
});
