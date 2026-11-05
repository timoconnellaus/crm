// The whole eval flow against the in-memory deployment: seed before authoring, author with the
// reference model (or a scripted one), approve, then grade check, install, trigger, test mode and
// summary; and each way a case can fail.
import { reply, scriptedModel, toolCall } from "@relationship-os/evals-mcp/test/fakes.ts";
import { describe, expect, it } from "vitest";
import { type AutomationsHarnessDeps, runEval } from "../lib/harness.ts";
import { referenceModel } from "../lib/reference.ts";
import { type AutomationCase, cases } from "../prompts.ts";
import { EMAIL, expectedReport, type FakeBehaviour, fakeCrm, USER_ID } from "./fake-crm.ts";

const byId = (id: string): AutomationCase => {
  const c = cases.find((x) => x.id === id);
  if (!c) throw new Error(id);
  return c;
};

function setup(behaviour: FakeBehaviour = {}, model = referenceModel(cases)) {
  const crm = fakeCrm(behaviour);
  const deps: AutomationsHarnessDeps = {
    openSession: crm.openSession,
    model,
    modelId: "@cf/test/model",
    maxTurns: 10,
    userEmail: EMAIL,
    today: "2026-11-05",
    suffix: () => "Varodin",
    installTimeoutMs: 0,
    pollMs: 0,
    sleep: async () => {},
  };
  return { crm, deps };
}

