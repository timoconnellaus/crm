// Personal routines (ADR 0343): the routine.* operations against real D1 with a scripted judge.
// Covers the 15 minute minimum, the judge being off, the read-back, the backtest and its flags,
// turning one on with a button only, ownership, gates in order and what an erase reaches.
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  type CoreOutput,
  choiceAnswer,
  cronFires,
  fakeJudge,
  type InvocationContext,
  invokeByName,
  MORNING_BRIEFING,
  nextCronFire,
  offJudge,
  type RoutineDefinitionInput,
  routineDefinitionSchema,
  runRoutineChecks,
  shortestCronGap,
  unavailableJudge,
} from "../src/index.ts";
import { context, createUser, db, unique } from "./helpers.ts";

const LABELS = ["meets", "does_not", "unclear"] as const;
const says = (label: (typeof LABELS)[number]) =>
  fakeJudge({ "routine.gate": { check: choiceAnswer(LABELS, label) } }, { byPlacement: true });

const hourly: RoutineDefinitionInput = {
  name: "Hourly check",
  what: "tell you the time",
  trigger: { type: "schedule", cron: "0 * * * *" },
  message: { kind: "turn", prompt: "Say what time it is." },
};

const weekdays: RoutineDefinitionInput = {
  ...hourly,
  name: "Morning note",
  trigger: { type: "schedule", cron: "0 8 * * 1-5" },
};

function chat(user: ActingUser, overrides: Partial<InvocationContext> = {}): InvocationContext {
  return context(user, {
    actor: "assistant",
    origin: { surface: "assistant", sessionId: "ath_test" },
    assistantTurn: { threadId: "ath_test000000", messageSeq: 1, text: "brief me every morning" },
    ...overrides,
  });
}

type Draft = CoreOutput<"routine.draft">;
const draft = (user: ActingUser, definition: RoutineDefinitionInput, overrides = {}) =>
  invokeByName("routine.draft", { definition }, chat(user, overrides)) as Promise<Draft>;

/** Presses the card's Turn on button, as the person. */
async function turnOn(user: ActingUser, card: Draft) {
  const root = card.part.document?.root as unknown as {
    actions: { operation?: string; input?: Record<string, unknown> }[];
  };
  const action = root.actions[0];
  return invokeByName(action?.operation as string, action?.input, context(user)) as Promise<
    CoreOutput<"routine.create">
  >;
}

let user: ActingUser;

beforeAll(async () => {
  user = await createUser("member");
});

describe("cron helpers", () => {
  it("finds fires, the next one and the shortest gap", () => {
    expect(cronFires("0 8 * * 1-5", "2026-11-02", 7)).toEqual([
      "2026-11-02T08:00",
      "2026-11-03T08:00",
      "2026-11-04T08:00",
      "2026-11-05T08:00",
      "2026-11-06T08:00",
    ]);
    expect(nextCronFire("0 8 * * 1-5", "2026-11-06T08:00")).toBe("2026-11-09T08:00");
    expect(shortestCronGap("*/5 * * * *", "2026-11-02")).toBe(5);
    expect(shortestCronGap("0,5 8 * * *", "2026-11-02")).toBe(5);
    expect(shortestCronGap("0 8 * * *", "2026-11-02")).toBe(1440);
    expect(shortestCronGap("0 8 1 1 *", "2026-11-02")).toBeNull();
  });
});

