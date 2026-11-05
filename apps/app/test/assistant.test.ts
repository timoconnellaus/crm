// The in-app assistant end to end in workerd (ADR 0030, ADR 0200): /api/assistant/* over the
// conversation Durable Object, which acts as actor `assistant` through our own MCP server, with
// the scripted stand-in model (AI_FAKE_MODEL). Covers the page context (AC 4), the pipeline as
// for MCP (gate, pending actions in the conversation's change set, audit; AC 3), approving inline,
// building a dashboard widget, history and ownership.
import { env } from "cloudflare:workers";
import type { Principal } from "@relationship-os/auth";
import {
  type AssistantConversationState,
  type AssistantEvent,
  invokeByName,
  resolveActingUser,
} from "@relationship-os/core";
import { createCrmDb } from "@relationship-os/db";
import { describe, expect, it } from "vitest";
import {
  type AssistantHttpEnv,
  handleDelete,
  handleState,
  handleStream,
  handleTurn,
} from "../src/server/assistant/http.ts";

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
  const id = response.headers.get("x-conversation-id") ?? "";
  if (response.status !== 200) return { id, events: [], status: response.status };
  return { id, events: await readEvents(response), status: 200 };
}

async function createPerson(user: Awaited<ReturnType<typeof member>>["user"], name: string) {
  return (await invokeByName(
    "person.create",
    { givenName: name, familyName: `Test${Date.now()}` },
    human(user),
  )) as { id: string; displayName: string };
}

describe("the in-app assistant", () => {
  it("answers about the record the person is looking at (context)", async () => {
    const { principal, user } = await member();
    const ada = await createPerson(user, "Ada");
    const { id, events, status } = await turn(principal, {
      text: "Summarise this person",
      context: { path: `/people/${ada.id}`, record: { object: "person", id: ada.id } },
    });
    expect(status).toBe(200);
    expect(id).toMatch(/^asc_/);
    const call = events.find((e) => e.type === "tool-call");
    expect(call).toMatchObject({ tool: "person_get", input: { id: ada.id } });
    const result = events.find((e) => e.type === "tool-result");
    expect(result).toMatchObject({ isError: false, output: { id: ada.id } });
    expect(events.at(-1)).toMatchObject({ type: "turn-end", status: "done" });
    const text = events
      .filter((e) => e.type === "text")
      .map((e) => (e as { delta: string }).delta)
      .join("");
    expect(text).toContain("Here is what I found about Ada");
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
    const text = events
      .filter((e) => e.type === "text")
      .map((e) => (e as { delta: string }).delta)
      .join("");
    expect(text).toBe("You selected 3 organisation records: org_a1, org_b2, org_c3.");
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
    // Not applied until a person approves it, inline or in the inbox.
    const person = await invokeByName("person.get", { id: grace.id }, human(user));
    expect(person).toMatchObject({ id: grace.id });
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
    const taskId = (result.output as { id: string }).id;
    const row = await env.DB.prepare(
      "SELECT actor FROM core_audit WHERE operation = 'task.create' AND user_id = ? ORDER BY at DESC LIMIT 1",
    )
      .bind(user.id)
      .first<{ actor: string }>();
    expect(row?.actor).toBe("assistant");
    expect(taskId).toMatch(/^tsk_/);
  });

  it("builds a dashboard widget", async () => {
    const { principal, user } = await member();
    const { events } = await turn(principal, {
      text: "Build a dashboard widget of tasks by status",
    });
    const call = events.find((e) => e.type === "tool-call");
    expect(call).toMatchObject({ tool: "call_operation", input: { name: "dashboard.create" } });
    const result = events.find((e) => e.type === "tool-result") as Extract<
      AssistantEvent,
      { type: "tool-result" }
    >;
    expect(result.isError).toBe(false);
    const dashboards = (await invokeByName("dashboard.list", {}, human(user))) as {
      items: { title: string }[];
    };
    expect(dashboards.items.map((d) => d.title)).toContain("Tasks by status dashboard");
  });

  it("keeps the conversation: history, a second turn, and nobody else can read it", async () => {
    const { principal, user } = await member();
    const first = await turn(principal, { text: "Hello" });
    const second = await turn(principal, { conversationId: first.id, text: "Hello again" });
    expect(second.id).toBe(first.id);
    expect(second.events[0]).toMatchObject({ type: "turn-start", turn: 2 });
    const state = (await (
      await handleState(appEnv, principal, first.id)
    ).json()) as AssistantConversationState;
    expect(state.running).toBeNull();
    expect(state.items.filter((i) => i.kind === "user").map((i) => i.text)).toEqual([
      "Hello",
      "Hello again",
    ]);
    expect(state.items.filter((i) => i.kind === "assistant")).toHaveLength(2);
    const list = (await invokeByName("assistant.conversations", {}, human(user))) as {
      conversations: { id: string; turns: number }[];
    };
    expect(list.conversations.find((c) => c.id === first.id)?.turns).toBe(2);

    const other = await member();
    expect((await handleState(appEnv, other.principal, first.id)).status).toBe(404);
    expect((await turn(other.principal, { conversationId: first.id, text: "hi" })).status).toBe(
      404,
    );
    // No turn running: nothing to resume.
    expect((await handleStream(appEnv, principal, first.id, 0)).status).toBe(204);

    const deleted = await handleDelete(
      new Request(`${ORIGIN}/api/assistant/conversations/${first.id}`, {
        method: "DELETE",
        headers: { origin: ORIGIN },
      }),
      appEnv,
      principal,
      first.id,
    );
    expect(deleted.status).toBe(200);
    expect((await handleState(appEnv, principal, first.id)).status).toBe(404);
  });

  it("refuses cross-site turns and anonymous callers", async () => {
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
});
