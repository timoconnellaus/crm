// A routine's message in the person's thread (ADR 0343), end to end in workerd through their
// AssistantAgent: "send me a morning briefing" gives a read-back with a backtest, a delivery holds
// the thing itself with buttons and the why facts, counts as unread, posts once per run, stays
// quiet when there is nothing to send, and a failure shows on the routine, not in the chat.
import { createMessageBatch, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { A2uiPart } from "@relationship-os/agent-a2ui";
import type { Principal } from "@relationship-os/auth";
import {
  type AssistantEvent,
  type AssistantThreadState,
  type RoutineDefinitionInput,
  type RoutineDeliveryMessage,
  resolveActingUser,
  routineDefinitionSchema,
  type TranscriptItem,
} from "@relationship-os/core";
import { createCrmDb } from "@relationship-os/db";
import { describe, expect, it } from "vitest";
import { type AssistantHttpEnv, handleState, handleTurn } from "../src/server/assistant/http.ts";
import { handleRoutineDeliveries } from "../src/server/assistant/routines.ts";
import { assistantThreadsFor, runOperation } from "../src/server/operations.ts";

const ORIGIN = "https://crm.test";
const appEnv = env as unknown as AssistantHttpEnv;
const db = createCrmDb(env.DB);

let n = 0;
async function member(): Promise<Principal> {
  n += 1;
  const principal: Principal = {
    userId: `auth-routines-${Date.now()}-${n}`,
    email: `routines-${Date.now()}-${n}@example.com`,
    name: `Routine tester ${n}`,
    roles: [],
  };
  await resolveActingUser(db, principal);
  return principal;
}

const userIdOf = async (principal: Principal) => (await resolveActingUser(db, principal)).id;

async function turn(principal: Principal, text: string): Promise<AssistantEvent[]> {
  const response = await handleTurn(
    new Request(`${ORIGIN}/api/assistant/turn`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ text }),
    }),
    appEnv,
    principal,
  );
  const body = await response.text();
  return body
    .split("\n\n")
    .filter((f) => f.includes("data: "))
    .map((f) => JSON.parse(f.slice(f.indexOf("data: ") + 6)) as AssistantEvent);
}

async function thread(principal: Principal): Promise<AssistantThreadState> {
  const response = await handleState(
    new Request(`${ORIGIN}/api/assistant/thread`),
    appEnv,
    principal,
  );
  return (await response.json()) as AssistantThreadState;
}

async function op(principal: Principal, name: string, input: unknown): Promise<unknown> {
  const out = await runOperation(env as never, principal, { name, input });
  if (!out.ok) throw new Error(out.error.message);
  return out.data;
}

const turnDefinition: RoutineDefinitionInput = {
  name: "Hello note",
  what: "say hello",
  trigger: { type: "schedule", cron: "0 8 * * 1-5" },
  message: { kind: "turn", prompt: "Say hello in one line." },
};

let drafts = 0;
async function create(principal: Principal, definition: RoutineDefinitionInput) {
  drafts += 1;
  const draftId = `rtn_01KA8ZQ7Y2V3N4M5P6R7S8T${String(drafts).padStart(3, "0")}`;
  const made = (await op(principal, "routine.create", {
    draftId: `${draftId}${Date.now()}`.slice(0, 40),
    definition: routineDefinitionSchema.parse(definition),
    asked: "say hello each morning",
  })) as { id: string };
  return made.id;
}

const deliver = async (principal: Principal, routineId: string, runId: string) =>
  assistantThreadsFor(appEnv)?.deliverRoutine(await userIdOf(principal), { routineId, runId });

function whyOf(item: TranscriptItem | undefined) {
  return item && (item.kind === "assistant" || item.kind === "card") ? item.why : undefined;
}

describe("asking for one in the chat", () => {
  it('"send me a morning briefing" shows a read-back with a backtest, and nothing is on', async () => {
    const person = await member();
    const events = await turn(person, "Send me a morning briefing");
    const card = events.find((e) => e.type === "tool-result" && e.card);
    const part = (card as { card?: A2uiPart }).card as A2uiPart;
    expect(part.source).toBe("host");
    expect(part.document?.root.type).toBe("routineReadBack");
    expect(part.fallback).toContain("Would have messaged you");
    const state = await thread(person);
    expect(state.items.some((i) => i.kind === "card")).toBe(true);
    const listed = (await op(person, "routine.list", {})) as { routines: unknown[] };
    expect(listed.routines).toEqual([]);
  });

  it("refuses a schedule under 15 minutes in the chat", async () => {
    const person = await member();
    const events = await turn(person, "check in with me every 5 minutes");
    const result = events.find((e) => e.type === "tool-result") as {
      isError: boolean;
      output: unknown;
    };
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.output)).toContain("shortest gap allowed is 15");
    expect(events.some((e) => e.type === "tool-result" && e.card)).toBe(false);
  });

  it("tells the model on the first chat only, in the tail", async () => {
    const person = await member();
    await turn(person, "hello");
    await turn(person, "hello again");
    const stub = appEnv.ASSISTANT?.getByName(`user:${await userIdOf(person)}`);
    const sent = await runInDurableObject(stub as never, async (_agent, state) =>
      state.storage.sql
        .exec<{ parts: string }>(
          "SELECT parts FROM thread_messages WHERE role = 'user' ORDER BY seq",
        )
        .toArray()
        .map((r) => r.parts),
    );
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain("offer_morning_briefing");
    expect(sent[1]).not.toContain("offer_morning_briefing");
  });
});

