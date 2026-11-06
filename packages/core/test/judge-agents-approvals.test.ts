// Stage 17 W5's placements: `approval.intent`, `grant.leastPrivilege` and `orchestrator.suggest`.
// What each ask does with an answer and with no answer, what goes in the state, and the plain
// rules of the dev stand-in that e2e and workerd tests rely on. The questions themselves are
// tested by their labelled sets (evals/judge).
import { describe, expect, it } from "vitest";
import {
  APPROVAL_INTENT_THRESHOLD,
  APPROVAL_OTHERS_MAX,
  APPROVAL_PHRASE_THRESHOLD,
  approvalIntentState,
  approvalPhraseState,
  askApprovalIntent,
  askApprovalPhrase,
  askGrant,
  askOrchestrator,
  choiceAnswer,
  devJudge,
  fakeJudge,
  GRANT_THRESHOLD,
  grantState,
  ORCHESTRATOR_THRESHOLD,
  orchestratorState,
  placementInfo,
  unavailableJudge,
} from "../src/index.ts";

const INTENT = ["approves_this", "ambiguous", "hedged", "declines", "unrelated"] as const;
const PHRASE = ["same_phrase", "different", "not_a_phrase"] as const;
const GRANT = ["fits", "too_wide", "unclear"] as const;
const SIZE = ["single_lookup", "short_work", "long_work", "unclear"] as const;

const intent = (said: string, others: string[] = [], item = "Update Acme's stage") =>
  approvalIntentState({ said, lastReply: "Shall I go ahead?", item, others });

describe("the placements", () => {
  it("fail as the spec says", () => {
    expect(placementInfo("approval.intent")).toMatchObject({
      failMode: "closed",
      sendsRecordContent: true,
      defaultOn: true,
      spendCounted: true,
    });
    expect(placementInfo("grant.leastPrivilege")).toMatchObject({
      failMode: "closed",
      sendsRecordContent: false,
      spendCounted: true,
    });
    expect(placementInfo("orchestrator.suggest")).toMatchObject({
      failMode: "open",
      sendsRecordContent: false,
      spendCounted: false,
      timeoutMs: 1_500,
    });
  });
});

describe("approval.intent", () => {
  it("approves at the threshold, and names the likeliest label below it", async () => {
    const at = fakeJudge({
      intent: choiceAnswer(INTENT, {
        approves_this: APPROVAL_INTENT_THRESHOLD,
        ambiguous: 1 - APPROVAL_INTENT_THRESHOLD,
      }),
    });
    expect(await askApprovalIntent(at, intent("yes"))).toMatchObject({
      status: "answered",
      approves: true,
      label: "approves_this",
    });
    const below = fakeJudge({
      intent: choiceAnswer(INTENT, { approves_this: 0.4, hedged: 0.6 }),
    });
    expect(await askApprovalIntent(below, intent("maybe"))).toMatchObject({
      approves: false,
      label: "hedged",
    });
  });

  it("the phrase holds to its own, higher threshold, in its own call", async () => {
    expect(APPROVAL_PHRASE_THRESHOLD).toBeGreaterThan(APPROVAL_INTENT_THRESHOLD);
    const judge = fakeJudge({
      phrase: choiceAnswer(PHRASE, { same_phrase: APPROVAL_INTENT_THRESHOLD, different: 0.3 }),
    });
    const state = approvalPhraseState({ said: "I approve", phrase: "I approve sending 240" });
    expect(await askApprovalPhrase(judge, state)).toMatchObject({ matches: false });
    expect(Object.keys(judge.calls[0]?.questions ?? {})).toEqual(["phrase"]);
  });

  it("no answer is a failure, never a yes", async () => {
    const judge = unavailableJudge("timeout");
    expect(await askApprovalIntent(judge, intent("yes"))).toEqual({
      status: "failed",
      reason: "timeout",
    });
    expect(await askApprovalPhrase(judge, approvalPhraseState({ said: "x", phrase: "y" }))).toEqual(
      { status: "failed", reason: "timeout" },
    );
  });

  it("clips what it sends", () => {
    const state = approvalIntentState({
      said: `  yes\n${"a".repeat(2_000)}`,
      lastReply: "b".repeat(5_000),
      item: "c".repeat(1_000),
      others: Array.from({ length: 30 }, (_, i) => `Item ${i}`),
    });
    expect(state.said.startsWith("yes a")).toBe(true);
    expect(state.said.length).toBe(500);
    expect(state.lastReply.length).toBe(1_000);
    expect(state.item.length).toBe(300);
    expect(state.others).toHaveLength(APPROVAL_OTHERS_MAX);
  });
});

