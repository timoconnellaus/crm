// Compaction of the live thread (ADR 0341, spec W2) in workerd: the AssistantAgent Durable Object
// with the scripted model, real D1 and the real idle alarm. The planner's maths has its own unit
// tests in agent-core; these cover what the object does with it.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { replayCacheReport } from "@relationship-os/agent-core";
import type { Principal } from "@relationship-os/auth";
import {
  type AssistantEvent,
  type AssistantThreadState,
  fakeStandIn,
  invokeByName,
  resolveActingUser,
} from "@relationship-os/core";
import { createCrmDb } from "@relationship-os/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AssistantHttpEnv,
  handleState,
  handleTurn,
  threadStub,
} from "../src/server/assistant/http.ts";
import { runScheduledMaintenance } from "../src/server/purge.ts";

const ORIGIN = "https://crm.test";
const appEnv = env as unknown as AssistantHttpEnv;
const db = createCrmDb(env.DB);

/** Cheap cached reads, so holding a warm cache pays and losing it does not. */
const PRICES = {
  input: 1,
  cacheWrite: 1,
  cachedInput: 0.01,
  output: 2,
  cacheKnown: true,
  cacheLifetimeSeconds: null,
};

let n = 0;
async function member(role: "member" | "admin" = "admin") {
  n += 1;
  const principal: Principal = {
    userId: `auth-compaction-${Date.now()}-${n}`,
    email: `compaction-${Date.now()}-${n}@example.com`,
    name: `Compaction tester ${n}`,
    roles: [],
  };
  const user = await resolveActingUser(db, principal);
  await env.DB.prepare("UPDATE core_user SET role = ? WHERE id = ?").bind(role, user.id).run();
  return { principal, user: { ...user, role } };
}

type Member = Awaited<ReturnType<typeof member>>;

const human = (m: Member) => ({
  actor: "human" as const,
  user: m.user,
  origin: { surface: "ui" as const },
  db,
});

async function rails(
  m: Member,
  next: { minTokens: number; maxShareOfWindow: number; fallbackIdleMinutes: number },
) {
  await invokeByName("ai.updateCacheRails", next, human(m));
}

const stubFor = (m: Member) =>
  threadStub(appEnv.ASSISTANT as NonNullable<AssistantHttpEnv["ASSISTANT"]>, m.user.id);

async function turn(m: Member, text: string): Promise<AssistantEvent[]> {
  const response = await handleTurn(
    new Request(`${ORIGIN}/api/assistant/turn`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ text }),
    }),
    appEnv,
    m.principal,
  );
  expect(response.status).toBe(200);
  return (await response.text())
    .split("\n\n")
    .map((frame) => frame.split("\n").find((l) => l.startsWith("data: ")))
    .filter((l): l is string => Boolean(l))
    .map((l) => JSON.parse(l.slice(6)) as AssistantEvent);
}

/** `count` turns of about `chars` characters each, each with a word only it has. */
async function chat(m: Member, count: number, chars: number, from = 0) {
  for (let i = from; i < from + count; i++) {
    const events = await turn(m, `Topic marker${i}x. ${"lorem ipsum ".repeat(chars / 12)}`);
    expect(events.at(-1)).toMatchObject({ type: "turn-end", status: "done" });
  }
}

/** Three long exchanges, then ten short ones: compacting would save a lot. */
async function oldThenRecent(m: Member) {
  await chat(m, 3, 12_000);
  await chat(m, 10, 100, 3);
}

const status = async (m: Member) => (await stubFor(m)).compactionStatus(m.user.id);

/** Waits for the compaction a turn's end started, if any. */
async function compacted(m: Member) {
  await vi.waitFor(
    async () => {
      const s = await status(m);
      expect(s.compacting).toBe(false);
      expect(s.note).not.toBeNull();
    },
    { timeout: 10_000 },
  );
  return status(m);
}

async function settled(m: Member) {
  await vi.waitFor(async () => expect((await status(m)).compacting).toBe(false));
}

async function state(m: Member): Promise<AssistantThreadState> {
  const response = await handleState(
    new Request(`${ORIGIN}/api/assistant/thread`),
    appEnv,
    m.principal,
  );
  return (await response.json()) as AssistantThreadState;
}

async function decisions() {
  const { results } = await env.DB.prepare(
    "SELECT decision, rule, input, actual_turns, actual_cost FROM core_ai_compaction_decision ORDER BY at DESC",
  ).all<{
    decision: string;
    rule: string;
    input: string;
    actual_turns: number | null;
    actual_cost: number | null;
  }>();
  return results;
}