describe("delivery", () => {
  it("posts the message with buttons and the why, as a normal unread message", async () => {
    const person = await member();
    const routineId = await create(person, turnDefinition);
    const before = await thread(person);
    const delivered = await deliver(person, routineId, "arn_delivery_1");
    expect(delivered).toMatchObject({ outcome: "delivered" });
    const state = await thread(person);
    expect(state.unread).toBe(before.unread + 1);
    const reply = state.items.find((i) => i.kind === "assistant");
    expect(reply).toBeDefined();
    const buttons = state.items.findLast((i) => i.kind === "card");
    const labels = JSON.stringify((buttons as { part: A2uiPart }).part.document);
    expect(labels).toContain("Snooze");
    const why = whyOf(state.items.at(-1));
    expect(why).toMatchObject({
      routineId,
      runId: "arn_delivery_1",
      name: "Hello note",
      asked: "say hello each morning",
      checks: [],
      jev: [],
    });
    expect(why?.when).toBeTruthy();
    expect(JSON.stringify(why)).not.toMatch(/score|confidence|%/i);
    const row = await db.query
      .selectFrom("core_routine")
      .select(["last_delivered_at", "last_error"])
      .where("id", "=", routineId)
      .executeTakeFirstOrThrow();
    expect(row.last_delivered_at).toBeTruthy();
    expect(row.last_error).toBeNull();
  });

  it("posts once per run, however often the queue delivers it", async () => {
    const person = await member();
    const routineId = await create(person, turnDefinition);
    await deliver(person, routineId, "arn_delivery_2");
    const first = await thread(person);
    await deliver(person, routineId, "arn_delivery_2");
    const second = await thread(person);
    expect(second.items).toHaveLength(first.items.length);
  });

  it("delivers from the queue, and acks", async () => {
    const person = await member();
    const routineId = await create(person, turnDefinition);
    const batch = createMessageBatch<RoutineDeliveryMessage>("ros-routine-delivery", [
      {
        id: "m1",
        timestamp: new Date(),
        attempts: 1,
        body: { v: 1, routineId, runId: "arn_delivery_3", userId: await userIdOf(person) },
      },
    ]);
    await handleRoutineDeliveries(batch, appEnv);
    const state = await thread(person);
    expect(state.items.some((i) => whyOf(i)?.runId === "arn_delivery_3")).toBe(true);
  });

  it("a saved card is the message, with no model call", async () => {
    const person = await member();
    const routineId = await create(person, {
      ...turnDefinition,
      message: { kind: "producer", producer: "tasks.overdueCard", input: {} },
    });
    const delivered = await deliver(person, routineId, "arn_delivery_4");
    expect(delivered).toMatchObject({ outcome: "delivered" });
    const state = await thread(person);
    expect(state.items.filter((i) => i.kind === "assistant")).toEqual([]);
    expect(state.items.filter((i) => i.kind === "card")).toHaveLength(2);
  });

  it("a saved card with nothing in it sends nothing", async () => {
    const person = await member();
    const routineId = await create(person, {
      ...turnDefinition,
      message: { kind: "producer", producer: "briefing.morningCard", input: {} },
    });
    expect(await deliver(person, routineId, "arn_delivery_6")).toEqual({ outcome: "quiet" });
    expect((await thread(person)).items).toEqual([]);
  });

  it("Test sends it marked as a test, and a miss sends nothing", async () => {
    const person = await member();
    const routineId = await create(person, turnDefinition);
    const sent = (await op(person, "routine.test", { id: routineId })) as { sent: boolean };
    expect(sent.sent).toBe(true);
    const state = await thread(person);
    expect(whyOf(state.items.at(-1))).toMatchObject({ test: true, runId: null });

    const quiet = await create(person, {
      ...turnDefinition,
      name: "Nothing yet",
      exists: [{ object: "task", filter: { field: "title", op: "eq", value: "no such task" } }],
    });
    const miss = (await op(person, "routine.test", { id: quiet })) as {
      sent: boolean;
      reason: string;
    };
    expect(miss).toMatchObject({ sent: false, reason: "There was nothing to send" });
  });

  it("what cannot be made shows on the routine as failing, not in the chat", async () => {
    const person = await member();
    const routineId = await create(person, turnDefinition);
    await db.query
      .updateTable("core_routine")
      .set({ definition: "{}" })
      .where("id", "=", routineId)
      .execute();
    const delivered = await deliver(person, routineId, "arn_delivery_5");
    expect(delivered).toMatchObject({ outcome: "failed" });
    const listed = (await op(person, "routine.list", {})) as {
      routines: { id: string; status: string }[];
    };
    expect(listed.routines.find((r) => r.id === routineId)?.status).toBe("failing");
    expect((await thread(person)).items.some((i) => i.kind === "assistant")).toBe(false);
  });
});
