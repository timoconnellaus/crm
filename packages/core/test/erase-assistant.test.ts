// person.erase / organisation.erase and in-app assistant conversations (ADR 0019 and ADR 0200
// amendments, 2026-11-05): conversations are found through the ref index finishTurn writes, each
// is scrubbed through the conversation store before the erase commits, and their list rows and the
// subject's refs follow in the erase's batch. The store here keeps messages in memory and applies
// the same scrubMessage the Durable Object does (apps/app/test/assistant.test.ts runs the real one).
import { env } from "cloudflare:workers";
import type { ModelMessage } from "ai";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  type AssistantConversationStore,
  type ConversationScrub,
  conversationRefs,
  ERASED,
  emailRef,
  invoke,
  scrubMessage,
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

/** Conversation objects in memory: stored messages per conversation, scrubbed like the DO does. */
function memoryStore(): AssistantConversationStore & {
  messages: Map<string, ModelMessage[]>;
  calls: { id: string; scrub: ConversationScrub }[];
} {
  const messages = new Map<string, ModelMessage[]>();
  const calls: { id: string; scrub: ConversationScrub }[] = [];
  return {
    messages,
    calls,
    async scrub(id, scrub) {
      calls.push({ id, scrub });
      const pattern = scrubPattern(scrub);
      messages.set(
        id,
        (messages.get(id) ?? []).map((m) => scrubMessage(m, pattern)),
      );
    },
  };
}

/** A conversation as the object would leave it after one turn: messages kept, refs indexed. */
async function conversation(
  store: ReturnType<typeof memoryStore>,
  user: ActingUser,
  text: string,
  reply: string,
) {
  const started = await invoke("assistant.startConversation", { text }, context(user));
  const messages: ModelMessage[] = [
    { role: "user", content: text },
    { role: "assistant", content: reply },
  ];
  store.messages.set(started.id, messages);
  await invoke(
    "assistant.finishTurn",
    { id: started.id, preview: reply, refs: await conversationRefs(messages) },
    context(user),
  );
  return started.id;
}

async function refsOf(conversationId: string) {
  const { results } = await env.DB.prepare(
    "SELECT ref FROM core_assistant_conversation_refs WHERE conversation_id = ?",
  )
    .bind(conversationId)
    .all<{ ref: string }>();
  return results.map((r) => r.ref);
}

describe("erase and assistant conversations", () => {
  it("scrubs every conversation that referenced the person, and only those", async () => {
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
    const byId = await conversation(
      store,
      member,
      `Tell me about ${person.id}`,
      "Grace Hopper is a rear admiral.",
    );
    // Only her email: found through the hashed email ref.
    const byEmail = await conversation(store, member, `Draft a note to ${email}`, "Done.");
    const unrelated = await conversation(store, member, "Hello", "Hi Grace!");
    const deleted = await conversation(store, member, `About ${person.id}`, "Sure.");
    await invoke("assistant.deleteConversation", { id: deleted }, context(member));
    expect(await refsOf(deleted)).toEqual([]);

    const out = await invoke(
      "person.erase",
      { id: person.id },
      context(admin, { assistantConversations: store }),
    );
    expect(out.conversationsScrubbed).toBe(2);
    expect(store.calls.map((c) => c.id).sort()).toEqual([byId, byEmail].sort());
    expect(store.calls[0]?.scrub).toEqual({
      terms: expect.arrayContaining([person.id, email, "+1 555 0100 777"]),
      names: expect.arrayContaining(["Grace Hopper", "Grace", "Hopper"]),
    });
    expect(store.messages.get(byId)).toEqual([
      { role: "user", content: `Tell me about ${ERASED}` },
      { role: "assistant", content: `${ERASED} is a rear admiral.` },
    ]);
    expect(store.messages.get(byEmail)?.[0]).toEqual({
      role: "user",
      content: `Draft a note to ${ERASED}`,
    });
    // Not referenced: untouched, even though it says "Grace".
    expect(store.messages.get(unrelated)?.[1]).toEqual({ role: "assistant", content: "Hi Grace!" });

    // The list rows (title, preview) and the index follow in the erase's batch.
    const row = await env.DB.prepare(
      "SELECT title, preview FROM core_assistant_conversation WHERE id = ?",
    )
      .bind(byId)
      .first<{ title: string; preview: string }>();
    expect(row).toEqual({
      title: `Tell me about ${ERASED}`,
      preview: `${ERASED} is a rear admiral.`,
    });
    expect(await refsOf(byId)).toEqual([]);
    expect(await refsOf(byEmail)).toEqual([]);
  });

  it("refuses to erase where conversations that mention the person cannot be reached", async () => {
    const store = memoryStore();
    const person = await invoke("person.create", { givenName: "Kept" }, context(member));
    await conversation(store, member, `About ${person.id}`, "Kept is fine.");
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
    const id = await conversation(store, member, `Open ${org.id}`, `${name} has 3 deals.`);
    const out = await invoke(
      "organisation.erase",
      { id: org.id },
      context(admin, { assistantConversations: store }),
    );
    expect(out.conversationsScrubbed).toBe(1);
    expect(store.messages.get(id)).toEqual([
      { role: "user", content: `Open ${ERASED}` },
      { role: "assistant", content: `${ERASED} has 3 deals.` },
    ]);
  });
});
