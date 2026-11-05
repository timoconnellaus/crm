// Placement `outbound.message` (stage 11 AC 8, ADR 0238): a message an AI actor wrote is checked
// before it leaves. A finding turns an automatic send into a review, with the findings on the
// pending action for its approver; a judge that cannot answer does the same (fails closed); off
// changes nothing. A person's own message and notification delivery are never checked. The
// recipients are checked only against a person's own words, passed by code.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type ActingUser,
  type Actor,
  auditOutboundApplied,
  choiceAnswer,
  type FakeJudgeCall,
  fakeJudge,
  invoke,
  invokeByName,
  JUDGE_UNAVAILABLE_REASONS,
  type Judge,
  messageOf,
  NOTHING_ASKED,
  OUTBOUND_PLACEMENT,
  type OutboundState,
  type OutboundSubmission,
  offJudge,
  submitOutbound,
  unavailableJudge,
} from "../src/index.ts";
import { context, createUser, db, setPreset, unique } from "./helpers.ts";

const PART_LABELS = ["fine", "promises", "unsupported", "not_a_claim"] as const;
const RECIPIENT_LABELS = ["as_asked", "someone_else", "not_said"] as const;

let admin: ActingUser;
let member: ActingUser;
let connectionId: string;
let email: string;
let personId: string;

/** Marks any sentence with "discount" as a promise, and recipients as asked. */
function scripted(options: { recipients?: (typeof RECIPIENT_LABELS)[number] } = {}) {
  return fakeJudge((call: FakeJudgeCall) => {
    const state = call.state as unknown as OutboundState;
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(call.questions)) {
      if (id === "recipients") {
        answers[id] = choiceAnswer(RECIPIENT_LABELS, options.recipients ?? "as_asked");
        continue;
      }
      const text = id === "subject" ? state.message.subject : state.message.body[id];
      answers[id] = choiceAnswer(PART_LABELS, /discount/i.test(text ?? "") ? "promises" : "fine");
    }
    return answers;
  });
}

function submission(
  action: number,
  body: string,
  overrides: Partial<OutboundSubmission> = {},
): OutboundSubmission {
  return {
    connectionId,
    connectionTitle: "Company mail",
    vendor: "email-send",
    facetKey: "f1",
    resourceTitle: "crm@example.com",
    action,
    description: {
      title: "Send email: Renewal",
      description: "Sends an email from the sender address to 1 recipient.",
      fields: [
        { label: "From", value: "crm@example.com" },
        { label: "To", items: [email] },
        { label: "Subject", value: "Your renewal" },
        { label: "Body", value: body },
      ],
      implementsRevert: false,
      autoApprovable: false,
      actionKind: { tag: "email.send", label: "Send email" },
    },
    actor: "mcp",
    user: member,
    origin: { surface: "mcp", sessionId: `cap_${unique("s")}`, clientName: "Claude" },
    reason: "Follow up",
    ...overrides,
  };
}

async function check(actionId: string) {
  const row = await env.DB.prepare("SELECT outbound_check FROM core_pending_action WHERE id = ?")
    .bind(actionId)
    .first<{ outbound_check: string | null }>();
  return JSON.parse(row?.outbound_check ?? "null");
}

beforeEach(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  connectionId = `con_${unique("c").toUpperCase()}`;
  email = `${unique("sam")}@acme.example`;
  const person = await invoke(
    "person.create",
    { displayName: "Sam Lee", location: "Brisbane", emails: [{ email }] },
    context(member),
  );
  personId = person.id;
  await setPreset("autonomous");
});

