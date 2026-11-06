// Cards in the person's thread (ADR 0346), end to end in workerd through their AssistantAgent
// Durable Object with the scripted model: a model's card streams and is stored with its fallback,
// the model reads only that fallback, an invalid card shows the words, and a saved producer's card
// lands in the thread with no model call at all.
import { env } from "cloudflare:workers";
import type { A2uiPart } from "@relationship-os/agent-a2ui";
import type { Principal } from "@relationship-os/auth";
import {
  type AssistantEvent,
  type AssistantThreadState,
  resolveActingUser,
  type TranscriptItem,
} from "@relationship-os/core";
import { createCrmDb } from "@relationship-os/db";
import { describe, expect, it } from "vitest";
import { type AssistantHttpEnv, handleState, handleTurn } from "../src/server/assistant/http.ts";
import { runOperation } from "../src/server/operations.ts";

const ORIGIN = "https://crm.test";
const appEnv = env as unknown as AssistantHttpEnv;
const db = createCrmDb(env.DB);

let n = 0;
async function member(): Promise<Principal> {
  n += 1;
  const principal: Principal = {
    userId: `auth-cards-${Date.now()}-${n}`,
    email: `cards-${Date.now()}-${n}@example.com`,
    name: `Card tester ${n}`,
    roles: [],
  };
  await resolveActingUser(db, principal);
  return principal;
}

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
  expect(response.status).toBe(200);
  return (await response.text())
    .split("\n\n")
    .map((frame) => frame.split("\n").find((l) => l.startsWith("data: ")))
    .filter((l): l is string => Boolean(l))
    .map((l) => JSON.parse(l.slice(6)) as AssistantEvent);
}

async function state(principal: Principal): Promise<AssistantThreadState> {
  const response = await handleState(
    new Request(`${ORIGIN}/api/assistant/thread`),
    appEnv,
    principal,
  );
  return (await response.json()) as AssistantThreadState;
}

const cards = (items: TranscriptItem[]) =>
  items.flatMap((i) => (i.kind === "card" ? [i.part] : [])) as A2uiPart[];

describe("cards in the thread", () => {
  it("streams a model's card and stores it with its fallback", async () => {
    const principal = await member();
    const events = await turn(principal, "Show me a card about renewals");
    const result = events.find((e) => e.type === "tool-result" && e.tool === "show_card");
    expect(result).toMatchObject({ card: { source: "model" } });
    const [stored] = cards((await state(principal)).items);
    expect(stored?.document?.root.type).toBe("card");
    expect(stored?.fallback).toContain("A card about renewals.");
    const replies = (await state(principal)).items.filter((i) => i.kind === "assistant");
    expect(replies.at(-1)).toMatchObject({ text: "Here it is." });
  });

  it("shows an invalid card as the model's words, stored with the reason", async () => {
    const principal = await member();
    await turn(principal, "Show me a broken card about renewals");
    const [stored] = cards((await state(principal)).items);
    expect(stored?.document).toBeNull();
    expect(stored?.fallback).toBe("Plain words about renewals.");
    expect(stored?.problems?.join()).toContain("unknown component marquee");
  });

  it("finds a card's words in search", async () => {
    const principal = await member();
    await turn(principal, "Show me a card about zebrafish");
    const out = (await runOperation(env as never, principal, {
      name: "thread.search",
      input: { query: "zebrafish" },
    })) as { ok: boolean; data: { hits: { role: string; text: string }[] } };
    expect(out.data.hits.map((h) => h.role)).toContain("tool");
  });

  it("posts a saved producer's card in the thread with no model call", async () => {
    const principal = await member();
    // A person who never chatted: there is no turn, no model, and the thread opens itself.
    const out = (await runOperation(env as never, principal, {
      name: "a2ui.produce",
      input: { producer: "tasks.overdueCard", post: true },
    })) as { ok: boolean; data: { part: A2uiPart; seq: number } };
    expect(out).toMatchObject({ ok: true, data: { part: { source: "producer" } } });
    const thread = await state(principal);
    expect(thread.items.map((i) => i.kind)).toEqual(["card"]);
    expect(cards(thread.items)[0]).toMatchObject({
      producer: "tasks.overdueCard@1",
      fallback: expect.stringContaining("From the stub runner"),
    });
    expect(thread.unread).toBe(1);
    expect(thread.running).toBeNull();
  });

  it("gives the model a posted card's words on the next turn, and a turn still works after", async () => {
    const principal = await member();
    await runOperation(env as never, principal, {
      name: "a2ui.produce",
      input: { producer: "tasks.overdueCard", post: true },
    });
    const events = await turn(principal, "Hello");
    expect(events.at(-1)).toMatchObject({ type: "turn-end", status: "done" });
    const kinds = (await state(principal)).items.map((i) => i.kind);
    expect(kinds).toEqual(["card", "user", "assistant"]);
  });

  it("indexes a posted card's records for erase", async () => {
    const principal = await member();
    await runOperation(env as never, principal, {
      name: "a2ui.produce",
      input: { producer: "tasks.overdueCard", post: true },
    });
    const refs = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_assistant_thread_refs WHERE ref = ?",
    )
      .bind("per_01KA8ZQ7Y2V3N4M5P6R7S8T9W0")
      .first<{ n: number }>();
    expect(refs?.n).toBeGreaterThan(0);
  });
});