describe("routine.draft", () => {
  it("shows a read-back with a backtest, and changes nothing", async () => {
    const card = await draft(user, weekdays);
    expect(card.part.source).toBe("host");
    expect(card.part.fallback).toContain("Would have messaged you");
    expect(card.part.fallback).not.toMatch(/routine/i);
    expect(card.backtest.days).toBe(30);
    expect(card.backtest.fired).toBeGreaterThan(15);
    expect(card.backtest.fires).toHaveLength(30);
    const rows = await db.query
      .selectFrom("core_routine")
      .select("id")
      .where("owner_user_id", "=", user.id)
      .execute();
    expect(rows).toEqual([]);
  });

  it("refuses a schedule under 15 minutes", async () => {
    await expect(
      draft(user, { ...hourly, trigger: { type: "schedule", cron: "*/10 * * * *" } }),
    ).rejects.toThrow(/every 10 minutes.*shortest gap allowed is 15/);
    await expect(
      draft(user, { ...hourly, trigger: { type: "schedule", cron: "*/15 * * * *" } }),
    ).resolves.toBeDefined();
  });

  it("follows the admin setting, which cannot go below 15", async () => {
    const admin = await createUser("admin");
    await expect(
      invokeByName("routine.updateSettings", { minIntervalMinutes: 5 }, context(admin)),
    ).rejects.toThrow();
    await expect(
      invokeByName("routine.updateSettings", { minIntervalMinutes: 60 }, context(user)),
    ).rejects.toThrow();
    await invokeByName("routine.updateSettings", { minIntervalMinutes: 60 }, context(admin));
    await expect(
      draft(user, { ...hourly, trigger: { type: "schedule", cron: "*/30 * * * *" } }),
    ).rejects.toThrow(/shortest gap allowed is 60/);
    await invokeByName("routine.updateSettings", { minIntervalMinutes: 15 }, context(admin));
  });

  it("never uses the word in what the person reads", async () => {
    await expect(draft(user, { ...hourly, name: "Daily routine" })).rejects.toThrow(/plain words/);
  });

  it("offers typed checks only when the judge can answer them", async () => {
    const watching: RoutineDefinitionInput = {
      ...hourly,
      trigger: { type: "record", object: "person", on: ["created"] },
      checks: [{ question: "they sound keen" }],
    };
    await expect(draft(user, watching, { judge: offJudge })).rejects.toThrow(/plain checks only/);
    await expect(draft(user, watching, { judge: says("meets") })).resolves.toBeDefined();
  });

  it("flags no data and a very broad trigger, deterministically", async () => {
    const object = "organisation";
    const none = await draft(user, {
      ...hourly,
      trigger: { type: "fieldChanged", object, field: "name", to: unique("never") },
      conditions: { field: "name", op: "eq", value: "nobody" },
    });
    expect(none.backtest.fired).toBe(0);
    expect(none.backtest.flags.map((f) => f.code)).toContain("no_data");

    const broad = await draft(user, {
      ...hourly,
      trigger: { type: "record", object: "person", on: ["created"] },
    });
    expect(broad.backtest.flags.map((f) => f.code)).toContain("broad");

    const often = await draft(user, hourly);
    expect(often.backtest.fired).toBeGreaterThan(90);
    expect(often.backtest.flags.map((f) => f.code)).toContain("broad");
  });

  it("gives examples that pass and fail from real records", async () => {
    const title = unique("Chase");
    await invokeByName("task.create", { title, dueAt: "2020-01-06" }, context(user));
    const card = await draft(user, {
      ...weekdays,
      exists: [
        {
          object: "task",
          filter: {
            and: [
              { field: "status", op: "eq", value: "open" },
              { field: "assigneeId", op: "eq", value: { $relative: "me" } },
              { field: "dueAt", op: "lt", value: { $relative: "tomorrow" } },
            ],
          },
        },
      ],
    });
    // The task was created today, so past days had nothing to send.
    expect(card.backtest.fired).toBeLessThanOrEqual(1);
    expect(card.backtest.examples.some((e) => !e.passed)).toBe(true);
    expect(card.backtest.examples.find((e) => !e.passed)?.text).toContain("nothing to send");
  });
});