describe("outbound.message in submitOutbound", () => {
  it("lets a clean message from an AI actor go automatically, as before", async () => {
    const judge = scripted();
    const decision = await submitOutbound(
      db,
      submission(1, "Hi Sam. Thanks for your time on Monday."),
    );
    expect(decision.decision).toBe("auto");
    const checked = await submitOutbound(
      db,
      submission(2, "Hi Sam. Thanks for your time on Monday.", { judge }),
    );
    expect(checked.decision).toBe("auto");
    expect(judge.calls).toHaveLength(1);
  });

  it("turns an automatic send into a review on a finding, and attaches the findings", async () => {
    const judge = scripted();
    const decision = await submitOutbound(
      db,
      submission(3, "Hi Sam. We can offer you a 20% discount on the renewal. Best, Jo", {
        judge,
        asked: "Email Sam Lee about the renewal.",
      }),
    );
    if (decision.decision !== "review")
      throw new Error(`expected review, got ${decision.decision}`);
    const stored = await check(decision.pending.actionId);
    expect(stored).toMatchObject({
      status: "checked",
      turnedToReview: true,
      recipientsChecked: true,
      findings: [
        { kind: "promises", part: "m2", text: "We can offer you a 20% discount on the renewal." },
      ],
    });
    // The state: the message split by code, the person's words, facts about the recipient
    // (matched by email, exactly), and never the agent's reason.
    const call = judge.calls[0] as FakeJudgeCall;
    expect(call.placement).toBe(OUTBOUND_PLACEMENT);
    const state = call.state as unknown as OutboundState;
    expect(state.message.to).toEqual([`Sam Lee <${email}>`]);
    expect(state.message.subject).toBe("Your renewal");
    expect(Object.values(state.message.body)).toHaveLength(3);
    expect(state.asked).toBe("Email Sam Lee about the renewal.");
    expect(state.facts.join("\n")).toMatch(/Brisbane/);
    expect(state.facts.join("\n")).toContain(personId);
    expect(JSON.stringify(state)).not.toMatch(/Follow up/);

    // The approver sees the findings, written by code; the AI actor that wrote it does not.
    const human = (await invokeByName(
      "approval.get",
      { changeSetId: decision.pending.changeSetId },
      context(admin),
    )) as { actions: { outbound: { check: { held: boolean; lines: string[] } | null } }[] };
    expect(human.actions[0]?.outbound.check).toMatchObject({ held: true });
    expect(human.actions[0]?.outbound.check?.lines[0]).toMatch(
      /A sentence promises something nothing in the records or the request gives: "We can offer you a 20% discount/,
    );
    const asAi = (await invokeByName(
      "approval.get",
      { changeSetId: decision.pending.changeSetId },
      context(member, { actor: "mcp", origin: { surface: "mcp" } }),
    )) as { actions: { outbound: { check: unknown } }[] };
    expect(asAi.actions[0]?.outbound.check).toBeNull();
  });

  it("asks about recipients only with a person's words, and flags someone else", async () => {
    const none = scripted();
    await submitOutbound(db, submission(4, "Hi Sam. Thanks.", { judge: none }));
    expect(Object.keys(none.calls[0]?.questions ?? {})).not.toContain("recipients");
    const plain = none.calls[0] as FakeJudgeCall;
    expect((plain.state as unknown as OutboundState).asked).toBe(NOTHING_ASKED);

    const other = scripted({ recipients: "someone_else" });
    const decision = await submitOutbound(
      db,
      submission(5, "Hi Sam. Thanks.", { judge: other, asked: "Email Priya about the pilot." }),
    );
    expect(decision.decision).toBe("review");
    if (decision.decision !== "review") return;
    expect((await check(decision.pending.actionId)).findings).toEqual([
      expect.objectContaining({ kind: "recipients", part: "recipients" }),
    ]);
  });

  it.each([...JUDGE_UNAVAILABLE_REASONS.filter((r) => r !== "off"), "fault"] as const)(
    "fails closed when the judge is %s: the message waits for a person",
    async (reason) => {
      const judge: Judge =
        reason === "fault"
          ? fakeJudge({ status: "fault", httpStatus: 400, detail: "bad" })
          : unavailableJudge(reason);
      const decision = await submitOutbound(db, submission(6, "Hi Sam. Thanks.", { judge }));
      expect(decision.decision).toBe("review");
      if (decision.decision !== "review") return;
      expect(await check(decision.pending.actionId)).toMatchObject({
        status: "unchecked",
        turnedToReview: true,
        reason,
      });
    },
  );

  it("off changes nothing: no call, no mark", async () => {
    const decision = await submitOutbound(
      db,
      submission(7, "Hi Sam. We can offer a 20% discount.", { judge: offJudge }),
    );
    expect(decision.decision).toBe("auto");
  });

  it("attaches findings where the gate already said review", async () => {
    await setPreset("balanced");
    const judge = scripted();
    const decision = await submitOutbound(
      db,
      submission(8, "Hi Sam. We can offer a 20% discount.", { judge }),
    );
    if (decision.decision !== "review") throw new Error("expected review");
    expect(await check(decision.pending.actionId)).toMatchObject({
      status: "checked",
      turnedToReview: false,
      findings: [expect.objectContaining({ kind: "promises" })],
    });
  });

  it.each([
    ["a person", "human" as Actor, { surface: "ui" as const }],
    [
      "notification delivery",
      "automation" as Actor,
      { surface: "system" as const, automationId: "system.notifications" },
    ],
  ])("never checks %s", async (_name, actor, origin) => {
    const judge = scripted();
    await submitOutbound(
      db,
      submission(9, "Hi Sam. We can offer a 20% discount.", { judge, actor, origin }),
    );
    expect(judge.calls).toHaveLength(0);
  });

  it("reads the message from the gatekeeper's fields, and nothing without a body", () => {
    expect(
      messageOf({
        fields: [
          { label: "To", value: "a@x.example\nb@x.example" },
          { label: "Cc", value: "c@x.example" },
          { label: "Subject", value: "Hello" },
          { label: "HTML body", value: "<p>Hi there.</p><p>See you <b>soon</b>.</p>" },
        ],
      }),
    ).toEqual({
      addresses: ["a@x.example", "b@x.example", "c@x.example"],
      subject: "Hello",
      sentences: ["Hi there.", "See you soon ."],
    });
    expect(messageOf({ fields: [{ label: "Calendar ID", value: "primary" }] })).toBeNull();
  });
});

