// Assistant memory end to end in workerd (ADR 0342, stage 17 acceptance criteria 4, 5 and 14):
// the person's AssistantAgent Durable Object, its in-process MCP tools and the scripted model, over
// real D1. The stand-in judge answers `memory.write` and `memory.condition` (AI_FAKE_MODEL).
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Principal } from "@relationship-os/auth";
import {
  type AssistantEvent,
  type AssistantThreadState,
  type CoreOutput,
  invokeByName,
  memoryForAgent,
  memoryForTurn,
  memorySaveOf,
  resolveActingUser,
  type ThreadMemoryState,
} from "@relationship-os/core";
import { createCrmDb } from "@relationship-os/db";
import { describe, expect, it } from "vitest";
import {
  type AssistantHttpEnv,
  handleState,
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
    userId: `auth-mem-${Date.now()}-${n}`,
    email: `memory-${Date.now()}-${n}@example.com`,
    name: `Memory tester ${n}`,
    roles: [],
  };
  const user = await resolveActingUser(db, principal);
  await env.DB.prepare("UPDATE core_user SET role = ? WHERE id = ?").bind(role, user.id).run();
  return { principal, user: { ...user, role } };
}

type Member = Awaited<ReturnType<typeof member>>;

const human = (user: Member["user"]) => ({
  actor: "human" as const,
  user,
  origin: { surface: "ui" as const },
  db,
});

async function turn(principal: Principal, body: Record<string, unknown>) {
  const response = await handleTurn(
    new Request(`${ORIGIN}/api/assistant/turn`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify(body),
    }),
    appEnv,
    principal,
  );
  expect(response.status).toBe(200);
  const text = await response.text();
  return text
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

const toolOutputs = (events: AssistantEvent[]) =>
  events.flatMap((e) => (e.type === "tool-result" ? [e.output] : []));

const list = (user: Member["user"]) =>
  invokeByName("memory.list", {}, human(user)) as Promise<CoreOutput<"memory.list">>;

const stubOf = (m: Member) => threadStub(appEnv.ASSISTANT as never, m.user.id);

/** What the person's newest message was sent with: the stored parts, tail and all. */
async function newestSent(m: Member): Promise<string> {
  return runInDurableObject(await stubOf(m), async (_o, s: DurableObjectState) => {
    const row = s.storage.sql
      .exec<{ parts: string }>(
        "SELECT parts FROM thread_messages WHERE role = 'user' ORDER BY seq DESC LIMIT 1",
      )
      .toArray()[0];
    return row?.parts ?? "";
  });
}

/** Compaction's hook, as it is called just before a compaction commits. */
const fold = async (m: Member) =>
  runInDurableObject(await stubOf(m), (agent: unknown) =>
    (agent as { foldPendingLines(): Promise<void> }).foldPendingLines(),
  );

/** The memory block the thread's next turn sends in its prefix. */
async function memoryBlock(m: Member): Promise<string | undefined> {
  const raw = await runInDurableObject(await stubOf(m), async (_o, s: DurableObjectState) => {
    return s.storage.sql
      .exec<{ value: string }>("SELECT value FROM thread_meta WHERE key = 'memory'")
      .toArray()[0]?.value;
  });
  const state = JSON.parse(raw ?? "null") as ThreadMemoryState;
  return (await memoryForTurn(db.query, m.user.id, { state })).block;
}

const prefixes = async (m: Member) =>
  (await (await stubOf(m)).prefixHashes(m.user.id)).map((r) => r.prefixHash);

