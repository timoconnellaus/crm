// A large email send (ADR 0345, stage 17 acceptance 8): the server asks for the two-step button or
// the exact phrase, whichever way the approval arrives, under `approvals.phraseThreshold.email`.
import { beforeEach, describe, expect, it } from "vitest";
import {
  type ActingUser,
  type CoreOutput,
  devJudge,
  type IntegrationRuntime,
  invokeByName,
  type PendingApprovalError,
  submitOutbound,
} from "../src/index.ts";
import { context, createUser, db, setPreset, unique } from "./helpers.ts";

let person: ActingUser;
let applied: number[];
let connectionId: string;

const runtime = (): IntegrationRuntime =>
  ({
    applyOutbound: async (input: { action: number }) => {
      applied.push(input.action);
    },
    rejectOutbound: async () => undefined,
  }) as unknown as IntegrationRuntime;

let nextAction = 0;
async function send(recipients: string): Promise<string> {
  nextAction += 1;
  const out = await submitOutbound(db, {
    connectionId,
    connectionTitle: "Company mail",
    vendor: "email-send",
    facetKey: `f${nextAction}`,
    resourceTitle: "crm@example.com",
    action: nextAction,
    description: {
      title: "Send the Q3 update",
      description: "Hello",
      fields: [
        { label: "Recipients", value: recipients },
        { label: "Audience", value: "Q3 leads" },
      ],
      actionKind: { tag: "email.send", label: "Send email" },
    },
    actor: "assistant",
    user: person,
    origin: { surface: "assistant", sessionId: unique("ath") },
    reason: "The person asked",
  });
  if (out.decision !== "review") throw new Error("expected a review");
  return (out.pending as PendingApprovalError["pending"]).actionId;
}

const asPerson = () => ({ ...context(person), integrations: runtime() });

/** The way the assistant calls it: the words come from the turn, never the model. */
const inChat = (text: string, via = "text") => ({
  ...asPerson(),
  actor: "assistant" as const,
  judge: devJudge,
  assistantTurn: { threadId: "ath_1", messageSeq: 1, text, via },
});

const decide = (actionId: string, ctx: ReturnType<typeof inChat>) =>
  invokeByName(
    "approval.decide",
    { actionIds: [actionId], decision: "approve" },
    ctx,
  ) as Promise<CoreOutput<"approval.decide">>;

beforeEach(async () => {
  person = await createUser("member");
  applied = [];
  connectionId = `con_${unique("c").toUpperCase()}`;
  await setPreset("balanced");
});

describe("a 240-recipient send", () => {
  it("is refused one press, and takes the two-step button's words", async () => {
    const id = await send("240");
    await expect(
      invokeByName("approval.approve", { actionIds: [id] }, asPerson()),
    ).rejects.toMatchObject({
      code: "second_step_required",
      details: {
        label: "Send 240 emails",
        confirmLabel: "Confirm: send 240 emails",
        phrase: "I approve sending 240 emails to Q3 leads",
      },
    });
    await expect(
      invokeByName("approval.approve", { actionIds: [id], confirm: "Confirm" }, asPerson()),
    ).rejects.toMatchObject({ code: "second_step_required" });
    expect(applied).toEqual([]);
    const out = (await invokeByName(
      "approval.decide",
      { actionIds: [id], decision: "approve", via: "tap", confirm: "Confirm: send 240 emails" },
      asPerson(),
    )) as CoreOutput<"approval.decide">;
    expect(out.status).toBe("decided");
    expect(applied).toHaveLength(1);
  });

  it("shows the step on the action, by the server's rule", async () => {
    const id = await send("240");
    const out = (await invokeByName(
      "approval.status",
      { actionId: id },
      asPerson(),
    )) as CoreOutput<"approval.status">;
    expect(out.changeSets[0]?.actions[0]?.secondStep?.label).toBe("Send 240 emails");
  });

  it("takes the exact phrase, typed, and tolerates 'Q 3'", async () => {
    const id = await send("240");
    const out = await decide(id, inChat("I approve sending 240 emails to Q 3 leads"));
    expect(out.status).toBe("decided");
    expect(applied).toHaveLength(1);
  });

  it("refuses a plain yes and a wrong number, and gives the phrase", async () => {
    const id = await send("240");
    expect(await decide(id, inChat("yes do it"))).toMatchObject({
      status: "asked",
      reason: "phrase",
      phrase: "I approve sending 240 emails to Q3 leads",
    });
    expect(await decide(id, inChat("I approve sending 24 emails to Q3 leads"))).toMatchObject({
      status: "asked",
      reason: "phrase",
    });
    expect(applied).toEqual([]);
  });

  it("cannot be pressed by a model: its `confirm` counts for nothing", async () => {
    const id = await send("240");
    const out = (await invokeByName(
      "approval.decide",
      { actionIds: [id], decision: "approve", confirm: "Confirm: send 240 emails" },
      inChat("yes do it"),
    )) as CoreOutput<"approval.decide">;
    expect(out).toMatchObject({ status: "asked", reason: "phrase" });
    expect(applied).toEqual([]);
  });

  it("is not an approval from an agent or another assistant", async () => {
    const id = await send("240");
    await expect(
      decide(id, inChat("I approve sending 240 emails to Q3 leads", "agent")),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      decide(id, inChat("I approve sending 240 emails to Q3 leads", "connected")),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("follows the setting: 25 stays one tap, and an admin can raise the bar", async () => {
    const small = await send("25");
    expect(
      (await invokeByName("approval.approve", { actionIds: [small] }, asPerson())) as object,
    ).toBeTruthy();
    const admin = await createUser("admin");
    await invokeByName("approval.updateSettings", { phraseThresholdEmail: 300 }, context(admin));
    try {
      const big = await send("240");
      await invokeByName("approval.approve", { actionIds: [big] }, asPerson());
      expect(applied).toHaveLength(2);
    } finally {
      await invokeByName("approval.updateSettings", { phraseThresholdEmail: 25 }, context(admin));
    }
  });

  it("the setting is for human admins", async () => {
    await expect(
      invokeByName("approval.updateSettings", { phraseThresholdEmail: 300 }, context(person)),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