describe("runEval", () => {
  it("passes all 10 reference answers once approved", async () => {
    const { crm, deps } = setup();
    let seededBeforeApproval = 0;
    const results = await runEval(cases, deps, async (authored) => {
      expect(authored.map((a) => a.proposal?.extensionId)).toEqual(
        cases.map((c) => `${c.idBase}varodin`),
      );
      seededBeforeApproval = crm.records.length;
      crm.approveAll();
    });
    expect(results.map((r) => [r.id, r.failures])).toEqual(cases.map((c) => [c.id, []]));
    expect(results.every((r) => r.passed)).toBe(true);

    // Every case with a seed got its record before any automation existed.
    expect(seededBeforeApproval).toBe(cases.filter((c) => c.seed).length);
    const deal = crm.records.find((r) => r.values.name === "Eval won deal varodin");
    expect(deal?.values).toMatchObject({
      owner: USER_ID,
      pipeline: "pip_newBusiness",
      stage: "stg_nbWon",
      value: 12000,
    });
    const closing = crm.records.find((r) => r.values.name === "Eval closing deal varodin");
    expect(closing?.values.expectedClose).toBe("2026-11-12");

    // Test mode ran on the seeded record (none for schedule / approval cases).
    const won = results.find((r) => r.id === "won-thank-you");
    expect(crm.tests).toContainEqual({ id: won?.automationId, record: won?.seeded });
    const weekly = results.find((r) => r.id === "weekly-digest");
    expect(weekly?.seeded).toBeNull();
    expect(crm.tests).toContainEqual({ id: weekly?.automationId });

    // The results carry what the report shows, and every automation was disabled afterwards.
    expect(won).toMatchObject({
      extensionId: "wonthanksvarodin",
      automationId: "wonthanksvarodin.auto",
      triggerType: "fieldChanged",
      check: { ok: true, issues: [] },
      test: { matched: true, writes: { task: 1 }, notifications: 1, waits: 0 },
      summary: byId("won-thank-you").intent,
      judge: { pass: true },
      counts: { writes: 1, checks: 1, proposes: 1, toolCalls: 3 },
    });
    expect(crm.disabled.size).toBe(10);
  });

  // Regression: on a seeded database the first open stage by position was Renewals' "Upcoming
  // renewal", which requires an organisation, so the deal fixtures failed before the model ran.
  const dealCases = ["close-date-reminder", "big-deal-alert", "new-deal-kickoff"].map(byId);
  const approve = (crm: ReturnType<typeof fakeCrm>) => async () => crm.approveAll();

  it("seeds deals in the default pipeline's first open stage on a seeded database", async () => {
    const { crm, deps } = setup();
    const results = await runEval(dealCases, deps, approve(crm));
    expect(results.map((r) => [r.id, r.failures])).toEqual(dealCases.map((c) => [c.id, []]));
    const deals = crm.records.filter((r) => String(r.values.name).startsWith("Eval "));
    expect(deals.map((d) => [d.values.pipeline, d.values.stage])).toEqual(
      dealCases.map(() => ["pip_newBusiness", "stg_nbLead"]),
    );
    expect(crm.records.filter((r) => r.object === "organisation")).toEqual([]);
  });

  it("fills the stage's required fields when the only pipeline's first stage has rules", async () => {
    const { crm, deps } = setup({
      pipelines: [
        {
          id: "pip_renewals",
          name: "Renewals",
          position: 1,
          stages: [
            {
              id: "stg_upcoming",
              position: 1,
              type: "open",
              requiredFields: ["organisation", "value", "expectedClose"],
            },
          ],
        },
      ],
    });
    const results = await runEval(dealCases, deps, approve(crm));
    expect(results.map((r) => [r.id, r.failures])).toEqual(dealCases.map((c) => [c.id, []]));

    // One eval organisation, suffixed like the other fixtures, shared by the run's deals.
    const orgs = crm.records.filter((r) => r.object === "organisation");
    expect(orgs.map((o) => o.values.name)).toEqual(["Eval Deals Ltd varodin"]);
    const deals = crm.records.filter((r) => r.object === "deals.deal");
    expect(deals).toHaveLength(3);
    for (const deal of deals) {
      expect(deal.values).toMatchObject({
        pipeline: "pip_renewals",
        stage: "stg_upcoming",
        organisation: orgs[0]?.id,
      });
    }
    // The case's own values win; empty required ones are filled.
    const big = deals.find((d) => d.values.name === "Eval big deal varodin");
    expect(big?.values).toMatchObject({ value: 100000, expectedClose: "2026-12-05" });
    const closing = deals.find((d) => d.values.name === "Eval closing deal varodin");
    expect(closing?.values.expectedClose).toBe("2026-11-12");
  });

  it("fails cases whose proposal was never approved", async () => {
    const { deps } = setup();
    const [result] = await runEval([byId("weekly-digest")], deps);
    expect(result?.passed).toBe(false);
    expect(result?.failures).toEqual([
      {
        kind: "install",
        message:
          "no automation of weeklyvarodin was installed in time: approve the proposal (change set chs_weeklyvarodin) in the Approvals inbox",
      },
    ]);
  });

  it("fails on wrong test-mode output, trigger type and summary", async () => {
    const c = byId("org-check-in");
    const { crm, deps } = setup({
      report: (x) => ({ ...expectedReport(x), steps: [] }),
      triggerType: () => "schedule",
      summary: () => "When an organisation is created, it creates a task.",
    });
    const [result] = await runEval([c], deps, async () => crm.approveAll());
    expect(result?.failures.map((f) => [f.kind, f.message])).toEqual([
      ["trigger", "trigger type schedule; the request needs record"],
      ["test", "expected 1 wait(s), the test run had 0"],
      ["summary", "the summary does not mention \\b(2|two) days\\b"],
    ]);
    // The judge (the reference model) still passed it; the keyword check caught the missing wait.
    expect(result?.judge).toEqual({ pass: true, reason: "reference answer" });
  });

  it("fails a summary the judge rejects", async () => {
    const c = byId("rejected-change");
    const script = scriptedModel([
      reply(null, [
        toolCall("extension_write", { id: "rejectedvarodin", files: { "index.ts": "ok" } }),
      ]),
      reply(null, [toolCall("extension_propose", { id: "rejectedvarodin", reason: "x" })]),
      reply("Done."),
      reply('{"verdict":"fail","reason":"it notifies the owner, not the admins"}'),
    ]);
    const { crm, deps } = setup({}, script.model);
    const [result] = await runEval([c], deps, async () => crm.approveAll());
    expect(result?.failures).toEqual([
      { kind: "summary", message: "the judge: it notifies the owner, not the admins" },
    ]);
  });

  it("asks the judge model, and reports an unreachable judge as an error with its cause", async () => {
    const c = byId("rejected-change");
    const authoring = [
      reply(null, [
        toolCall("extension_write", { id: "rejectedvarodin", files: { "index.ts": "ok" } }),
      ]),
      reply(null, [toolCall("extension_propose", { id: "rejectedvarodin", reason: "x" })]),
      reply("Done."),
    ];
    const judged = scriptedModel([...authoring, reply('{"verdict":"pass","reason":"ok"}')]);
    const first = setup({}, judged.model);
    const [passed] = await runEval([c], { ...first.deps, judgeModelId: "judge-model" }, async () =>
      first.crm.approveAll(),
    );
    expect(passed?.judge).toEqual({ pass: true, reason: "ok" });
    expect(judged.requests.at(-1)?.model).toBe("judge-model");
    expect(judged.requests.at(0)?.model).toBe("@cf/test/model");

    const script = scriptedModel(authoring);
    const offline = {
      async createCompletion(request: Parameters<typeof script.model.createCompletion>[0]) {
        if (request.tools) return script.model.createCompletion(request);
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.example.test"), {
            code: "ENOTFOUND",
          }),
        });
      },
    };
    const second = setup({}, offline);
    const [result] = await runEval([c], second.deps, async () => second.crm.approveAll());
    expect(result?.failures).toEqual([
      {
        kind: "error",
        message: "the judge failed: fetch failed, caused by getaddrinfo ENOTFOUND api.example.test",
      },
    ]);
    // Grading went on past the judge: the automation was still disabled.
    expect(result?.notes).toEqual([]);
    expect(result?.test).not.toBeNull();
  });

  it("fails when the model never proposes, or its working copy fails check", async () => {
    const c = byId("weekly-digest");
    const never = scriptedModel([reply("I would rather not.")]);
    const first = await runEval([c], setup({}, never.model).deps);
    expect(first[0]?.failures).toEqual([
      { kind: "propose", message: "the model never called extension_propose" },
    ]);

    const broken = scriptedModel([
      reply(null, [
        toolCall("extension_write", { id: "weeklyvarodin", files: { "index.ts": "BROKEN" } }),
      ]),
      reply(null, [toolCall("extension_propose", { id: "weeklyvarodin" })]),
      reply("It fails check."),
    ]);
    const second = await runEval([c], setup({}, broken.model).deps);
    expect(second[0]?.failures[0]?.kind).toBe("propose");
    expect(second[0]?.issuesSeen).toEqual([
      {
        stage: "contract",
        code: "contract",
        message: "broken",
        turn: 2,
        tool: "extension_propose",
      },
    ]);
  });
});
