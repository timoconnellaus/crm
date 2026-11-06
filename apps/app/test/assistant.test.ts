// The in-app assistant end to end in workerd (ADR 0030, ADR 0200, ADR 0340): /api/assistant/*
// and the WebSocket over the person's one AssistantAgent Durable Object, which acts as actor
// `assistant` through our own MCP server, with the scripted stand-in model (AI_FAKE_MODEL).
// Covers the page context in the tail, the pipeline as for MCP (gate, pending actions in the
// thread's change set, audit), one thread per user that survives the object restarting and is
// shared by two devices, a byte-stable prefix across turns, search, delete, unread, and erase.
import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import type { Principal } from "@relationship-os/auth";
import {
  type AssistantEvent,
  type AssistantThreadState,
  invokeByName,
  resolveActingUser,
  type ThreadServerFrame,
} from "@relationship-os/core";
import { createCrmDb } from "@relationship-os/db";
import { describe, expect, it } from "vitest";
import {
  type AssistantHttpEnv,
  handleSocket,
  handleState,
  handleStream,
  handleTurn,
  threadStub,
} from "../src/server/assistant/http.ts";
import { runOperation } from "../src/server/operations.ts";

const ORIGIN = "https://crm.test";
const appEnv = env as unknown as AssistantHttpEnv;
const db = createCrmDb(env.DB);

let n = 0;
async function member(role: "member" | "admin" = "member") {
  n += 1;
  const principal: Principal = {
    userId: `auth-${Date.now()}-${n}`,
    email: `assistant-${Date.now()}-${n}@example.com`,
    name: `Assistant tester ${n}`,
    roles: [],
  };
  const user = await resolveActingUser(db, principal);
  await env.DB.prepare("UPDATE core_user SET role = ? WHERE id = ?").bind(role, user.id).run();
  return { principal, user: { ...user, role } };
}

function human(user: Awaited<ReturnType<typeof member>>["user"]) {
  return { actor: "human" as const, user, origin: { surface: "ui" as const }, db };
}

async function readEvents(response: Response): Promise<AssistantEvent[]> {
  const text = await response.text();
  return text
    .split("\n\n")
    .map((frame) => frame.split("\n").find((l) => l.startsWith("data: ")))
    .filter((l): l is string => Boolean(l))
    .map((l) => JSON.parse(l.slice(6)) as AssistantEvent);
}

async function turn(
  principal: Principal,
  body: Record<string, unknown>,
): Promise<{ id: string; events: AssistantEvent[]; status: number }> {
  const response = await handleTurn(
    new Request(`${ORIGIN}/api/assistant/turn`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify(body),
    }),
    appEnv,
    principal,
  );
  const id = response.headers.get("x-thread-id") ?? "";
  if (response.status !== 200) return { id, events: [], status: response.status };
  const events = await readEvents(response);
  return { id: id || ((await state(principal)).id ?? ""), events, status: 200 };
}

