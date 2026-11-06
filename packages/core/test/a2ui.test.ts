// A2UI in the CRM (ADR 0345, ADR 0346): cards in the thread and its transcript, what erase does to
// them, the operations, and which approvals need a second step.
import {
  A2UI_CATALOGUE_VERSION,
  type A2uiPart,
  prepareCard,
  producerRef,
} from "@relationship-os/agent-a2ui";
import type { ThreadMessage } from "@relationship-os/agent-core";
import { sampleDocument } from "@relationship-os/agent-a2ui/samples";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  applyEvent,
  type AssistantEvent,
  cardModelText,
  cardOf,
  describeAssistantResult,
  type ExtensionHost,
  FIRST_PARTY_PRODUCERS,
  invokeByName,
  type ProducerRun,
  producers,
  recipientCount,
  scrubParts,
  scrubPattern,
  secondStep,
  secondStepFor,
  transcriptFromThread,
  withCardText,
} from "../src/index.ts";
import { auditRows, context, createUser, setPreset } from "./helpers.ts";

const card = (): A2uiPart => prepareCard(sampleDocument("taskList"), { source: "model" });

function message(partial: Partial<ThreadMessage> & Pick<ThreadMessage, "parts">): ThreadMessage {
  return {
    seq: 1,
    turn: 1,
    role: "tool",
    via: "text",
    createdAt: "2026-11-06T00:00:00Z",
    ...partial,
  };
}

describe("cards in tool results", () => {
  const result = () => ({ status: "a2ui_card", part: card() });

  it("are recognised, and pending changes still are", () => {
    expect(cardOf(result())?.type).toBe("a2ui");
    expect(cardOf({ status: "shown" })).toBeUndefined();
    expect(cardOf({ status: "a2ui_card", part: { type: "text" } })).toBeUndefined();
    expect(describeAssistantResult(result(), false)?.card).toBeDefined();
    expect(describeAssistantResult(result(), true)).toBeUndefined();
    expect(
      describeAssistantResult(
        { status: "pending_approval", actionId: "a", changeSetId: "c" },
        false,
      )?.pending?.actionId,
    ).toBe("a");
  });

  it("reach the model as text only, never the document", async () => {
    const [tool] = withCardText([
      {
        name: "show_card",
        description: "x",
        inputSchema: {},
        call: async () => ({ text: JSON.stringify(result()), isError: false }),
      },
    ]);
    const out = await tool?.call({});
    expect(JSON.parse(out?.text ?? "").part.document).toBeDefined();
    const said = JSON.parse(out?.modelText ?? "");
    expect(said).toEqual({ status: "shown", text: card().fallback });
    expect(out?.modelText).not.toContain("tsk_1");
  });

  it("tell the model when a card was not shown, and why", () => {
    const part = prepareCard({ a2ui: 1, root: { type: "nope" } }, { source: "model", text: "Words" });
    expect(JSON.parse(cardModelText(part))).toEqual({
      status: "not_shown",
      shownAsText: "Words",
      problems: ["root: unknown component nope"],
    });
  });

  it("leave other tools alone", async () => {
    const [tool] = withCardText([
      {
        name: "person_get",
        description: "x",
        inputSchema: {},
        call: async () => ({ text: '{"id":"per_1"}', isError: false }),
      },
    ]);
    expect((await tool?.call({}))?.modelText).toBeUndefined();
  });
});

