// Summaries (stage 7 AC 6 minus the digest, ADR 0153): cached by a hash of their inputs, stale as
// soon as the record, its timeline, tasks or the model change, regenerated only on request, and
// always labelled AI-generated. Covers record summaries, meeting prep, activity one-liners and
// change-set summaries.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  AI_SETTINGS,
  invoke,
  LONG_ACTIVITY_CHARS,
  PendingApprovalError,
} from "../src/index.ts";
import { testRunner } from "./ai-helpers.ts";
import { context, createUser, setPreset, unique } from "./helpers.ts";

let member: ActingUser;
let calls = 0;
const { models } = testRunner({
  answer: (_model, input) => {
    calls += 1;
    const messages = input.messages as { role: string; content: string }[] | undefined;
    const prompt = messages?.at(-1)?.content ?? String(input.prompt ?? "");
    return `Summary #${calls}: ${prompt.split("\n").length} facts.`;
  },
});

beforeAll(async () => {
  member = await createUser("member");
  await env.DB.prepare("DELETE FROM core_settings WHERE key = ?").bind(AI_SETTINGS).run();
});

const ctx = (overrides = {}) => context(member, { models, ...overrides });

async function personWithNote() {
  const person = await invoke(
    "person.create",
    { displayName: `Ada ${unique()}`, location: "London" },
    ctx(),
  );
  await invoke(
    "activity.log",
    {
      type: "note",
      body: "Asked about the enterprise plan.",
      links: [{ object: "person", id: person.id }],
    },
    ctx(),
  );
  return person;
}

describe("record summaries", () => {
  it("are generated on request, cached, labelled, and stale when the timeline changes", async () => {
    const person = await personWithNote();
    const subject = { kind: "record" as const, object: "person" as const, id: person.id };
    expect(await invoke("summary.get", { subject }, ctx())).toMatchObject({
      status: "missing",
      text: null,
      aiGenerated: true,
    });
    const before = calls;
    const first = await invoke("summary.generate", { subject }, ctx());
    expect(first).toMatchObject({ status: "fresh", aiGenerated: true });
    expect(calls).toBe(before + 1);
    expect(await invoke("summary.get", { subject }, ctx())).toMatchObject({
      status: "fresh",
      text: first.text,
    });

    // Fresh: generating again returns the cache without a model call.
    await invoke("summary.generate", { subject }, ctx());
    expect(calls).toBe(before + 1);

    // A new note makes it stale; the old text is still shown until regenerated.
    await invoke(
      "activity.log",
      {
        type: "note",
        body: "Signed the order form.",
        links: [{ object: "person", id: person.id }],
      },
      ctx(),
    );
    expect(await invoke("summary.get", { subject }, ctx())).toMatchObject({
      status: "stale",
      text: first.text,
    });
    const second = await invoke("summary.generate", { subject }, ctx());
    expect(calls).toBe(before + 2);
    expect(second.text).not.toBe(first.text);

    // An edited field makes it stale too.
    await invoke("person.update", { id: person.id, location: "Paris" }, ctx());
    expect((await invoke("summary.get", { subject }, ctx())).status).toBe("stale");
  });

  it("go stale when the summarise model changes", async () => {
    const person = await personWithNote();
    const subject = { kind: "record" as const, object: "person" as const, id: person.id };
    await invoke("summary.generate", { subject }, ctx());
    const admin = await createUser("admin");
    await invoke(
      "ai.updateRole",
      { role: "summarise", provider: "workers-ai", model: "@cf/openai/gpt-oss-20b" },
      context(admin),
    );
    const fresh = testRunner();
    expect(
      (await invoke("summary.get", { subject }, context(member, { models: fresh.models }))).status,
    ).toBe("stale");
    await invoke("ai.updateRole", { role: "summarise", reset: true }, context(admin));
  });

  it("cover organisations and deals, and say when AI is not configured", async () => {
    const org = await invoke("organisation.create", { name: `Acme ${unique()}` }, ctx());
    const out = await invoke(
      "summary.generate",
      { subject: { kind: "record", object: "organisation", id: org.id } },
      ctx(),
    );
    expect(out.status).toBe("fresh");
    expect(
      await invoke(
        "summary.get",
        { subject: { kind: "record", object: "organisation", id: org.id } },
        ctx(),
      ),
    ).toMatchObject({ status: "fresh" });
    // Without AI the cached text is still shown, marked unavailable for refresh.
    expect(
      await invoke(
        "summary.get",
        { subject: { kind: "record", object: "organisation", id: org.id } },
        context(member),
      ),
    ).toMatchObject({ status: "unavailable", text: out.text });
    const other = await invoke("organisation.create", { name: `Other ${unique()}` }, ctx());
    expect(
      await invoke(
        "summary.get",
        { subject: { kind: "record", object: "organisation", id: other.id } },
        context(member),
      ),
    ).toMatchObject({ status: "unavailable" });
    await expect(
      invoke(
        "summary.generate",
        { subject: { kind: "record", object: "organisation", id: other.id } },
        context(member),
      ),
    ).rejects.toThrow(/not configured/);
  });
});

