// The graders on their own: test-mode reports against expectations, summary keywords, and the LLM
// judge (with a scripted model).
import { reply, scriptedModel } from "@crm/evals-mcp/test/fakes.ts";
import { describe, expect, it } from "vitest";
import {
  gradeTest,
  judgeSummary,
  keywordFailures,
  outcomeOf,
  parseTestReport,
  parseVerdict,
} from "../lib/grading.ts";
import { type AutomationCase, cases } from "../prompts.ts";
import { expectedReport, USER_ID } from "./fake-crm.ts";

const byId = (id: string): AutomationCase => {
  const c = cases.find((x) => x.id === id);
  if (!c) throw new Error(id);
  return c;
};
const kickoff = byId("new-deal-kickoff");

describe("parseTestReport", () => {
  it("reads automation.test's { report } and a bare report; refuses anything else", () => {
    const report = expectedReport(kickoff);
    expect(parseTestReport({ report })?.writes).toHaveLength(2);
    expect(parseTestReport(report)?.matched).toBe(true);
    expect(parseTestReport({ report: { ok: true } })).toBeNull();
    expect(parseTestReport(null)).toBeNull();
    expect(
      parseTestReport({
        report: { matched: false, ok: false, error: { code: "x", message: "y" } },
      }),
    ).toEqual({
      matched: false,
      ok: false,
      steps: [],
      writes: [],
      notifications: [],
      error: { code: "x", message: "y" },
    });
  });

  it("condenses writes by object, notifications and waits", () => {
    const report = parseTestReport({ report: expectedReport(kickoff) });
    if (!report) throw new Error("no report");
    expect(outcomeOf(report)).toEqual({
      matched: true,
      writes: { task: 2 },
      notifications: 1,
      waits: 1,
    });
  });
});

describe("gradeTest", () => {
  it("passes the expected output", () => {
    for (const c of cases) {
      const report = parseTestReport(expectedReport(c));
      if (!report) throw new Error("no report");
      expect(gradeTest(c, report, USER_ID), c.id).toEqual([]);
    }
  });

  it("names every difference", () => {
    const report = parseTestReport({
      ...expectedReport(kickoff),
      matched: false,
      matchReason: "stage is not won",
      ok: false,
      error: { code: "forbidden", message: "may not write task" },
      writes: [
        { object: "task", action: "create" },
        { object: "person", action: "update" },
      ],
      notifications: [
        { to: ["usr_other"], title: "x" },
        { to: [], title: "y" },
      ],
      steps: [],
    });
    if (!report) throw new Error("no report");
    expect(gradeTest(kickoff, report, USER_ID)).toEqual([
      "the test run failed: forbidden: may not write task",
      "the trigger did not match the seeded record (stage is not won)",
      "expected 0 person write(s), the test run had 1",
      "expected 2 task write(s), the test run had 1",
      "expected 1 notification(s), the test run had 2",
      "the notification should reach the record's owner (the eval user usr_eval); it went to usr_other; nobody",
      "expected 1 wait(s), the test run had 0",
    ]);
  });

  it("skips the recipient check without a user id", () => {
    const report = parseTestReport({
      ...expectedReport(kickoff),
      notifications: [{ to: ["usr_other"], title: "x" }],
    });
    if (!report) throw new Error("no report");
    expect(gradeTest(kickoff, report, null)).toEqual([]);
  });
});

describe("keywordFailures", () => {
  it("needs one match per group", () => {
    const c = byId("org-check-in");
    expect(
      keywordFailures(c, "When an Organisation is created, after 2 days it creates a task."),
    ).toEqual([]);
    expect(keywordFailures(c, "When an organisation is created, it creates a task.")).toEqual([
      "the summary does not mention \\b(2|two) days\\b",
    ]);
  });

  it("accepts the reference design's wording for the won-deal case", () => {
    const c = byId("won-thank-you");
    const summary =
      "When a Deal's stage changes to a won stage, it creates 1 task for the deal's owner and notifies them.";
    expect(keywordFailures(c, summary)).toEqual([]);
  });
});

describe("the judge", () => {
  it("parses verdicts, tolerating prose around the JSON", () => {
    expect(parseVerdict('Sure: {"verdict": "PASS", "reason": "ok"}')).toEqual({
      pass: true,
      reason: "ok",
    });
    expect(parseVerdict('{"verdict": "fail", "reason": "no wait"}')?.pass).toBe(false);
    expect(parseVerdict('{"verdict": "maybe"}')).toBeNull();
    expect(parseVerdict("no json")).toBeNull();
  });

  it("asks once with the rubric, the request and the summary, at temperature 0", async () => {
    const c = byId("weekly-digest");
    const script = scriptedModel([reply('{"verdict":"pass","reason":"matches"}')]);
    const verdict = await judgeSummary(script.model, "@cf/judge", c, "Every Monday at 9:00 …");
    expect(verdict).toEqual({ pass: true, reason: "matches" });
    const [request] = script.requests;
    expect(request?.model).toBe("@cf/judge");
    expect(request?.temperature).toBe(0);
    expect(request?.tools).toBeUndefined();
    expect(request?.messages[0]?.content).toMatch(/Answer with JSON only/);
    expect(request?.messages[1]?.content).toContain(c.request);
    expect(request?.messages[1]?.content).toContain("Every Monday at 9:00 …");
  });

  it("retries an unparseable reply once, then fails", async () => {
    const c = byId("weekly-digest");
    const retried = scriptedModel([reply("hmm"), reply('{"verdict":"fail","reason":"no"}')]);
    expect(await judgeSummary(retried.model, "m", c, "s")).toEqual({ pass: false, reason: "no" });
    const garbled = scriptedModel([reply("hmm"), reply("still hmm")]);
    const verdict = await judgeSummary(garbled.model, "m", c, "s");
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toMatch(/no verdict: still hmm/);
  });
});