describe("spend (ADR 0234)", () => {
  const usage = () =>
    env.DB.prepare(
      "SELECT calls, input_tokens FROM core_judge_usage WHERE day = ? AND placement = 'outbound.message'",
    )
      .bind(new Date().toISOString().slice(0, 10))
      .first<{ calls: number; input_tokens: number }>()
      .then((r) => ({ calls: r?.calls ?? 0, tokens: r?.input_tokens ?? 0 }));
  const withTokens = (judge: Judge, inputTokens: number): Judge => ({
    provider: "jev",
    async ask(request) {
      const out = await judge.ask(request);
      return out.status === "answered" ? { ...out, inputTokens } : out;
    },
  });

  it("counts a held message's call in the batch that writes its pending action", async () => {
    const before = await usage();
    const decision = await submitOutbound(
      db,
      submission(20, "Hi Sam. We can offer you a 20% discount.", {
        judge: withTokens(scripted(), 2100),
      }),
    );
    expect(decision.decision).toBe("review");
    const after = await usage();
    expect([after.calls - before.calls, after.tokens - before.tokens]).toEqual([1, 2100]);
  });

  it("carries an automatic send's call to the batch that audits it once applied", async () => {
    const before = await usage();
    const decision = await submitOutbound(
      db,
      submission(21, "Hi Sam. Thanks for your time on Monday.", {
        judge: withTokens(scripted(), 1500),
      }),
    );
    if (decision.decision !== "auto") throw new Error(`expected auto, got ${decision.decision}`);
    expect(decision.judgeUsage).toEqual({ calls: 1, inputTokens: 1500 });
    // Nothing is counted until the host applies it and audits the outcome.
    expect(await usage()).toEqual(before);
    await auditOutboundApplied(db, submission(21, "."), { ok: true }, decision.judgeUsage);
    const after = await usage();
    expect([after.calls - before.calls, after.tokens - before.tokens]).toEqual([1, 1500]);
  });

  it("counts a call that failed with no tokens, and nothing when the placement is off", async () => {
    const before = await usage();
    await submitOutbound(db, submission(22, "Hi Sam.", { judge: unavailableJudge("timeout") }));
    await submitOutbound(db, submission(23, "Hi Sam.", { judge: offJudge }));
    const after = await usage();
    expect([after.calls - before.calls, after.tokens - before.tokens]).toEqual([1, 0]);
  });
});