describe("the transcript", () => {
  it("shows a card live, after its tool call", () => {
    const part = card();
    const events: AssistantEvent[] = [
      { seq: 1, type: "turn-start", turn: 3, text: "hi", at: "2026-11-06T00:00:00Z" },
      { seq: 2, type: "tool-call", id: "c1", tool: "show_card", input: {} },
      { seq: 3, type: "tool-result", id: "c1", tool: "show_card", output: {}, isError: false, card: part },
    ];
    const items = events.reduce(applyEvent, []);
    expect(items.map((i) => i.kind)).toEqual(["user", "tool", "card"]);
    expect(items[2]).toMatchObject({ kind: "card", turn: 3, part });
  });

  it("shows stored cards where they were: beside a tool result, or on their own", () => {
    const part = card();
    const items = transcriptFromThread([
      message({
        seq: 1,
        role: "assistant",
        parts: [{ type: "tool-call", toolCallId: "c1", toolName: "show_card", input: {} }],
      }),
      message({
        seq: 2,
        parts: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "show_card",
            output: { type: "text", value: '{"status":"shown"}' },
          },
          part,
        ],
      }),
      message({ seq: 3, turn: 2, role: "assistant", via: "routine", parts: [part] }),
    ]);
    expect(items.map((i) => [i.kind, i.seq])).toEqual([
      ["tool", 1],
      ["card", 2],
      ["card", 3],
    ]);
  });
});

describe("erase", () => {
  it("removes a card that mentions the subject, keeping its text with them taken out", () => {
    const pattern = scrubPattern({ terms: [], names: ["Kestrel Energy"] });
    const part = prepareCard(sampleDocument("keyValue"), { source: "model" });
    const [scrubbed] = scrubParts([part], pattern) as [A2uiPart];
    expect(scrubbed.document).toBeNull();
    expect(scrubbed.fallback).toContain("[erased]");
    expect(JSON.stringify(scrubbed)).not.toContain("Kestrel");
  });

  it("leaves a card that does not", () => {
    const pattern = scrubPattern({ terms: [], names: ["Somebody Else"] });
    const parts = [prepareCard(sampleDocument("heading"), { source: "model" })];
    expect(scrubParts(parts, pattern)).toBe(parts);
  });
});

describe("high-risk approvals", () => {
  const email = (to: string) => ({
    risk: "outbound",
    title: "Send email",
    outbound: { fields: [{ label: "To", value: to }] },
  });

  it("asks a second step of destructive changes", () => {
    expect(secondStep({ risk: "destructive", title: "Delete person" })).toEqual({
      label: "Delete person",
      confirmLabel: "Confirm: delete person",
    });
  });

  it("asks it of email above the threshold, with the plain words of ADR 0345", () => {
    expect(secondStep(email("240"))).toEqual({
      label: "Send 240 emails",
      confirmLabel: "Confirm: send 240 emails",
    });
    expect(secondStep(email("25"))).toBeNull();
    expect(secondStep(email("26"))?.label).toBe("Send 26 emails");
    expect(secondStep(email("26"), 30)).toBeNull();
  });

  it("does not ask it of ordinary changes", () => {
    expect(secondStep({ risk: "write", title: "Update person" })).toBeNull();
    expect(secondStep({ risk: "bulk-write", title: "Update 40 people" })).toBeNull();
    expect(secondStep({ risk: "outbound", title: "Send", outbound: null })).toBeNull();
  });

  it("counts recipients from a list across To, Cc and Bcc", () => {
    expect(
      recipientCount({
        fields: [
          { label: "To", value: "a@x.example, b@x.example" },
          { label: "Cc", value: "c@x.example" },
          { label: "Subject", value: "1, 2, 3" },
        ],
      }),
    ).toBe(3);
    expect(recipientCount({ fields: [{ label: "Recipients", value: "1,240" }] })).toBe(1240);
  });

  it("names one high-risk action, and counts several", () => {
    const write = { risk: "write", title: "Update person" };
    const remove = { risk: "destructive", title: "Delete person" };
    expect(secondStepFor([write])).toBeNull();
    expect(secondStepFor([remove])?.label).toBe("Delete person");
    expect(secondStepFor([remove, write])).toEqual({
      label: "Approve 2 changes",
      confirmLabel: "Confirm: approve 2 changes",
    });
  });
});