describe("memory in the chat", () => {
  it("saves inline, shows the saved line, and the next agent and turn see it", async () => {
    const m = await member();
    const events = await turn(m.principal, { text: "remember I prefer calls before 10" });
    const save = toolOutputs(events).map(memorySaveOf).find(Boolean);
    expect(save).toMatchObject({
      result: "saved",
      line: { text: "I prefer calls before 10", status: "active" },
    });
    expect(save?.line.source?.messageSeq).toBeGreaterThan(0);

    // The saved line survives a reload: the transcript holds the tool result.
    const reloaded = await state(m.principal);
    const tool = reloaded.items.find((i) => i.kind === "tool");
    expect(memorySaveOf(tool?.kind === "tool" ? tool.output : null)?.line.id).toBe(save?.line.id);

    // An agent started now sees it.
    expect(await memoryForAgent(db.query, m.user.id)).toContain("I prefer calls before 10");
  });

  it("puts a line saved mid-chat in the tail and leaves the prefix alone until the fold", async () => {
    const m = await member();
    await turn(m.principal, { text: "Hello" });
    await turn(m.principal, { text: "remember I take Fridays off" });
    await turn(m.principal, { text: "Hello again" });
    expect(await newestSent(m)).toContain("I take Fridays off");
    expect(new Set(await prefixes(m)).size).toBe(1);

    await fold(m);
    await turn(m.principal, { text: "And again" });
    const after = await prefixes(m);
    expect(new Set(after).size).toBe(2);
    expect(await newestSent(m)).not.toContain("I take Fridays off");
    expect(await memoryBlock(m)).toBe("- I take Fridays off");
    // The hook is safe with nothing to fold, and then the prefix does not move.
    await fold(m);
    await turn(m.principal, { text: "Once more" });
    expect(new Set(await prefixes(m)).size).toBe(2);
  });

  it("undo removes the line, and the next turn no longer sends it", async () => {
    const m = await member();
    await turn(m.principal, { text: "Hello" });
    const events = await turn(m.principal, { text: "remember I take Fridays off" });
    const save = toolOutputs(events).map(memorySaveOf).find(Boolean);
    await invokeByName("memory.delete", { id: save?.line.id }, human(m.user));
    await turn(m.principal, { text: "Hello again" });
    const sent = await newestSent(m);
    expect(sent).not.toContain("- I take Fridays off");
    expect(sent).toContain("changed or been removed");
  });

  it("refuses a customer fact: no memory line, and a note waits for approval", async () => {
    const m = await member();
    const person = (await invokeByName(
      "person.create",
      { givenName: "Ade", familyName: `Okafor${Date.now()}` },
      human(m.user),
    )) as { id: string };
    const events = await turn(m.principal, {
      text: "remember Ade is leaving Brightwater in March",
      context: { path: `/people/${person.id}`, record: { object: "person", id: person.id } },
    });
    expect(toolOutputs(events)[0]).toMatchObject({ result: "customer", line: null });
    const pending = events.find((e) => e.type === "tool-result" && e.pending);
    expect(pending).toMatchObject({ pending: { operation: "activity.proposeNote" } });
    expect((await list(m.user)).lines).toEqual([]);
  });

  it("deleting the source message deletes the line; a reply's deletion leaves it", async () => {
    const m = await member();
    await turn(m.principal, { text: "remember I take Fridays off" });
    await turn(m.principal, { text: "remember I like tea" });
    const items = (await state(m.principal)).items;
    const said = (text: string) =>
      items.find((i) => i.kind === "user" && i.text.includes(text))?.seq as number;
    const reply = items.find((i) => i.kind === "assistant")?.seq as number;
    const del = (seq: number) =>
      runOperation(env as never, m.principal, { name: "thread.deleteMessage", input: { seq } });

    expect(await del(reply)).toMatchObject({ ok: true });
    expect((await list(m.user)).lines).toHaveLength(2);
    expect(await del(said("Fridays"))).toMatchObject({ ok: true });
    expect((await list(m.user)).lines.map((l) => l.text)).toEqual(["I like tea"]);
  });

  it("shows a conditional line only on matching records", async () => {
    const m = await member();
    const events = await turn(m.principal, {
      text: "when I'm on an organisation with more than 500 people, start with the buying committee",
    });
    const save = toolOutputs(events).map(memorySaveOf).find(Boolean);
    expect(save).toMatchObject({ result: "confirm", checked: "judge" });
    expect(save?.line.conditionLabel).toBe("Organisations where People is more than 500");
    await invokeByName("memory.update", { id: save?.line.id, confirm: true }, human(m.user));

    const organisation = async (name: string, people: number) => {
      const org = (await invokeByName(
        "organisation.create",
        { name: `${name} ${Date.now()}` },
        human(m.user),
      )) as { id: string };
      const stamp = new Date().toISOString();
      await env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
         INSERT INTO core_person (id, display_name, created_at, updated_at)
         SELECT ? || i, 'Bulk', ?, ? FROM n`,
      )
        .bind(people, `per_${org.id}_`, stamp, stamp)
        .run();
      await env.DB.prepare(
        `INSERT INTO core_affiliation (id, person_id, organisation_id, is_current, created_at, updated_at)
         SELECT 'aff_' || id, id, ?, 1, ?, ? FROM core_person WHERE id LIKE ?`,
      )
        .bind(org.id, stamp, stamp, `per_${org.id}_%`)
        .run();
      return org;
    };
    const big = await organisation("Big", 1200);
    const small = await organisation("Small", 40);
    const tailOn = async (id: string) => {
      await turn(m.principal, {
        text: "Hi",
        context: { path: `/organisations/${id}`, record: { object: "organisation", id } },
      });
      return newestSent(m);
    };
    expect(await tailOn(big.id)).toContain("start with the buying committee");
    expect(await tailOn(small.id)).not.toContain("start with the buying committee");
  });

  it("erase removes the memory line, and the thread's copies, for an erased person", async () => {
    const m = await member();
    const admin = await member("admin");
    const family = `Erasable${Date.now()}`;
    const zelda = (await invokeByName(
      "person.create",
      { givenName: "Zelda", familyName: family },
      human(m.user),
    )) as { id: string };
    const events = await turn(m.principal, { text: `remember I report to Zelda ${family}` });
    const save = toolOutputs(events).map(memorySaveOf).find(Boolean);
    expect(save?.result).toBe("saved");

    const erased = await runOperation(env as never, admin.principal, {
      name: "person.erase",
      input: { id: zelda.id },
    });
    expect(erased).toMatchObject({ ok: true, data: { memoryLinesDeleted: 1 } });
    expect((await list(m.user)).lines).toEqual([]);
    expect(await memoryForAgent(db.query, m.user.id)).toBeUndefined();
    const text = JSON.stringify(await state(m.principal));
    expect(text).not.toContain(family);
    expect(text).not.toContain(zelda.id);
  });
});