describe("turning it on", () => {
  it("is a person's button: the assistant cannot, and pressing twice makes one", async () => {
    const owner = await createUser("member");
    const card = await draft(owner, weekdays);
    const root = card.part.document?.root as unknown as {
      actions: { operation: string; input: Record<string, unknown> }[];
    };
    const action = root.actions[0] as { operation: string; input: Record<string, unknown> };
    expect(action.operation).toBe("routine.create");
    await expect(invokeByName("routine.create", action.input, chat(owner))).rejects.toThrow();
    const first = await turnOn(owner, card);
    const second = await turnOn(owner, card);
    expect(second.id).toBe(first.id);
    const listed = (await invokeByName(
      "routine.list",
      {},
      context(owner),
    )) as CoreOutput<"routine.list">;
    expect(listed.routines).toHaveLength(1);
    expect(listed.routines[0]).toMatchObject({
      status: "on",
      asked: "brief me every morning",
      lastRunAt: null,
    });
    expect(listed.routines[0]?.nextRunAt).toBeTruthy();
    expect(listed.minIntervalMinutes).toBe(15);
  });

  it("is a personal automation on the engine that automation.* does not show", async () => {
    const owner = await createUser("member");
    const made = await turnOn(owner, await draft(owner, weekdays));
    const row = await db.query
      .selectFrom("core_automations")
      .selectAll()
      .where("id", "=", `routine.${made.id}`)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      scope: "personal",
      owner_user_id: owner.id,
      trigger_type: "schedule",
      extension_id: "routine",
      enabled: 1,
    });
    const admin = await createUser("admin");
    const list = (await invokeByName(
      "automation.list",
      {},
      context(admin),
    )) as CoreOutput<"automation.list">;
    expect(list.items.map((a) => a.id)).not.toContain(row.id);
    await expect(invokeByName("automation.get", { id: row.id }, context(admin))).rejects.toThrow();
  });

  it("belongs to its owner", async () => {
    const owner = await createUser("member");
    const other = await createUser("admin");
    const made = await turnOn(owner, await draft(owner, weekdays));
    for (const [name, input] of [
      ["routine.pause", { id: made.id }],
      ["routine.delete", { id: made.id }],
      ["routine.update", { id: made.id, name: "Mine now" }],
      ["routine.test", { id: made.id }],
    ] as const) {
      await expect(invokeByName(name, input, context(other))).rejects.toThrow(/not found|No/i);
    }
  });

  it("pauses, snoozes, resumes, edits and deletes", async () => {
    const owner = await createUser("member");
    const made = await turnOn(owner, await draft(owner, weekdays));
    const paused = (await invokeByName(
      "routine.pause",
      { id: made.id },
      chat(owner),
    )) as CoreOutput<"routine.pause">;
    expect(paused).toMatchObject({ status: "paused", nextRunAt: null });

    const resumed = (await invokeByName(
      "routine.pause",
      { id: made.id, resume: true },
      context(owner),
    )) as CoreOutput<"routine.pause">;
    expect(resumed.status).toBe("on");

    const until = new Date(Date.now() + 86_400_000).toISOString();
    const snoozed = (await invokeByName(
      "routine.pause",
      { id: made.id, until },
      context(owner),
    )) as CoreOutput<"routine.pause">;
    expect(snoozed).toMatchObject({
      status: "paused",
      statusReason: "Snoozed",
      pausedUntil: until,
    });

    const edited = (await invokeByName(
      "routine.update",
      { id: made.id, name: "Early note", cron: "30 7 * * 1-5" },
      context(owner),
    )) as CoreOutput<"routine.update">;
    expect(edited).toMatchObject({ name: "Early note", cron: "30 7 * * 1-5" });
    await expect(
      invokeByName("routine.update", { id: made.id, cron: "*/5 * * * *" }, context(owner)),
    ).rejects.toThrow(/shortest gap/);

    await invokeByName("routine.delete", { id: made.id }, context(owner));
    const gone = await db.query
      .selectFrom("core_automations")
      .select("id")
      .where("id", "=", `routine.${made.id}`)
      .execute();
    expect(gone).toEqual([]);
  });

  it("refuses to change a routine from the chat", async () => {
    const owner = await createUser("member");
    const made = await turnOn(owner, await draft(owner, weekdays));
    await expect(
      invokeByName("routine.update", { id: made.id, name: "Sneaky" }, chat(owner)),
    ).rejects.toThrow();
    await expect(invokeByName("routine.delete", { id: made.id }, chat(owner))).rejects.toThrow();
  });
});