describe("a2ui.show", () => {
  let user: ActingUser;
  beforeAll(async () => {
    user = await createUser("member");
  });
  const show = (input: Record<string, unknown>, actor: "assistant" | "human" = "assistant") =>
    invokeByName(
      "a2ui.show",
      input,
      context(user, { actor, origin: { surface: actor === "human" ? "ui" : "assistant" } }),
    ) as Promise<{ part: A2uiPart }>;

  it("validates the model's card and keeps its fallback", async () => {
    const { part } = await show({ card: sampleDocument("taskList"), text: "Your tasks" });
    expect(part.source).toBe("model");
    expect(part.document?.root.type).toBe("taskList");
    expect(part.fallback).toContain("Chase Kestrel NDA");
  });

  it("takes a card sent as a JSON string", async () => {
    const { part } = await show({
      card: JSON.stringify(sampleDocument("heading")),
      text: "Words",
    });
    expect(part.document?.root.type).toBe("heading");
  });

  it("falls back to the model's words for anything invalid, never failing the turn", async () => {
    for (const bad of ["not json", 7, null, { a2ui: 1, root: { type: "iframe" } }]) {
      const { part } = await show({ card: bad, text: "In words" });
      expect(part.document).toBeNull();
      expect(part.fallback).toBe("In words");
    }
  });

  it("refuses system cards from the model", async () => {
    const { part } = await show({ card: sampleDocument("approval"), text: "Words" });
    expect(part.document).toBeNull();
    expect(part.problems?.join()).toContain("only the app itself");
  });

  it("is for the assistant only", async () => {
    await expect(show({ card: {}, text: "x" }, "human")).rejects.toMatchObject({
      code: "forbidden",
    });
  });
});