describe("grant.leastPrivilege", () => {
  const grant = (input: { justification?: string } = {}) =>
    grantState({
      brief: "Research 20 accounts",
      profile: "researcher",
      operations: [{ name: "organisation.get", does: "Read an organisation" }],
      target: "20 organisations",
      caps: "20 updates",
      expiry: "24 hours",
      ...input,
    });

  it("fits at the threshold; a reason goes in the state only when there is one", async () => {
    const judge = fakeJudge({
      grant: choiceAnswer(GRANT, { fits: GRANT_THRESHOLD, too_wide: 1 - GRANT_THRESHOLD }),
    });
    expect(await askGrant(judge, grant())).toMatchObject({ fits: true, label: "fits" });
    expect("justification" in grant()).toBe(false);
    expect(grant({ justification: "Because" }).justification).toBe("Because");
  });

  it("no answer is a failure, so the person confirms", async () => {
    expect(await askGrant(unavailableJudge("no-credit"), grant())).toEqual({
      status: "failed",
      reason: "no-credit",
    });
  });
});

describe("orchestrator.suggest", () => {
  it("hints at the threshold; a selection goes in the state only when there is one", async () => {
    const judge = fakeJudge({
      size: choiceAnswer(SIZE, {
        long_work: ORCHESTRATOR_THRESHOLD,
        short_work: 1 - ORCHESTRATOR_THRESHOLD,
      }),
    });
    expect(await askOrchestrator(judge, orchestratorState({ said: "x" }))).toMatchObject({
      status: "answered",
      longWork: true,
    });
    expect(orchestratorState({ said: "x", selected: 0 })).toEqual({ said: "x" });
    expect(orchestratorState({ said: "x", selected: 12 })).toEqual({ said: "x", selected: 12 });
  });

  it("no answer is a failure, and the caller adds no hint", async () => {
    expect(
      await askOrchestrator(unavailableJudge("timeout"), orchestratorState({ said: "x" })),
    ).toEqual({ status: "failed", reason: "timeout" });
  });
});

describe("the dev stand-in", () => {
  it.each([
    ["yes", [], "approves_this"],
    ["yeah do it", [], "approves_this"],
    ["go ahead", [], "approves_this"],
    ["approve", [], "approves_this"],
    ["yes", ["Send the email"], "ambiguous"],
    ["yes, the Acme one", ["Send the email"], "approves_this"],
    ["maybe after lunch", [], "hedged"],
    ["later", [], "hedged"],
    ["not sure", [], "hedged"],
    ["can you show me?", [], "hedged"],
    ["no", [], "declines"],
    ["don't", [], "declines"],
    ["stop", [], "declines"],
    ["what's for lunch", [], "unrelated"],
  ] as const)("reads %j with others %j as %s", async (said, others, label) => {
    expect(await askApprovalIntent(devJudge, intent(said, [...others]))).toMatchObject({ label });
  });

  it.each([
    ["I approve sending 240 emails to Q3 leads", true],
    ["i approve sending 240 emails to q 3 leads.", true],
    ["I approve sending 240 emails to quarter 3 leads", true],
    ["I approve sending 24 emails to Q3 leads", false],
    ["I approve sending 2,400 emails to Q3 leads", false],
    ["sure send them all", false],
  ])("matches %j: %s", async (said, matches) => {
    const state = approvalPhraseState({
      said,
      phrase: "I approve sending 240 emails to Q3 leads",
    });
    expect(await askApprovalPhrase(devJudge, state)).toMatchObject({ matches });
  });

  it.each([
    ["Research 20 accounts", "organisation.get", "20 organisations", "fits"],
    ["Research 20 accounts", "organisation.delete", "20 organisations", "too_wide"],
    ["Research 20 accounts", "email.send", "20 organisations", "too_wide"],
    ["Research 20 accounts", "person.erase", "20 organisations", "too_wide"],
    ["Delete the 20 test accounts", "organisation.delete", "20 organisations", "fits"],
    ["Email the 5 people", "email.send", "5 people", "fits"],
    ["Research 5 accounts", "organisation.get", "every organisation", "too_wide"],
  ])("grants: %s with %s on %s is %s", async (brief, name, target, label) => {
    const state = grantState({
      brief,
      profile: "researcher",
      operations: [{ name, does: "" }],
      target,
      caps: "",
      expiry: "24 hours",
    });
    expect(await askGrant(devJudge, state)).toMatchObject({ label });
  });

  it.each([
    ["research Acme's competitors", true],
    ["update every deal", true],
    ["tag all of these", true],
    ["fix the 20 accounts on my list", true],
    ["check 5 records", true],
    ["look at 3 records", false],
    ["what's Acme's phone number?", false],
  ])("orchestrator: %j is long work: %s", async (said, longWork) => {
    expect(await askOrchestrator(devJudge, orchestratorState({ said }))).toMatchObject({
      longWork,
    });
  });
});