/** The idle alarm's row, if any. */
async function alarms(m: Member) {
  return runInDurableObject(await stubFor(m), async (_agent, s) => {
    const sql = s.storage.sql;
    const table = sql
      .exec("SELECT 1 FROM sqlite_master WHERE name = 'cf_agents_jobs'")
      .toArray().length;
    if (!table) return [];
    return sql
      .exec<{ id: string; fn: string; time: number }>("SELECT id, fn, time FROM cf_agents_jobs")
      .toArray();
  });
}

/** Time passes: the last request was `seconds` ago, and the alarm is due. */
async function idleFor(m: Member, seconds: number) {
  const stub = await stubFor(m);
  await runInDurableObject(stub, async (_agent, s) => {
    const sql = s.storage.sql;
    const row = sql
      .exec<{ value: string }>("SELECT value FROM thread_meta WHERE key = 'compaction_state'")
      .one();
    const value = JSON.parse(row.value) as { last: { at: number }; lastTurnAt: number };
    value.last.at -= seconds * 1000;
    value.lastTurnAt -= seconds * 1000;
    sql.exec(
      "UPDATE thread_meta SET value = ? WHERE key = 'compaction_state'",
      JSON.stringify(value),
    );
    sql.exec("UPDATE cf_agents_jobs SET time = ?", Date.now() - 1000);
    await s.storage.setAlarm(Date.now() - 1000);
  });
  return runDurableObjectAlarm(stub);
}

afterEach(async () => {
  fakeStandIn.pricing = null;
  fakeStandIn.contextTokens = 0;
  fakeStandIn.cacheHits = true;
  fakeStandIn.holdSummary = null;
  fakeStandIn.requests = null;
  await env.DB.prepare("DELETE FROM core_settings WHERE key = 'ai_compaction'").run();
  await env.DB.prepare("DELETE FROM core_ai_compaction_decision").run();
  await env.DB.prepare("DELETE FROM core_ai_cache_observation").run();
  await env.DB.prepare("DELETE FROM core_ai_cache_estimate").run();
  await env.DB.prepare("DELETE FROM core_ai_cache_estimate_history").run();
});