describe("a2ui.act: a button on a model's card goes through the gate", () => {
  let member: ActingUser;
  let viewer: ActingUser;
  beforeAll(async () => {
    member = await createUser("member");
    viewer = await createUser("viewer");
    await setPreset("balanced");
  });
  const act = (user: ActingUser, operation: string, input: Record<string, unknown>) =>
    invokeByName(
      "a2ui.act",
      { operation, input, label: "Open", threadId: "ath_test" },
      context(user),
    ) as Promise<{ status: string; result?: { id: string }; changeSetId?: string }>;
  const person = (user: ActingUser) =>
    invokeByName("person.create", { givenName: "Card" }, context(user)) as Promise<{ id: string }>;

  it("applies what the assistant may do alone, as the assistant", async () => {
    const out = await act(member, "task.create", { title: "From a card" });
    expect(out.status).toBe("done");
    const rows = await auditRows("task.create", member.id);
    expect(rows.at(-1)?.actor).toBe("assistant");
  });

  it("queues a destructive call, however innocent the button's label", async () => {
    const { id } = await person(member);
    const out = await act(member, "person.delete", { id });
    expect(out.status).toBe("pending_approval");
    expect(out.changeSetId).toBeTruthy();
    const live = (await invokeByName("person.get", { id }, context(member))) as {
      deletedAt: string | null;
    };
    expect(live.deletedAt).toBeNull();
  });

  it("keeps the viewer's permissions", async () => {
    await expect(act(viewer, "task.create", { title: "No" })).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("can never reach approvals, code or itself", async () => {
    for (const operation of [
      "approval.approve",
      "approval.reject",
      "code.run",
      "a2ui.act",
      "extension.apply",
    ]) {
      await expect(act(member, operation, {})).rejects.toMatchObject({ code: "forbidden" });
    }
  });

  it("is refused to everyone but people", async () => {
    await expect(
      invokeByName(
        "a2ui.act",
        { operation: "task.create", input: {}, label: "x" },
        context(member, { actor: "assistant", origin: { surface: "assistant" } }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("a2ui.produce", () => {
  let user: ActingUser;
  const runs: ProducerRun[] = [];
  let answer: Awaited<ReturnType<ExtensionHost["runProducer"]>>;
  const host = {
    async runProducer(input: ProducerRun) {
      runs.push(input);
      return answer;
    },
  } as unknown as ExtensionHost;
  const produce = (input: Record<string, unknown>, overrides = {}) =>
    invokeByName(
      "a2ui.produce",
      input,
      context(user, { extensionHost: host, ...overrides }),
    ) as Promise<{ part: A2uiPart; seq?: number }>;

  beforeAll(async () => {
    user = await createUser("member");
  });

  it("ships the two first-party producers, listed for the model", () => {
    expect(FIRST_PARTY_PRODUCERS.map(producerRef)).toEqual([
      "tasks.overdueCard@1",
      "pipeline.staleDealsCard@1",
    ]);
  });

  it("runs the script as the viewer and stores its card", async () => {
    answer = { ok: true, value: sampleDocument("dealList"), durationMs: 1 };
    const { part } = await produce({ producer: "pipeline.staleDealsCard", input: { days: 21 } });
    expect(part).toMatchObject({ source: "producer", producer: "pipeline.staleDealsCard@1" });
    expect(part.document?.root.type).toBe("dealList");
    const run = runs.at(-1);
    expect(run?.ref).toBe("pipeline.staleDealsCard@1");
    expect(run?.input).toEqual({ days: 21, limit: 20 });
    expect(run?.caller.user.id).toBe(user.id);
    expect(run?.caller.actor).toBe("human");
  });

  it("falls back to text when the script's card is invalid", async () => {
    answer = { ok: true, value: { a2ui: 1, root: { type: "marquee" } }, durationMs: 1 };
    const { part } = await produce({ producer: "tasks.overdueCard" });
    expect(part.document).toBeNull();
    expect(part.fallback).toContain("overdue tasks");
  });

  it("refuses a system card from a producer", async () => {
    answer = { ok: true, value: sampleDocument("approval"), durationMs: 1 };
    expect((await produce({ producer: "tasks.overdueCard" })).part.document).toBeNull();
  });

  it("falls back to text when the script fails", async () => {
    answer = { ok: false, error: { code: "timeout", message: "Timed out" }, durationMs: 1 };
    const { part } = await produce({ producer: "tasks.overdueCard" });
    expect(part.document).toBeNull();
    expect(part.problems).toEqual(["Timed out"]);
  });

  it("falls back to text, without running, for a newer catalogue than the app's", async () => {
    producers.register({
      name: "plugin.futureCard",
      version: 1,
      catalogue: A2UI_CATALOGUE_VERSION + 1,
      description: "From the future. Input: none",
      source: "export default () => null;",
    });
    const before = runs.length;
    const { part } = await produce({ producer: "plugin.futureCard" });
    expect(runs.length).toBe(before);
    expect(part.document).toBeNull();
    expect(part.fallback).toBe("From the future.");
    producers.remove("plugin.futureCard");
  });

  it("checks the producer's input", async () => {
    await expect(
      produce({ producer: "pipeline.staleDealsCard", input: { days: 9999 } }),
    ).rejects.toThrow();
  });

  it("does not know a producer that is not registered", async () => {
    await expect(produce({ producer: "no.such" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("posts in the thread when asked, except for the assistant, whose tool result shows it", async () => {
    answer = { ok: true, value: sampleDocument("dealList"), durationMs: 1 };
    const posted: A2uiPart[] = [];
    const assistantThreads = {
      postCard: async (_: string, part: A2uiPart) => {
        posted.push(part);
        return { seq: 42 };
      },
    } as never;
    const out = await produce({ producer: "tasks.overdueCard", post: true }, { assistantThreads });
    expect(out.seq).toBe(42);
    expect(posted).toHaveLength(1);
    await produce(
      { producer: "tasks.overdueCard", post: true },
      { assistantThreads, actor: "assistant", origin: { surface: "assistant" } },
    );
    expect(posted).toHaveLength(1);
  });
});
