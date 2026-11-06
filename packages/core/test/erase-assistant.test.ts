// person.erase / organisation.erase and assistant threads (ADR 0019 and ADR 0200 amendments,
// 2026-11-05; ADR 0340): threads are found through the ref index thread.finishTurn writes, each is
// scrubbed through the thread store before the erase commits, and their bookkeeping rows and the
// subject's refs follow in the erase's batch. The store here keeps messages in memory and applies
// the same scrubParts the Durable Object does (apps/app/test/assistant.test.ts runs the real one).
import { env } from "cloudflare:workers";
import type { ThreadMessage } from "@relationship-os/agent-core";
import type { ModelMessage } from "ai";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  type AssistantThreadStore,
  type ConversationScrub,
  conversationRefs,
  ERASED,
  emailRef,
  invoke,
  scrubMessage,
  scrubParts,
  scrubPattern,
} from "../src/index.ts";
import { context, createUser, unique } from "./helpers.ts";

let admin: ActingUser;
let member: ActingUser;

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
});

describe("scrubbing a stored message", () => {
  const scrub: ConversationScrub = {
    terms: ["per_01JC9Z6X0V8M4T3K2Q1W5E7R9Y", "ada@example.com", "+44 20 7946 0958"],
    names: ["Ada Lovelace", "Ada", "Lovelace"],
  };
  const pattern = scrubPattern(scrub);

  it("erases whole tool inputs and outputs that mention the subject", () => {
    const call: ModelMessage = {
      role: "assistant",
      content: [
        { type: "reasoning", text: "Look up Ada first." },
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "person_get",
          input: { id: "per_01JC9Z6X0V8M4T3K2Q1W5E7R9Y" },
        },
        { type: "tool-call", toolCallId: "c2", toolName: "task_list", input: { status: "open" } },
      ],
    };
    expect(scrubMessage(call, pattern)).toEqual({
      role: "assistant",
      content: [
        { type: "reasoning", text: `Look up ${ERASED} first.` },
        { type: "tool-call", toolCallId: "c1", toolName: "person_get", input: { erased: true } },
        { type: "tool-call", toolCallId: "c2", toolName: "task_list", input: { status: "open" } },
      ],
    });
    const result: ModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "person_get",
          output: { type: "json", value: { title: "Head of Engines", email: "ADA@example.com" } },
        },
      ],
    };
    expect(scrubMessage(result, pattern)).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "person_get",
          output: { type: "text", value: ERASED },
        },
      ],
    });
  });

  it("replaces mentions in free text: ids, emails, phones in any format, names as words", () => {
    const user: ModelMessage = {
      role: "user",
      content:
        "Call Ada Lovelace on 020 7946 0958 or +44 (20) 7946-0958; cc ada@example.com. Adam stays.",
    };
    expect(scrubMessage(user, pattern)).toEqual({
      role: "user",
      content: `Call ${ERASED} on 020 7946 0958 or +${ERASED}; cc ${ERASED}. Adam stays.`,
    });
  });

  it("leaves a message that does not mention the subject as it is", () => {
    const message: ModelMessage = { role: "assistant", content: "Nothing to see." };
    expect(scrubMessage(message, pattern)).toBe(message);
  });

  it("indexes person and organisation ids and hashed emails, nothing else", async () => {
    const refs = await conversationRefs([
      { text: "per_01JC9Z6X0V8M4T3K2Q1W5E7R9Y and org_01JC9Z6X0V8M4T3K2Q1W5E7R9Z" },
      { output: "tsk_01JC9Z6X0V8M4T3K2Q1W5E7R9Y, Ada@Example.com" },
    ]);
    expect(refs).toEqual([
      "per_01JC9Z6X0V8M4T3K2Q1W5E7R9Y",
      "org_01JC9Z6X0V8M4T3K2Q1W5E7R9Z",
      await emailRef("ada@example.com"),
    ]);
  });
});

/** Thread objects in memory: one thread per user, scrubbed like the DO does (scrubParts). */
function memoryStore(): AssistantThreadStore & {
  messages: Map<string, ThreadMessage[]>;
  calls: { userId: string; scrub: ConversationScrub }[];
} {
  const messages = new Map<string, ThreadMessage[]>();
  const calls: { userId: string; scrub: ConversationScrub }[] = [];
  return {
    messages,
    calls,
    async scrub(userId, scrub) {
      calls.push({ userId, scrub });
      const pattern = scrubPattern(scrub);
      messages.set(
        userId,
        (messages.get(userId) ?? []).map((m) => ({ ...m, parts: scrubParts(m.parts, pattern) })),
      );
    },
    async search() {
      return [];
    },
    async deliverRoutine() {
      return { outcome: "quiet" as const };
    },
    async postCard() {
      return { seq: 0 };
    },
    async deleteMessage() {
      return { deleted: [] };
    },
    async markSeen() {
      return { unread: 0, lastSeenSeq: 0 };
    },
  };
}