describe("compaction in the live thread", () => {
  it("never compacts below the floor, and keeps every message in the context", async () => {
    fakeStandIn.pricing = PRICES;
    fakeStandIn.contextTokens = 128_000;
    const m = await member();
    await chat(m, 12, 200);
    await settled(m);
    expect(await status(m)).toMatchObject({ note: null, since: 0 });
    const [latest] = await decisions();
    expect(latest).toMatchObject({ decision: "continue", rule: "floor" });
    // Under the floor there is nothing to wake up for.
    expect(await alarms(m)).toEqual([]);
  });

  it("compacts when that is cheaper: note in the prefix, last 10 exchanges kept, all searchable", async () => {
    fakeStandIn.pricing = PRICES;
    fakeStandIn.contextTokens = 128_000;
    const m = await member();
    await rails(m, { minTokens: 1_000, maxShareOfWindow: 0.8, fallbackIdleMinutes: 10 });
    await oldThenRecent(m);
    const { note, since } = await compacted(m);
    expect(note).toContain("marker0x");
    expect(since).toBeGreaterThan(0);
    expect((await decisions()).some((d) => d.decision === "compact" && d.rule === "cost")).toBe(
      true,
    );

    fakeStandIn.requests = [];
    await turn(m, "And what next?");
    const request = fakeStandIn.requests.find((r) => JSON.stringify(r).includes("what next"));
    const sent = JSON.stringify(request?.messages);
    // The note is in the prefix, the old messages are not, and the last 10 exchanges are.
    expect(sent).toContain("Where we left off");
    expect(sent).toContain("We were talking about: Topic marker0x");
    expect(sent).not.toContain("Topic marker0x. lorem");
    expect(sent).not.toContain("Topic marker2x. lorem");
    expect(sent).toContain("Topic marker3x. lorem");
    expect(sent).toContain("Topic marker12x. lorem");

    // Everything stays searchable and shown.
    const hits = await (await stubFor(m)).search(m.user.id, "marker0x");
    expect(hits).toHaveLength(1);
    expect((await state(m)).items[0]).toMatchObject({ kind: "user" });

    // The prefix changed once, at the compaction.
    const hashes = (await (await stubFor(m)).prefixHashes(m.user.id)).map((h) => h.prefixHash);
    expect(new Set(hashes).size).toBeGreaterThan(1);
    expect(hashes[0]).toBe(hashes[10]);
    await settled(m);
  });

  it("always compacts at the ceiling, keeping fewer exchanges if it must, even with no prices", async () => {
    // A small window: the ceiling (12k) is under the floor (24k), and overflow is the worse risk.
    fakeStandIn.contextTokens = 16_000;
    const m = await member();
    await rails(m, { minTokens: 24_000, maxShareOfWindow: 0.75, fallbackIdleMinutes: 10 });
    await chat(m, 5, 8_000);
    const { since } = await compacted(m);
    const compacting = (await decisions()).find((d) => d.decision === "compact");
    expect(compacting?.rule).toBe("ceiling");
    // Only five exchanges, and still a cut: fewer than 10 stayed, to get under the ceiling.
    expect(since).toBeGreaterThan(0);
    expect((await state(m)).items.filter((i) => i.kind === "user")).toHaveLength(5);
  });

  it("the idle alarm compacts just before expiry when that beats paying full price", async () => {
    // Most of the context is in the last 10 exchanges, so compacting saves a little and a warm
    // cache is worth more: at the turn's end the planner continues and sets the alarm. Once the
    // cache is about to go, the next turn would pay full price anyway, and compacting wins.
    fakeStandIn.pricing = { ...PRICES, cacheLifetimeSeconds: 600 };
    fakeStandIn.contextTokens = 128_000;
    const m = await member();
    await rails(m, { minTokens: 1_000, maxShareOfWindow: 0.8, fallbackIdleMinutes: 10 });
    await chat(m, 1, 19_000);
    await chat(m, 10, 3_000, 1);
    await settled(m);
    expect((await status(m)).note).toBeNull();
    const [atTurnEnd] = await decisions();
    expect(atTurnEnd).toMatchObject({ decision: "continue", rule: "cost" });

    // One alarm, 30 s before the published 10 minutes run out.
    const armed = await alarms(m);
    expect(armed).toHaveLength(1);
    expect(JSON.stringify(armed[0])).toContain("onIdleAlarm");
    const expected = Date.now() + 570_000;
    expect(armed[0]?.time).toBeGreaterThan(expected - 30_000);
    expect(armed[0]?.time).toBeLessThan(expected + 1_000);

    expect(await idleFor(m, 570)).toBe(true);
    const { note } = await compacted(m);
    expect(note).toContain("marker0x");
    const [idle] = await decisions();
    expect(idle).toMatchObject({ decision: "compact", rule: "cost" });
    expect(JSON.parse(idle?.input ?? "{}")).toMatchObject({ moment: "idle" });
    expect(await alarms(m)).toEqual([]);
  });

  it("a new turn cancels the alarm, and the next turn's end sets one again", async () => {
    fakeStandIn.pricing = { ...PRICES, cacheLifetimeSeconds: 600 };
    fakeStandIn.contextTokens = 128_000;
    const m = await member();
    await rails(m, { minTokens: 1_000, maxShareOfWindow: 0.8, fallbackIdleMinutes: 10 });
    await chat(m, 3, 3_000);
    await settled(m);
    const [first] = await alarms(m);
    expect(first).toBeDefined();
    await chat(m, 1, 3_000, 3);
    await settled(m);
    const armed = await alarms(m);
    expect(armed).toHaveLength(1);
    expect(armed[0]?.id).not.toBe(first?.id);
  });

  it("with no prices or lifetime, falls back to the admin's idle wait", async () => {
    fakeStandIn.contextTokens = 128_000;
    const m = await member();
    await rails(m, { minTokens: 1_000, maxShareOfWindow: 0.8, fallbackIdleMinutes: 15 });
    await chat(m, 11, 1_200);
    await settled(m);
    expect((await status(m)).note).toBeNull();
    const [atTurnEnd] = await decisions();
    expect(atTurnEnd).toMatchObject({ decision: "continue", rule: "unknown-prices" });
    const expected = Date.now() + 15 * 60_000;
    expect((await alarms(m))[0]?.time).toBeGreaterThan(expected - 30_000);

    // Woken early (the alarm fired after 5 minutes): it waits out the rest.
    await idleFor(m, 300);
    await settled(m);
    expect((await status(m)).note).toBeNull();
    expect(await alarms(m)).toHaveLength(1);

    await idleFor(m, 600);
    await compacted(m);
    const [idle] = await decisions();
    expect(idle).toMatchObject({ decision: "compact", rule: "fallback" });
  });

  it("a turn arriving during a compaction is answered, and the compaction rebases on it", async () => {
    fakeStandIn.pricing = PRICES;
    fakeStandIn.contextTokens = 128_000;
    const m = await member();
    await rails(m, { minTokens: 1_000, maxShareOfWindow: 0.8, fallbackIdleMinutes: 10 });
    let release = () => {};
    fakeStandIn.holdSummary = new Promise((resolve) => {
      release = resolve;
    });
    fakeStandIn.requests = [];
    await oldThenRecent(m);
    await vi.waitFor(async () => expect((await status(m)).compacting).toBe(true));
    const before = await status(m);
    expect(before).toMatchObject({ note: null, since: 0 });

    // The person sends a message while the summary call is out.
    const events = await turn(m, "Quick one: marker-during-compaction");
    expect(events.at(-1)).toMatchObject({ type: "turn-end", status: "done" });
    const during = fakeStandIn.requests.find((r) =>
      JSON.stringify(r).includes("marker-during-compaction"),
    );
    // Answered against the pre-compaction context: no note, the oldest message still there.
    expect(JSON.stringify(during?.messages)).toContain("Topic marker0x. lorem");
    expect(JSON.stringify(during?.messages)).not.toContain("Where we left off");
    expect((await status(m)).compacting).toBe(true);

    release();
    const { since } = await compacted(m);
    expect(since).toBeGreaterThan(0);

    // Rebased: the turn that arrived meanwhile is among the messages since the compaction.
    fakeStandIn.requests = [];
    await turn(m, "And after it?");
    const next = JSON.stringify(
      fakeStandIn.requests.find((r) => JSON.stringify(r).includes("And after it?"))?.messages,
    );
    expect(next).toContain("Where we left off");
    expect(next).toContain("marker-during-compaction");
    expect(next).not.toContain("Topic marker0x. lorem");
    await settled(m);
  });

  it("records an observation per response, feeds the learner, and stores no words", async () => {
    fakeStandIn.pricing = PRICES;
    fakeStandIn.contextTokens = 128_000;
    const m = await member();
    await chat(m, 4, 200);
    await settled(m);
    const { results } = await env.DB.prepare(
      "SELECT * FROM core_ai_cache_observation ORDER BY id",
    ).all<Record<string, unknown>>();
    // Every response but the thread's very first.
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({
      provider: "fake",
      model: "fake",
      role: "assistant.core",
      prefix_unchanged: 1,
    });
    expect(Number(results[0]?.cached_tokens)).toBeGreaterThan(1_000);
    expect(Number(results[0]?.prompt_tokens)).toBeGreaterThan(Number(results[0]?.cached_tokens));

    const estimate = await env.DB.prepare(
      "SELECT state, sample_size, version FROM core_ai_cache_estimate WHERE provider = 'fake'",
    ).first<{ state: string; sample_size: number; version: number }>();
    expect(estimate?.version).toBe(3);
    expect(estimate?.sample_size).toBeGreaterThan(2);
    expect((JSON.parse(estimate?.state ?? "{}") as { counted: number }).counted).toBe(3);

    // Sizes and times only: nothing anyone typed reached the review tables.
    for (const table of ["core_ai_cache_observation", "core_ai_compaction_decision"]) {
      const rows = await env.DB.prepare(`SELECT * FROM ${table}`).all();
      expect(JSON.stringify(rows.results)).not.toContain("marker");
      expect(JSON.stringify(rows.results)).not.toContain("lorem");
    }
  });

  it("fills in what the following turns really cost", async () => {
    fakeStandIn.pricing = PRICES;
    fakeStandIn.contextTokens = 128_000;
    const m = await member();
    await chat(m, 6, 200);
    await settled(m);
    // Rules out a long horizon: fix it at two turns.
    const stub = await stubFor(m);
  await runInDurableObject(stub, async (_agent, s) => {
      const row = s.storage.sql
        .exec<{ value: string }>("SELECT value FROM thread_meta WHERE key = 'compaction_state'")
        .one();
      const value = JSON.parse(row.value) as { open: { target: number }[] };
      for (const open of value.open) open.target = 1;
      s.storage.sql.exec(
        "UPDATE thread_meta SET value = ? WHERE key = 'compaction_state'",
        JSON.stringify(value),
      );
    });
    await chat(m, 1, 200, 6);
    await settled(m);
    const closed = (await decisions()).filter((d) => d.actual_turns !== null);
    expect(closed.length).toBeGreaterThan(0);
    expect(closed[0]?.actual_cost).toBeGreaterThan(0);
  });

  it("ai.cacheReport exports what the replay reads, as JSON and CSV", async () => {
    fakeStandIn.pricing = PRICES;
    fakeStandIn.contextTokens = 128_000;
    const m = await member();
    await rails(m, { minTokens: 1_000, maxShareOfWindow: 0.8, fallbackIdleMinutes: 10 });
    await oldThenRecent(m);
    await compacted(m);
    await chat(m, 2, 200, 13);
    await settled(m);

    const json = (await invokeByName("ai.cacheReport", { format: "json" }, human(m))) as {
      format: "json";
      report: Parameters<typeof replayCacheReport>[0] & {
        decisions: unknown[];
        observations: unknown[];
      };
    };
    expect(json.report).toMatchObject({ format: "relationship-os.ai-cache-report", version: 1 });
    expect(json.report.observations.length).toBeGreaterThan(5);
    expect(json.report.decisions.length).toBeGreaterThan(5);

    const replay = replayCacheReport(JSON.parse(JSON.stringify(json.report)));
    expect(replay.models[0]).toMatchObject({ provider: "fake", model: "fake" });
    expect(replay.decisions.total).toBe(json.report.decisions.length);
    expect(replay.decisions.recordedCompactions).toBeGreaterThan(0);
    // The recorded decisions come out the same when replayed.
    expect(replay.decisions.agreeing).toBe(replay.decisions.total);

    const csv = (await invokeByName("ai.cacheReport", { format: "csv" }, human(m))) as {
      csv: string;
    };
    const lines = csv.csv.trim().split("\r\n");
    expect(lines[0]).toMatch(/^record,at,provider,model/);
    expect(lines.some((l) => l.startsWith("observation,"))).toBe(true);
    expect(lines.some((l) => l.startsWith("decision,"))).toBe(true);

    await expect(
      invokeByName("ai.cacheReport", {}, human(await member("member"))),
    ).rejects.toThrow();
  });

  it("deleting a message the note covers drops the note, and an erase scrubs it", async () => {
    fakeStandIn.pricing = PRICES;
    fakeStandIn.contextTokens = 128_000;
    const m = await member();
    await rails(m, { minTokens: 1_000, maxShareOfWindow: 0.8, fallbackIdleMinutes: 10 });
    await oldThenRecent(m);
    const { note, since } = await compacted(m);
    expect(note).toContain("marker0x");

    const stub = await stubFor(m);
    await stub.scrub({ terms: ["marker0x"], names: [] });
    expect((await status(m)).note).toContain("[erased]");
    expect((await status(m)).note).not.toContain("marker0x");

    const first = (await state(m)).firstSeq ?? 1;
    await stub.deleteMessage(m.user.id, first);
    expect(await status(m)).toMatchObject({ note: null, since });
  });

  it("the rails are admins' to change, and old review data is purged after 180 days", async () => {
    const m = await member();
    await rails(m, { minTokens: 30_000, maxShareOfWindow: 0.7, fallbackIdleMinutes: 20 });
    expect(await invokeByName("ai.cacheSettings", {}, human(m))).toMatchObject({
      rails: { minTokens: 30_000, maxShareOfWindow: 0.7, fallbackIdleMinutes: 20 },
      defaults: { minTokens: 24_000, maxShareOfWindow: 0.8, fallbackIdleMinutes: 10 },
    });
    const viewer = await member("member");
    await expect(
      invokeByName(
        "ai.updateCacheRails",
        { minTokens: 1_000, maxShareOfWindow: 1, fallbackIdleMinutes: 1 },
        human(viewer),
      ),
    ).rejects.toThrow();

    const old = new Date(Date.now() - 181 * 86_400_000).toISOString();
    const recent = new Date(Date.now() - 179 * 86_400_000).toISOString();
    for (const at of [old, recent]) {
      await env.DB.prepare(
        "INSERT INTO core_ai_cache_observation (at, provider, model, role, gap_seconds, prefix_unchanged, cached_tokens, prompt_tokens) VALUES (?, 'p', 'm', 'r', 1, 1, 1, 1)",
      )
        .bind(at)
        .run();
      await env.DB.prepare(
        "INSERT INTO core_ai_compaction_decision (id, at, provider, model, role, decision, rule, input, result) VALUES (?, ?, 'p', 'm', 'r', 'continue', 'cost', '{}', '{}')",
      )
        .bind(`d-${at}`, at)
        .run();
    }
    const result = await runScheduledMaintenance(env);
    expect(result.cacheReview).toMatchObject({ deleted: 2, more: false });
    const left = await env.DB.prepare("SELECT at FROM core_ai_cache_observation").all();
    expect(left.results).toEqual([{ at: recent }]);
  });
});
