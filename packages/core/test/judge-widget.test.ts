// Placement `widget.shape` (stage 11 AC 10, ADR 0239): before the build model writes a widget, the
// judge picks the shape from the prompt alone. A confident pick is a hint in the prompt; a widget
// whose type cannot show it goes back to the model once, as a validation error naming the shape;
// the second answer stands. Advice: a failed or switched-off judge changes nothing.
import { describe, expect, it } from "vitest";
import {
  choiceAnswer,
  fakeJudge,
  invoke,
  JUDGE_UNAVAILABLE_REASONS,
  type Judge,
  type ModelRunner,
  offJudge,
  pickOf,
  SHAPE_PLACEMENT,
  SHAPES,
  unavailableJudge,
} from "../src/index.ts";
import { context, createUser } from "./helpers.ts";

const BAR =
  '{"id":"people-months","type":"bar","title":"People this month and last","sql":"SELECT substr(created_at, 1, 7) AS label, COUNT(*) AS value FROM crm_people GROUP BY 1","mapping":{"x":"label","y":"value"}}';
const KPI =
  '{"id":"people-this-month","type":"kpi","title":"People added this month","sql":"SELECT COUNT(*) AS value FROM crm_people","mapping":{"value":"value"}}';
const BROKEN =
  '{"id":"x","type":"kpi","title":"Bad","sql":"SELECT COUNT(*) AS value FROM core_person","mapping":{"value":"value"}}';
const PROMPT = "The number of people added this month, compared with last month.";

function scriptedModel(answers: string[]) {
  const seen: { role: string; content: string }[][] = [];
  const models: ModelRunner = {
    async run(_role, messages) {
      seen.push(messages.map((m) => ({ ...m })));
      return { text: answers.shift() ?? "", model: "test" };
    },
  };
  return { models, seen };
}

const kpiJudge = () => fakeJudge({ shape: choiceAnswer(SHAPES, { kpi: 0.98, categories: 0.02 }) });

async function describeWith(judge: Judge | undefined, answers: string[]) {
  const user = await createUser("member");
  const model = scriptedModel(answers);
  const result = await invoke(
    "widget.describe",
    { prompt: PROMPT },
    context(user, { models: model.models, ...(judge ? { judge } : {}) }),
  );
  return { result, seen: model.seen };
}

describe("widget.shape in widget.describe", () => {
  it("sends a bar chart back once when one number was asked for, naming the shape", async () => {
    const judge = kpiJudge();
    const { result, seen } = await describeWith(judge, [BAR, KPI]);
    expect(result).toMatchObject({ status: "ok", attempts: 2, widget: { type: "kpi" } });
    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0]?.placement).toBe(SHAPE_PLACEMENT);
    // Only the person's prompt goes to the judge.
    expect(judge.calls[0]?.state).toEqual({ prompt: PROMPT });
    // The hint, before generation.
    expect(seen[0]?.at(-1)?.content).toMatch(/The request asks for one number \(a kpi widget/);
    // The retry names the shape asked for and the type given.
    expect(seen[1]?.at(-1)?.content).toMatch(
      /That widget failed: the request asks for one number \(a kpi widget.*but the widget is a bar widget/,
    );
  });

  it("keeps the second answer whatever its type (advice, one retry)", async () => {
    const { result } = await describeWith(kpiJudge(), [BAR, BAR]);
    expect(result).toMatchObject({ status: "ok", attempts: 2, widget: { type: "bar" } });
  });

  it("keeps the first valid widget when the retry is invalid", async () => {
    const { result } = await describeWith(kpiJudge(), [BAR, BROKEN]);
    expect(result).toMatchObject({ status: "ok", attempts: 2, widget: { type: "bar" } });
  });

  it("accepts a widget whose type fits the pick at once", async () => {
    const { result, seen } = await describeWith(kpiJudge(), [KPI]);
    expect(result).toMatchObject({ status: "ok", attempts: 1 });
    expect(seen).toHaveLength(1);
  });

  it("holds nothing to an unclear or unconfident pick", async () => {
    for (const shape of [
      choiceAnswer(SHAPES, "unclear"),
      choiceAnswer(SHAPES, { kpi: 0.3, categories: 0.3, trend: 0.4 - 0.01, rows: 0.01 }),
    ]) {
      const { result, seen } = await describeWith(fakeJudge({ shape }), [BAR]);
      expect(result).toMatchObject({ status: "ok", attempts: 1, widget: { type: "bar" } });
      expect(seen[0]?.at(-1)?.content).toBe(PROMPT);
    }
  });

  it.each([
    ["no judge", undefined],
    ["off", offJudge],
    ...[...JUDGE_UNAVAILABLE_REASONS.filter((r) => r !== "off")].map(
      (r) => [r, unavailableJudge(r)] as [string, Judge],
    ),
    ["a fault", fakeJudge({ status: "fault", httpStatus: 422, detail: "bad" })],
  ])("fails open (%s): the widget is described as before", async (_name, judge) => {
    const { result, seen } = await describeWith(judge, [BAR]);
    expect(result).toMatchObject({ status: "ok", attempts: 1, widget: { type: "bar" } });
    expect(seen[0]?.at(-1)?.content).toBe(PROMPT);
  });

  it("picks only at or above the threshold, never the way out", () => {
    expect(pickOf({ kpi: 0.9, unclear: 0.1 })).toBe("kpi");
    expect(pickOf({ unclear: 0.9, kpi: 0.1 })).toBeNull();
    expect(pickOf({ kpi: 0.35, categories: 0.35, unclear: 0.3 })).toBeNull();
  });
});