async function state(principal: Principal, query = ""): Promise<AssistantThreadState> {
  const response = await handleState(
    new Request(`${ORIGIN}/api/assistant/thread${query}`),
    appEnv,
    principal,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as AssistantThreadState;
}

function replyText(events: AssistantEvent[]): string {
  return events
    .filter((e) => e.type === "text")
    .map((e) => (e as { delta: string }).delta)
    .join("");
}

async function createPerson(user: Awaited<ReturnType<typeof member>>["user"], name: string) {
  return (await invokeByName(
    "person.create",
    { givenName: name, familyName: `Test${Date.now()}` },
    human(user),
  )) as { id: string; displayName: string };
}

/** A device's WebSocket to the thread, collecting what the server sends. */
async function device(principal: Principal) {
  const response = await handleSocket(
    new Request(`${ORIGIN}/api/assistant/socket`, {
      headers: { upgrade: "websocket", origin: ORIGIN },
    }),
    appEnv,
    principal,
  );
  expect(response.status).toBe(101);
  const ws = response.webSocket;
  if (!ws) throw new Error("no WebSocket");
  ws.accept();
  const frames: ThreadServerFrame[] = [];
  const waiters: { test: (f: ThreadServerFrame) => boolean; resolve: (f: ThreadServerFrame) => void }[] =
    [];
  ws.addEventListener("message", (message) => {
    const frame = JSON.parse(String(message.data)) as ThreadServerFrame;
    frames.push(frame);
    for (const w of [...waiters]) {
      if (w.test(frame)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(frame);
      }
    }
  });
  const next = (test: (f: ThreadServerFrame) => boolean, from = 0) =>
    new Promise<ThreadServerFrame>((resolve, reject) => {
      const seen = frames.slice(from).find(test);
      if (seen) return resolve(seen);
      waiters.push({ test, resolve });
      setTimeout(() => reject(new Error("timed out waiting for a frame")), 10_000);
    });
  return { ws, frames, next, send: (frame: unknown) => ws.send(JSON.stringify(frame)) };
}

describe("the in-app assistant", () => {
  it("answers about the record the person is looking at (context in the tail)", async () => {
    const { principal, user } = await member();
    const ada = await createPerson(user, "Ada");
    const { id, events, status } = await turn(principal, {
      text: "Summarise this person",
      context: { path: `/people/${ada.id}`, record: { object: "person", id: ada.id } },
    });
    expect(status).toBe(200);
    expect(id).toMatch(/^ath_/);
    const call = events.find((e) => e.type === "tool-call");
    expect(call).toMatchObject({ tool: "person_get", input: { id: ada.id } });
    const result = events.find((e) => e.type === "tool-result");
    expect(result).toMatchObject({ isError: false, output: { id: ada.id } });
    expect(events.at(-1)).toMatchObject({ type: "turn-end", status: "done" });
    expect(replyText(events)).toContain("Here is what I found about Ada");
    // The person sees only their words, never the tail block.
    expect((await state(principal)).items[0]).toMatchObject({
      kind: "user",
      text: "Summarise this person",
    });
  });

  it("uses exactly the list selection it is given", async () => {
    const { principal } = await member();
    const { events } = await turn(principal, {
      text: "What do these have in common?",
      context: {
        path: "/organisations",
        selection: { object: "organisation", ids: ["org_a1", "org_b2", "org_c3"] },
      },
    });
    expect(replyText(events)).toBe("You selected 3 organisation records: org_a1, org_b2, org_c3.");
  });

  it("acts as actor `assistant` through the pipeline: a gated change waits in its change set", async () => {
    const { principal, user } = await member();
    const grace = await createPerson(user, "Grace");
    const { id, events } = await turn(principal, {
      text: "Delete this person",
      context: { path: `/people/${grace.id}`, record: { object: "person", id: grace.id } },
    });
    const result = events.find((e) => e.type === "tool-result") as Extract<
      AssistantEvent,
      { type: "tool-result" }
    >;
    // Balanced: destructive changes by the assistant go to review.
    expect(result.pending).toMatchObject({ operation: "person.delete" });
    const action = await env.DB.prepare(
      "SELECT a.actor, a.status, s.session_id, s.actor AS set_actor FROM core_pending_action a JOIN core_change_set s ON s.id = a.change_set_id WHERE a.id = ?",
    )
      .bind(result.pending?.actionId)
      .first<{ actor: string; status: string; session_id: string; set_actor: string }>();
    // The thread is the assistant's MCP session.
    expect(action).toEqual({
      actor: "assistant",
      status: "pending",
      session_id: id,
      set_actor: "assistant",
    });
    const audit = await env.DB.prepare(
      "SELECT actor, gate_decision AS gate, outcome, origin FROM core_audit WHERE operation = 'person.delete' AND user_id = ? ORDER BY at DESC LIMIT 1",
    )
      .bind(user.id)
      .first<{ actor: string; gate: string; outcome: string; origin: string }>();
    expect(audit).toMatchObject({ actor: "assistant", gate: "review", outcome: "review" });
    expect(JSON.parse(audit?.origin ?? "{}")).toEqual({ surface: "assistant", sessionId: id });
    const approved = (await invokeByName(
      "approval.approve",
      { actionIds: [result.pending?.actionId] },
      human(user),
    )) as { results: { status: string }[] };
    expect(approved.results[0]?.status).toBe("applied");
    await expect(invokeByName("person.get", { id: grace.id }, human(user))).rejects.toThrow();
  });

  it("applies an ungated write straight away, audited as the assistant", async () => {
    const { principal, user } = await member();
    const { events } = await turn(principal, { text: "Create a task to send the proposal" });
    const result = events.find((e) => e.type === "tool-result") as Extract<
      AssistantEvent,
      { type: "tool-result" }
    >;
    expect(result).toMatchObject({ tool: "task_create", isError: false });
    expect(result.pending).toBeUndefined();
    const row = await env.DB.prepare(
      "SELECT actor FROM core_audit WHERE operation = 'task.create' AND user_id = ? ORDER BY at DESC LIMIT 1",
    )
      .bind(user.id)
      .first<{ actor: string }>();
    expect(row?.actor).toBe("assistant");
  });

  it("builds a dashboard widget", async () => {
    const { principal, user } = await member();
    const { events } = await turn(principal, {
      text: "Build a dashboard widget of tasks by status",
    });
    const call = events.find((e) => e.type === "tool-call");
    expect(call).toMatchObject({ tool: "call_operation", input: { name: "dashboard.create" } });
    const dashboards = (await invokeByName("dashboard.list", {}, human(user))) as {
      items: { title: string }[];
    };
    expect(dashboards.items.map((d) => d.title)).toContain("Tasks by status dashboard");
  });

  it("keeps one thread per user that survives the object restarting", async () => {
    const { principal, user } = await member();
    const first = await turn(principal, { text: "Hello" });
    // The object is evicted (a deploy, or idle): the thread is still there.
    const stub = await threadStub(appEnv.ASSISTANT as never, user.id);
    await evictDurableObject(stub as never);
    const second = await turn(principal, { text: "Hello again" });
    expect(second.id).toBe(first.id);
    expect(second.events[0]).toMatchObject({ type: "turn-start", turn: 2 });
    const thread = await state(principal);
    expect(thread.running).toBeNull();
    expect(thread.items.filter((i) => i.kind === "user").map((i) => i.text)).toEqual([
      "Hello",
      "Hello again",
    ]);
    expect(thread.items.filter((i) => i.kind === "assistant")).toHaveLength(2);
    expect(thread.items.every((i) => typeof i.seq === "number")).toBe(true);
    expect(await invokeByName("thread.status", {}, human(user))).toMatchObject({ id: first.id });
    const row = await env.DB.prepare("SELECT turns FROM core_assistant_thread WHERE id = ?")
      .bind(first.id)
      .first<{ turns: number }>();
    expect(row?.turns).toBe(2);

    // Someone else has their own, empty thread.
    const other = await member();
    expect((await state(other.principal)).items).toEqual([]);
    // No turn running: nothing to resume.
    expect((await handleStream(appEnv, principal, 0)).status).toBe(204);
  });

  it("keeps the prefix byte-stable across turns while the page changes (ADR 0341)", async () => {
    const { principal, user } = await member();
    const ada = await createPerson(user, "Ada");
    await turn(principal, { text: "Hello", context: { path: "/" } });
    await turn(principal, {
      text: "Summarise this person",
      context: { path: `/people/${ada.id}`, record: { object: "person", id: ada.id } },
    });
    await turn(principal, { text: "Thanks", context: { path: "/tasks", title: "Tasks" } });
    const stub = await threadStub(appEnv.ASSISTANT as never, user.id);
    const hashes = await stub.prefixHashes(user.id);
    expect(hashes).toHaveLength(3);
    expect(hashes[0]?.prefixHash).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(hashes.map((h) => h.prefixHash)).size).toBe(1);
  });

  it("shows the same thread on two devices, live", async () => {
    const { principal } = await member();
    const phone = await device(principal);
    const laptop = await device(principal);
    await phone.next((f) => f.type === "state");
    await laptop.next((f) => f.type === "state");
    laptop.send({ type: "visible", visible: true });
    phone.send({ type: "send", text: "Hello from my phone", context: { path: "/" } });
    // The laptop sees the turn start and end although the phone sent it.
    const start = await laptop.next((f) => f.type === "event" && f.event.type === "turn-start");
    expect(start).toMatchObject({ event: { text: "Hello from my phone" } });
    await laptop.next((f) => f.type === "event" && f.event.type === "turn-end");
    await phone.next((f) => f.type === "event" && f.event.type === "turn-end");
    // The laptop had the chat on screen: the reply arrived already seen.
    const unread = (await phone.next((f) => f.type === "unread")) as Extract<
      ThreadServerFrame,
      { type: "unread" }
    >;
    expect(unread.unread).toBe(0);
    // Both read the same stored thread.
    const mark = laptop.frames.length;
    laptop.send({ type: "sync" });
    const synced = (await laptop.next((f) => f.type === "state", mark)) as Extract<
      ThreadServerFrame,
      { type: "state" }
    >;
    expect(synced.state.items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(synced.state.items)).toEqual(JSON.stringify((await state(principal)).items));
    phone.ws.close();
    laptop.ws.close();
  });

  it("counts unread replies and clears them when seen", async () => {
    const { principal, user } = await member();
    await turn(principal, { text: "Hello" });
    expect(await invokeByName("thread.status", {}, human(user))).toMatchObject({ unread: 1 });
    expect((await state(principal)).unread).toBe(1);
    const seen = await runOperation(env as never, principal, { name: "thread.markSeen", input: {} });
    expect(seen).toMatchObject({ ok: true, data: { unread: 0 } });
    expect(await invokeByName("thread.status", {}, human(user))).toMatchObject({ unread: 0 });
  });

  it("searches the thread and deletes a message from it and from search", async () => {
    const { principal } = await member();
    await turn(principal, { text: "Has Kestrel sent the NDA back?" });
    await turn(principal, { text: "Remind me to chase the Kestrel NDA on Friday" });
    const search = async (query: string) =>
      (await runOperation(env as never, principal, {
        name: "thread.search",
        input: { query },
      })) as { ok: boolean; data: { hits: { seq: number; role: string; text: string }[] } };
    const hits = (await search("kestrel nda")).data.hits;
    expect(hits.map((h) => h.text)).toEqual([
      "Remind me to chase the Kestrel NDA on Friday",
      "Has Kestrel sent the NDA back?",
    ]);
    const target = hits[1]?.seq ?? 0;
    const deleted = await runOperation(env as never, principal, {
      name: "thread.deleteMessage",
      input: { seq: target },
    });
    expect(deleted).toMatchObject({ ok: true, data: { deleted: [target] } });
    expect((await search("kestrel nda")).data.hits).toHaveLength(1);
    const thread = await state(principal);
    expect(thread.items.find((i) => i.seq === target)).toBeUndefined();
    // A whole reply goes at once.
    const reply = thread.items.find((i) => i.kind === "assistant");
    const gone = await runOperation(env as never, principal, {
      name: "thread.deleteMessage",
      input: { seq: reply?.seq ?? 0 },
    });
    expect(gone).toMatchObject({ ok: true });
    expect((await state(principal)).items.filter((i) => i.kind === "assistant")).toHaveLength(1);
  });

  it("refuses cross-site turns and sockets, and anonymous callers", async () => {
    const { principal } = await member();
    const cross = await handleTurn(
      new Request(`${ORIGIN}/api/assistant/turn`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.test" },
        body: JSON.stringify({ text: "hi" }),
      }),
      appEnv,
      principal,
    );
    expect(cross.status).toBe(403);
    const socket = await handleSocket(
      new Request(`${ORIGIN}/api/assistant/socket`, {
        headers: { upgrade: "websocket", origin: "https://evil.test" },
      }),
      appEnv,
      principal,
    );
    expect(socket.status).toBe(403);
    const anonymous = await handleTurn(
      new Request(`${ORIGIN}/api/assistant/turn`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ text: "hi" }),
      }),
      appEnv,
      null,
    );
    expect(anonymous.status).toBe(401);
  });

  it("erasing a person scrubs them from the threads that referenced them", async () => {
    const { principal, user } = await member();
    const admin = await member("admin");
    const family = `Erasable${Date.now()}`;
    const email = `zelda-${Date.now()}@example.com`;
    const zelda = (await invokeByName(
      "person.create",
      { givenName: "Zelda", familyName: family, emails: [{ email }] },
      human(user),
    )) as { id: string };
    const { id } = await turn(principal, {
      text: "Summarise this person",
      context: { path: `/people/${zelda.id}`, record: { object: "person", id: zelda.id } },
    });
    // Another person's thread, about nobody: left alone.
    const bystander = await member();
    await turn(bystander.principal, { text: "Hello" });

    // The once-per-turn bookkeeping indexed what the turn referenced.
    const refs = async (threadId: string) =>
      (
        await env.DB.prepare("SELECT ref FROM core_assistant_thread_refs WHERE thread_id = ?")
          .bind(threadId)
          .all<{ ref: string }>()
      ).results.map((r) => r.ref);
    expect(await refs(id)).toContain(zelda.id);
    expect((await refs(id)).some((r) => r.startsWith("email:"))).toBe(true);
    const before = JSON.stringify(await state(principal));
    expect(before).toContain(zelda.id);
    expect(before).toContain("Zelda");
    const untouched = JSON.stringify(await state(bystander.principal));

    const erased = await runOperation(env as never, admin.principal, {
      name: "person.erase",
      input: { id: zelda.id },
    });
    expect(erased).toMatchObject({ ok: true, data: { conversationsScrubbed: 1 } });

    const after = await state(principal);
    const text = JSON.stringify(after);
    for (const gone of [zelda.id, email, "Zelda", family]) expect(text).not.toContain(gone);
    expect(after.items.find((i) => i.kind === "user")).toMatchObject({
      text: "Summarise this person",
    });
    expect(after.items.find((i) => i.kind === "tool")).toMatchObject({
      tool: "person_get",
      input: { erased: true },
      output: "[erased]",
    });
    expect(after.items.find((i) => i.kind === "assistant")?.text).toContain("[erased]");
    // The stored tail block (page context naming her) is scrubbed too: search cannot find her.
    const found = (await runOperation(env as never, principal, {
      name: "thread.search",
      input: { query: "Zelda" },
    })) as unknown as { data: { hits: unknown[] } };
    expect(found.data.hits).toEqual([]);
    expect(await refs(id)).toEqual([]);
    expect(JSON.stringify(await state(bystander.principal))).toBe(untouched);
  });
});