describe("meeting prep", () => {
  it("covers attendees, their organisation and recent history, and goes stale with a new note", async () => {
    const org = await invoke("organisation.create", { name: `Globex ${unique()}` }, ctx());
    const person = await invoke("person.create", { displayName: `Hank ${unique()}` }, ctx());
    await invoke(
      "affiliation.create",
      { personId: person.id, organisationId: org.id, title: "VP Sales" },
      ctx(),
    );
    const meeting = await invoke(
      "activity.log",
      {
        type: "meeting",
        subject: "Quarterly review",
        payload: { startsAt: "2031-01-10T10:00:00.000Z" },
        links: [{ object: "person", id: person.id }],
      },
      ctx(),
    );
    const subject = { kind: "meeting" as const, id: meeting.id };
    const before = calls;
    const prep = await invoke("summary.generate", { subject }, ctx());
    expect(prep.status).toBe("fresh");
    expect(calls).toBe(before + 1);
    const { meetingPrepInput } = await import("../src/index.ts");
    const input = await meetingPrepInput((await import("./helpers.ts")).db.query, meeting.id);
    expect(input.facts.join("\n")).toMatch(/Attendee: Hank .*VP Sales at Globex/);
    expect(input.facts.join("\n")).toMatch(/Organisation: Name: Globex/);
    await invoke(
      "activity.log",
      { type: "note", body: "Wants a discount.", links: [{ object: "person", id: person.id }] },
      ctx(),
    );
    expect((await invoke("summary.get", { subject }, ctx())).status).toBe("stale");
  });
});

describe("activity one-liners", () => {
  it("only long notes get one, generated in a batch and cached", async () => {
    const person = await personWithNote();
    const long = await invoke(
      "activity.log",
      {
        type: "note",
        body: `Long call notes. ${"The customer described their rollout plan in detail. ".repeat(12)}`,
        links: [{ object: "person", id: person.id }],
      },
      ctx(),
    );
    expect(long.body?.length ?? 0).toBeGreaterThan(LONG_ACTIVITY_CHARS);
    const short = await invoke(
      "activity.log",
      { type: "note", body: "Short.", links: [{ object: "person", id: person.id }] },
      ctx(),
    );
    const lines = await invoke("summary.activityLines", { ids: [long.id, short.id] }, ctx());
    expect(lines).toMatchObject({ lines: [], missing: [long.id], available: true });
    const before = calls;
    const made = await invoke("summary.activities", { ids: [long.id, short.id] }, ctx());
    expect(made.lines.map((l) => l.id)).toEqual([long.id]);
    expect(made.lines[0]?.text).not.toContain("\n");
    expect(calls).toBe(before + 1);
    await invoke("summary.activities", { ids: [long.id] }, ctx());
    expect(calls).toBe(before + 1);
    expect(await invoke("summary.activityLines", { ids: [long.id] }, ctx())).toMatchObject({
      lines: [{ id: long.id, fresh: true }],
      missing: [],
    });
    await invoke("activity.update", { id: long.id, body: `${long.body} One more thing.` }, ctx());
    expect((await invoke("summary.activityLines", { ids: [long.id] }, ctx())).missing).toEqual([
      long.id,
    ]);
  });
});

describe("change-set summaries", () => {
  it("describe a pending change set for its approver: the change only, never the agent's reason", async () => {
    await setPreset("cautious");
    const person = await invoke("person.create", { displayName: `Grace ${unique()}` }, ctx());
    let changeSetId = "";
    try {
      await invoke(
        "person.update",
        { id: person.id, location: "Arlington" },
        context(member, {
          actor: "mcp",
          origin: { surface: "mcp", sessionId: `cap_${unique()}` },
          reason: "Promotion",
        }),
      );
    } catch (error) {
      if (!(error instanceof PendingApprovalError)) throw error;
      changeSetId = (error.toJSON().details as { changeSetId: string }).changeSetId;
    }
    expect(changeSetId).not.toBe("");
    const { changeSetSummaryInput, summaryMessages } = await import("../src/index.ts");
    const input = await changeSetSummaryInput((await import("./helpers.ts")).db.query, changeSetId);
    expect(input.facts[0]).toMatch(
      /^- person.update \[pending\]: update person \(location: null → "Arlington"\)$/,
    );
    // ADR 0236: the summary says what the change does; the approval screen shows the agent's
    // reason on its own, labelled as the agent's.
    const messages = summaryMessages(input);
    expect(JSON.stringify(messages)).not.toContain("Promotion");
    expect(messages[0]?.content).toMatch(/do not explain, guess or justify why/);
    const out = await invoke(
      "summary.generate",
      { subject: { kind: "changeset", id: changeSetId } },
      ctx(),
    );
    expect(out).toMatchObject({ status: "fresh", aiGenerated: true });
  });
});
