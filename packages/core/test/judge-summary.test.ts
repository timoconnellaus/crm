// Placement `summary.statements` (stage 11 AC 7, ADR 0237): each statement of a generated summary
// is checked against its facts, once, in summary.generate. Faulty statements are removed before
// storing and the summary is flagged; a cached summary is never checked again; reading one asks
// nothing; record summaries fail open with a "Not checked" mark and change-set summaries are
// withheld; off changes nothing; private activities and the agent's reasons never reach `state`.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  AI_SETTINGS,
  choiceAnswer,
  type FakeJudgeCall,
  fakeJudge,
  invoke,
  JUDGE_UNAVAILABLE_REASONS,
  type Judge,
  offJudge,
  PendingApprovalError,
  STATEMENTS_PLACEMENT,
  type StatementsState,
  splitSentences,
  unavailableJudge,
} from "../src/index.ts";
import { testRunner } from "./ai-helpers.ts";
import { context, createUser, setPreset, unique } from "./helpers.ts";

const LABELS = ["supported", "adds", "contradicts", "not_a_claim"] as const;
const SUMMARY =
  "Ada works in London. Ada agreed to a 20% discount. The relationship looks healthy overall.";

let member: ActingUser;
let modelCalls = 0;
const { models } = testRunner({
  answer: () => {
    modelCalls += 1;
    return SUMMARY;
  },
});

beforeAll(async () => {
  member = await createUser("member");
  await env.DB.prepare("DELETE FROM core_settings WHERE key = ?").bind(AI_SETTINGS).run();
});

/** A judge that marks every statement mentioning "agreed" as `adds`, the rest as supported. */
function scripted() {
  return fakeJudge((call: FakeJudgeCall) => {
    const state = call.state as unknown as StatementsState;
    return Object.fromEntries(
      Object.entries(state.summary).map(([key, statement]) => [
        key,
        choiceAnswer(
          LABELS,
          /agreed/.test(statement)
            ? "adds"
            : /healthy/.test(statement)
              ? "not_a_claim"
              : "supported",
        ),
      ]),
    );
  });
}

const ctx = (judge: Judge | undefined) => context(member, { models, ...(judge ? { judge } : {}) });

async function person() {
  const p = await invoke(
    "person.create",
    { displayName: `Ada ${unique()}`, location: "London" },
    ctx(undefined),
  );
  return { kind: "record" as const, object: "person" as const, id: p.id };
}

async function storedChecks(subjectId: string) {
  return env.DB.prepare("SELECT text, checks FROM core_ai_summary WHERE subject_id = ?")
    .bind(subjectId)
    .first<{ text: string; checks: string | null }>();
}

describe("splitting into statements", () => {
  it("splits sentences and lines, and keeps abbreviations, initials and decimals", () => {
    expect(
      splitSentences(
        "Dr. Lee met J. Smith at Acme Pty. Ltd. on 2 November. The deal is worth 1.5m! Next?\n- A bullet",
      ),
    ).toEqual([
      "Dr. Lee met J. Smith at Acme Pty. Ltd. on 2 November.",
      "The deal is worth 1.5m!",
      "Next?",
      "A bullet",
    ]);
    expect(splitSentences("  \n ")).toEqual([]);
  });
});