describe("the gates", () => {
  const definition = routineDefinitionSchema.parse({
    ...hourly,
    trigger: { type: "record", object: "person", on: ["created"] },
    conditions: { field: "givenName", op: "eq", value: "Ada" },
    checks: [{ question: "they sound keen" }],
  });

  async function person(firstName: string) {
    const made = (await invokeByName(
      "person.create",
      { givenName: firstName, familyName: unique("L") },
      context(user),
    )) as { id: string };
    return { object: "person", id: made.id, title: firstName, data: { givenName: firstName } };
  }

  const check = (record: Awaited<ReturnType<typeof person>>, judge: InvocationContext["judge"]) =>
    runRoutineChecks({
      db: db.query,
      judge,
      ownerId: user.id,
      definition,
      record,
      now: new Date().toISOString(),
    });

  it("runs plain gates first: a plain miss never reaches the judge", async () => {
    const judge = says("meets");
    const result = await check(await person("Grace"), judge);
    expect(result.pass).toBe(false);
    expect(judge.calls).toHaveLength(0);
    expect(result.checks).toHaveLength(1);
  });

  it("asks a typed check over the event, in the person's words", async () => {
    const judge = says("meets");
    const result = await check(await person("Ada"), judge);
    expect(result.pass).toBe(true);
    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0]?.state).toMatchObject({ check: "they sound keen" });
    expect(String(judge.calls[0]?.state.event)).toContain("Ada");
    expect(result.checks.map((c) => [c.kind, c.passed])).toEqual([
      ["plain", true],
      ["jev", true],
    ]);
  });

  it("stops on a no, an unclear answer and a judge that cannot answer", async () => {
    const ada = await person("Ada");
    expect((await check(ada, says("does_not"))).pass).toBe(false);
    expect((await check(ada, says("unclear"))).pass).toBe(false);
    const failed = await check(ada, unavailableJudge("timeout"));
    expect(failed.pass).toBe(false);
    expect(failed.checks.at(-1)).toMatchObject({ kind: "jev", unavailable: true });
  });
});

describe("the first offer", () => {
  it("is a concrete morning briefing, in outcomes", async () => {
    const owner = await createUser("member");
    const card = (await invokeByName("routine.offer", {}, chat(owner))) as Draft;
    expect(card.part.fallback).toContain("Morning briefing");
    expect(card.part.fallback).toMatch(/your meetings for the day/);
    expect(card.part.fallback).not.toMatch(/routine/i);
    expect(routineDefinitionSchema.safeParse(MORNING_BRIEFING).success).toBe(true);
    const made = await turnOn(owner, card);
    expect(made).toMatchObject({ name: "Morning briefing", status: "on" });
  });
});

describe("erase", () => {
  it("takes the subject out of the routine, and pauses it", async () => {
    const owner = await createUser("admin");
    const person = (await invokeByName(
      "person.create",
      { givenName: "Ottoline", familyName: unique("Vex") },
      context(owner),
    )) as { id: string; lastName: string };
    const made = await turnOn(
      owner,
      await draft(
        owner,
        {
          ...hourly,
          name: "Ottoline watch",
          what: "tell you when Ottoline writes",
          trigger: { type: "record", object: "activity", on: ["created"] },
          conditions: { field: "subject", op: "contains", value: person.id },
        },
        { assistantTurn: { threadId: "ath_test000000", messageSeq: 2, text: "watch Ottoline" } },
      ),
    );
    const scrubbed: string[] = [];
    await invokeByName(
      "person.erase",
      { id: person.id },
      context(owner, {
        assistantThreads: {
          scrub: async (userId: string) => void scrubbed.push(userId),
        } as unknown as InvocationContext["assistantThreads"],
      }),
    );
    expect(scrubbed).toEqual([owner.id]);
    const row = await db.query
      .selectFrom("core_routine as r")
      .innerJoin("core_automations as a", "a.id", "r.automation_id")
      .select([
        "r.name",
        "r.what",
        "r.asked",
        "r.definition",
        "a.spec",
        "a.label",
        "a.paused_reason",
      ])
      .where("r.id", "=", made.id)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(row)).not.toContain("Ottoline");
    expect(JSON.stringify(row)).not.toContain(person.id);
    expect(row.paused_reason).toContain("erased");
  });
});