const text = (t: string): ThreadMessage["parts"] => [{ type: "text", text: t }];

/** A person's thread as their object would leave it after one turn: messages kept, refs indexed. */
async function thread(store: ReturnType<typeof memoryStore>, said: string, reply: string) {
  const user = await createUser("member");
  const opened = await invoke("thread.open", {}, context(user));
  const messages: ThreadMessage[] = [
    { seq: 1, turn: 1, role: "user", via: "text", parts: text(said), createdAt: "" },
    { seq: 2, turn: 1, role: "assistant", via: "text", parts: text(reply), createdAt: "" },
  ];
  store.messages.set(user.id, messages);
  await invoke(
    "thread.finishTurn",
    { id: opened.id, preview: reply, unread: 1, refs: await conversationRefs(messages) },
    context(user),
  );
  return { userId: user.id, threadId: opened.id };
}

async function refsOf(threadId: string) {
  const { results } = await env.DB.prepare(
    "SELECT ref FROM core_assistant_thread_refs WHERE thread_id = ?",
  )
    .bind(threadId)
    .all<{ ref: string }>();
  return results.map((r) => r.ref);
}

const words = (m: ThreadMessage[] | undefined) => m?.map((x) => x.parts);

describe("erase and assistant threads", () => {
  it("scrubs every thread that referenced the person, and only those", async () => {
    const store = memoryStore();
    const email = `${unique("grace")}@example.com`;
    const person = await invoke(
      "person.create",
      {
        givenName: "Grace",
        familyName: "Hopper",
        emails: [{ email }],
        phones: [{ number: "+1 555 0100 777" }],
      },
      context(member),
    );
    const byId = await thread(
      store,
      `Tell me about ${person.id}`,
      "Grace Hopper is a rear admiral.",
    );
    // Only her email: found through the hashed email ref.
    const byEmail = await thread(store, `Draft a note to ${email}`, "Done.");
    const unrelated = await thread(store, "Hello", "Hi Grace!");

    const out = await invoke(
      "person.erase",
      { id: person.id },
      context(admin, { assistantThreads: store }),
    );
    expect(out.conversationsScrubbed).toBe(2);
    expect(store.calls.map((c) => c.userId).sort()).toEqual([byId.userId, byEmail.userId].sort());
    expect(store.calls[0]?.scrub).toEqual({
      terms: expect.arrayContaining([person.id, email, "+1 555 0100 777"]),
      names: expect.arrayContaining(["Grace Hopper", "Grace", "Hopper"]),
    });
    expect(words(store.messages.get(byId.userId))).toEqual([
      text(`Tell me about ${ERASED}`),
      text(`${ERASED} is a rear admiral.`),
    ]);
    expect(words(store.messages.get(byEmail.userId))?.[0]).toEqual(
      text(`Draft a note to ${ERASED}`),
    );
    // Not referenced: untouched, even though it says "Grace".
    expect(words(store.messages.get(unrelated.userId))?.[1]).toEqual(text("Hi Grace!"));

    // The bookkeeping row (preview) and the index follow in the erase's batch.
    const row = await env.DB.prepare("SELECT preview FROM core_assistant_thread WHERE id = ?")
      .bind(byId.threadId)
      .first<{ preview: string }>();
    expect(row).toEqual({ preview: `${ERASED} is a rear admiral.` });
    expect(await refsOf(byId.threadId)).toEqual([]);
    expect(await refsOf(byEmail.threadId)).toEqual([]);
  });

  it("refuses to erase where threads that mention the person cannot be reached", async () => {
    const store = memoryStore();
    const person = await invoke("person.create", { givenName: "Kept" }, context(member));
    await thread(store, `About ${person.id}`, "Kept is fine.");
    await expect(invoke("person.erase", { id: person.id }, context(admin))).rejects.toMatchObject({
      code: "config",
    });
    // Nothing was erased: the person is still there.
    expect(await invoke("person.get", { id: person.id }, context(admin))).toMatchObject({
      id: person.id,
    });
  });

  it("an organisation erase scrubs its id and name", async () => {
    const store = memoryStore();
    const name = unique("Contoso");
    const org = await invoke("organisation.create", { name }, context(member));
    const t = await thread(store, `Open ${org.id}`, `${name} has 3 deals.`);
    const out = await invoke(
      "organisation.erase",
      { id: org.id },
      context(admin, { assistantThreads: store }),
    );
    expect(out.conversationsScrubbed).toBe(1);
    expect(words(store.messages.get(t.userId))).toEqual([
      text(`Open ${ERASED}`),
      text(`${ERASED} has 3 deals.`),
    ]);
  });
});