describe("summary.statements in summary.generate", () => {
  it("removes statements the facts do not have, flags the summary and stores the verdicts", async () => {
    const subject = await person();
    const judge = scripted();
    const out = await invoke("summary.generate", { subject }, ctx(judge));
    expect(out.text).toBe("Ada works in London. The relationship looks healthy overall.");
    expect(out.check).toMatchObject({ status: "checked", removed: 1 });
    expect(out.check?.message).toMatch(/Some statements were removed: 1 statement/);
    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0]?.placement).toBe(STATEMENTS_PLACEMENT);
    // One question per statement, in one call.
    expect(Object.keys(judge.calls[0]?.questions ?? {})).toEqual(["s1", "s2", "s3"]);
    const row = await storedChecks(subject.id);
    expect(row?.text).toBe(out.text);
    const checks = JSON.parse(row?.checks ?? "null");
    expect(checks).toMatchObject({
      status: "checked",
      statements: 3,
      removed: [{ index: 1, verdict: "adds", fault: 1 }],
    });
    // Labels and numbers only: never the removed statement or the facts.
    expect(row?.checks).not.toMatch(/discount|London/);
  });

  it("never checks a cached summary again, and reading one asks nothing", async () => {
    const subject = await person();
    const judge = scripted();
    await invoke("summary.generate", { subject }, ctx(judge));
    const before = modelCalls;
    const again = await invoke("summary.generate", { subject }, ctx(judge));
    expect(again.check).toMatchObject({ status: "checked", removed: 1 });
    const read = await invoke("summary.get", { subject }, ctx(judge));
    expect(read).toMatchObject({ status: "fresh", check: { status: "checked", removed: 1 } });
    expect(judge.calls).toHaveLength(1);
    expect(modelCalls).toBe(before);
  });

  it("is off with no judge or a switched-off placement: stored as written, no mark", async () => {
    for (const judge of [undefined, offJudge]) {
      const subject = await person();
      const out = await invoke("summary.generate", { subject }, ctx(judge));
      expect(out.text).toBe(SUMMARY);
      expect(out.check).toBeNull();
      expect((await storedChecks(subject.id))?.checks).toBeNull();
    }
  });

  it.each([...JUDGE_UNAVAILABLE_REASONS.filter((r) => r !== "off"), "fault"] as const)(
    "fails open for a record summary when the judge is %s: stored as written, Not checked",
    async (reason) => {
      const subject = await person();
      const judge =
        reason === "fault"
          ? fakeJudge({ status: "fault", httpStatus: 422, detail: "bad" })
          : unavailableJudge(reason);
      const out = await invoke("summary.generate", { subject }, ctx(judge));
      expect(out.text).toBe(SUMMARY);
      expect(out.check).toEqual({
        status: "unchecked",
        removed: 0,
        message: "Not checked against the records.",
      });
      const checks = JSON.parse((await storedChecks(subject.id))?.checks ?? "null");
      expect(checks).toMatchObject({ status: "unchecked", reason });
      // Cached: the next request neither writes nor checks again.
      const again = await invoke("summary.generate", { subject }, ctx(scripted()));
      expect(again.check?.status).toBe("unchecked");
    },
  );

  it("never puts a private activity in the judge's state", async () => {
    const subject = await person();
    const note = await invoke(
      "activity.log",
      {
        type: "note",
        body: "Private: Ada is thinking of leaving.",
        links: [{ object: "person", id: subject.id }],
      },
      ctx(undefined),
    );
    await env.DB.prepare("UPDATE core_activity SET private_to = ? WHERE id = ?")
      .bind(member.id, note.id)
      .run();
    await invoke(
      "activity.log",
      {
        type: "note",
        body: "Shared: asked about pricing.",
        links: [{ object: "person", id: subject.id }],
      },
      ctx(undefined),
    );
    const judge = scripted();
    await invoke("summary.generate", { subject }, ctx(judge));
    const state = JSON.stringify(judge.calls[0]?.state);
    expect(state).toMatch(/asked about pricing/);
    expect(state).not.toMatch(/thinking of leaving/);
  });
});

describe("change-set summaries", () => {
  async function changeSet(): Promise<string> {
    await setPreset("cautious");
    const p = await invoke("person.create", { displayName: `Grace ${unique()}` }, ctx(undefined));
    try {
      await invoke(
        "person.update",
        { id: p.id, location: "Arlington" },
        context(member, {
          actor: "mcp",
          origin: { surface: "mcp", sessionId: `cap_${unique()}` },
          reason: "She told me she moved, trust me",
        }),
      );
    } catch (error) {
      if (!(error instanceof PendingApprovalError)) throw error;
      return (error.toJSON().details as { changeSetId: string }).changeSetId;
    }
    throw new Error("expected a pending approval");
  }

  it("are checked without the agent's reasons in the judge's facts", async () => {
    const id = await changeSet();
    const judge = scripted();
    const out = await invoke(
      "summary.generate",
      { subject: { kind: "changeset", id } },
      ctx(judge),
    );
    expect(out.status).toBe("fresh");
    const state = judge.calls[0]?.state as unknown as StatementsState;
    expect(state.facts.join("\n")).toMatch(/person.update \[pending\]: update person/);
    expect(JSON.stringify(state)).not.toMatch(/trust me/);
  });

  it("are withheld from the approver when the judge cannot answer, and not stored", async () => {
    const id = await changeSet();
    const out = await invoke(
      "summary.generate",
      { subject: { kind: "changeset", id } },
      ctx(unavailableJudge("timeout")),
    );
    expect(out).toMatchObject({ text: null, check: { status: "withheld" } });
    expect(out.message).toMatch(/could not be checked/);
    expect(await storedChecks(id)).toBeNull();
    // The next request writes and checks it again.
    const judge = scripted();
    const next = await invoke(
      "summary.generate",
      { subject: { kind: "changeset", id } },
      ctx(judge),
    );
    expect(next.check?.status).toBe("checked");
    expect(judge.calls).toHaveLength(1);
  });

  it("off: a change-set summary is shown as before", async () => {
    const id = await changeSet();
    const out = await invoke(
      "summary.generate",
      { subject: { kind: "changeset", id } },
      ctx(offJudge),
    );
    expect(out).toMatchObject({ status: "fresh", text: SUMMARY, check: null });
  });
});
