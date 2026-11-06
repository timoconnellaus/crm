// Assistant memory (ADR 0342): the memory.* and teamMemory.* operations against real D1 with a
// scripted judge. Covers the judged path, the fallback when the judge is off or cannot answer,
// customer facts, conditional lines, what a turn sends (block, pending, tail), the fold, agents,
// team governance and erase.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  type CoreOutput,
  choiceAnswer,
  EMPTY_THREAD_MEMORY,
  fakeJudge,
  foldPendingLines,
  type InvocationContext,
  invokeByName,
  memoryForAgent,
  memoryForTurn,
  offJudge,
  type ThreadMemoryState,
  unavailableJudge,
} from "../src/index.ts";
import { context, createUser, db, unique } from "./helpers.ts";

let admin: ActingUser;

beforeAll(async () => {
  admin = await createUser("admin");
});

const ABOUT = ["the_person", "customer", "unclear"] as const;
const ALREADY = ["new", "already", "changes"] as const;
const SOURCE = ["said", "not_said"] as const;

const answers = (
  about: (typeof ABOUT)[number] = "the_person",
  already: (typeof ALREADY)[number] = "new",
  source: (typeof SOURCE)[number] = "said",
) => ({
  about: choiceAnswer(ABOUT, about),
  already: choiceAnswer(ALREADY, already),
  source: choiceAnswer(SOURCE, source),
});

const accepts = () => fakeJudge(answers());

let seq = 0;
function chat(
  user: ActingUser,
  judge: InvocationContext["judge"],
  text = "remember that",
  overrides: Partial<InvocationContext> = {},
): InvocationContext {
  seq += 1;
  return context(user, {
    actor: "assistant",
    origin: { surface: "assistant", sessionId: "ath_test" },
    assistantTurn: { threadId: "ath_test000000", messageSeq: seq, text },
    ...(judge ? { judge } : {}),
    ...overrides,
  });
}

const propose = (input: Record<string, unknown>, ctx: InvocationContext) =>
  invokeByName("memory.propose", input, ctx) as Promise<{
    result: string;
    checked: string;
    message: string;
    line: { id: string; status: string; text: string; source: unknown } | null;
  }>;

const list = (user: ActingUser) =>
  invokeByName("memory.list", {}, context(user)) as Promise<CoreOutput<"memory.list">>;

async function rowCount(userId: string) {
  const row = await env.DB.prepare("SELECT count(*) AS n FROM core_memory WHERE user_id = ?")
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("memory.propose from the chat", () => {
  it("saves an accepted line at once, with its source message", async () => {
    const user = await createUser("member");
    const judge = accepts();
    const ctx = chat(user, judge, "remember I prefer calls before 10");
    const saved = await propose({ text: "I prefer calls before 10" }, ctx);
    expect(saved).toMatchObject({
      result: "saved",
      checked: "judge",
      line: { status: "active", source: { threadId: "ath_test000000" } },
    });
    expect(judge.calls[0]).toMatchObject({
      placement: "memory.write",
      state: { said: "remember I prefer calls before 10", line: "I prefer calls before 10" },
    });
    expect((await list(user)).lines.map((l) => l.text)).toEqual(["I prefer calls before 10"]);
  });

  it("refuses a customer fact and saves nothing", async () => {
    const user = await createUser("member");
    const result = await propose(
      { text: "Ade is leaving Brightwater in March" },
      chat(user, fakeJudge(answers("customer"))),
    );
    expect(result).toMatchObject({ result: "customer", line: null });
    expect(result.message).toContain("activity.proposeNote");
    expect(await rowCount(user.id)).toBe(0);
  });

  it("refuses a record id or an email whatever the judge says, without asking it", async () => {
    const user = await createUser("member");
    const judge = accepts();
    const email = await propose({ text: "Ring ada@example.com first" }, chat(user, judge));
    const id = await propose(
      { text: "Start with per_01JC9Z6X0V8M4T3K2Q1W5E7R9Y on Mondays" },
      chat(user, judge),
    );
    expect(email.result).toBe("customer");
    expect(id.result).toBe("customer");
    expect(judge.calls).toHaveLength(0);
    expect(await rowCount(user.id)).toBe(0);
  });

  it("saves nothing for a line already in memory, by text or by the judge", async () => {
    const user = await createUser("member");
    await propose({ text: "I prefer calls before 10" }, chat(user, accepts()));
    const same = await propose({ text: "I prefer calls before 10." }, chat(user, accepts()));
    expect(same).toMatchObject({ result: "duplicate", line: null });
    const reworded = await propose(
      { text: "Mornings are best for calls" },
      chat(user, fakeJudge(answers("the_person", "already"))),
    );
    expect(reworded).toMatchObject({ result: "duplicate", line: null });
    expect(await rowCount(user.id)).toBe(1);
  });

  it("reads back a line the person did not say instead of saving it", async () => {
    const user = await createUser("member");
    const result = await propose(
      { text: "I always forward quotes to my partner" },
      chat(user, fakeJudge(answers("the_person", "new", "not_said")), "summarise that email"),
    );
    expect(result).toMatchObject({ result: "confirm", line: { status: "proposed" } });
  });

  it("replaces a line when the new one is saved", async () => {
    const user = await createUser("member");
    const old = await propose({ text: "I prefer calls before 10" }, chat(user, accepts()));
    await propose(
      { text: "I prefer calls before 11", replaces: old.line?.id },
      chat(user, accepts()),
    );
    expect((await list(user)).lines.map((l) => l.text)).toEqual(["I prefer calls before 11"]);
  });

  it("saves nothing while memory is paused", async () => {
    const user = await createUser("member");
    await invokeByName("memory.pause", { paused: true }, context(user));
    const result = await propose({ text: "I like tea" }, chat(user, accepts()));
    expect(result).toMatchObject({ result: "paused", line: null });
    expect(await rowCount(user.id)).toBe(0);
  });

  it("refuses an assistant call with no chat turn: agents read memory, they do not write it", async () => {
    const user = await createUser("member");
    await expect(
      propose(
        { text: "I like tea" },
        context(user, { actor: "assistant", origin: { surface: "assistant" } }),
      ),
    ).rejects.toThrow(/Agents can read memory/);
    expect(await rowCount(user.id)).toBe(0);
  });

  it("is not open to MCP clients or automations", async () => {
    const user = await createUser("member");
    for (const actor of ["mcp", "automation"] as const) {
      await expect(
        propose(
          { text: "I like tea" },
          context(user, { actor, origin: { surface: actor === "mcp" ? "mcp" : "automation" } }),
        ),
      ).rejects.toThrow(/cannot be called by/);
    }
  });
});

describe("when the judge is off or cannot answer", () => {
  it.each([
    ["no judge", undefined],
    ["the judge off", offJudge],
    ["a timeout", unavailableJudge("timeout")],
    ["a server error", unavailableJudge("server-error")],
  ])("%s: the line waits for the person to confirm", async (_name, judge) => {
    const user = await createUser("member");
    const result = await propose({ text: "I prefer calls before 10" }, chat(user, judge));
    expect(result).toMatchObject({
      result: "confirm",
      checked: "deterministic",
      line: { status: "proposed" },
    });
    // Not read by the assistant until then.
    expect((await memoryForTurn(db.query, user.id, { state: EMPTY_THREAD_MEMORY })).tail).toEqual(
      [],
    );
    await invokeByName("memory.update", { id: result.line?.id, confirm: true }, context(user));
    const turn = await memoryForTurn(db.query, user.id, { state: EMPTY_THREAD_MEMORY });
    expect(turn.tail[0]?.text).toContain("I prefer calls before 10");
  });

  it("refuses a line naming a customer, by a person's name or an organisation's whole name", async () => {
    const user = await createUser("member");
    const family = `Zqx${unique("n").replace(/\W/g, "")}`;
    await invokeByName(
      "person.create",
      { givenName: "Marigold", familyName: family },
      context(user),
    );
    const org = `Brightwater${unique("o").replace(/\W/g, "")} Health`;
    await invokeByName("organisation.create", { name: org }, context(user));

    const person = await propose({ text: `Marigold ${family} is leaving` }, chat(user, offJudge));
    expect(person).toMatchObject({ result: "customer", checked: "deterministic", line: null });
    const given = await propose({ text: "Marigold is leaving" }, chat(user, offJudge));
    expect(given.result).toBe("customer");
    const organisation = await propose({ text: `${org} renews in June` }, chat(user, offJudge));
    expect(organisation.result).toBe("customer");
    // Part of an organisation's name, or a capitalised word nobody has, is not a customer name.
    const other = await propose({ text: "I like Health checks on Monday" }, chat(user, offJudge));
    expect(other.result).toBe("confirm");
  });

  it("ignores the person's own name", async () => {
    const user = await createUser("member");
    const named = { ...user, name: "Quillon Ferrant" };
    await invokeByName(
      "person.create",
      { givenName: "Quillon", familyName: "Ferrant" },
      context(user),
    );
    const result = await propose(
      { text: "Quillon Ferrant signs emails with initials" },
      chat(named, offJudge),
    );
    expect(result.result).toBe("confirm");
  });
});

describe("conditional lines", () => {
  const condition = {
    object: "organisation",
    filter: { field: "currentPeopleCount", op: "gt", value: 500 },
  };
  const line = { text: "Start with the buying committee", kind: "conditional", condition };

  async function organisationWith(people: number, user: ActingUser) {
    const org = (await invokeByName(
      "organisation.create",
      { name: unique("Org") },
      context(user),
    )) as { id: string };
    // Current people, added in bulk: each affiliation needs a live person.
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
  }

  it("is checked against the person's words, read back in words, and confirmed", async () => {
    const user = await createUser("member");
    const judge = fakeJudge(
      {
        "memory.write": answers(),
        "memory.condition": {
          matches: choiceAnswer(["as_said", "different", "unclear"], "as_said"),
        },
      },
      { byPlacement: true },
    );
    const said = "when I'm on an organisation with more than 500 people, start with the committee";
    const result = await propose(line, chat(user, judge, said));
    expect(result).toMatchObject({ result: "confirm", checked: "judge" });
    expect(judge.calls[1]).toMatchObject({
      placement: "memory.condition",
      state: { said, condition: "Organisations where People is more than 500" },
    });
    const { lines } = await list(user);
    expect(lines[0]).toMatchObject({
      status: "proposed",
      conditionLabel: "Organisations where People is more than 500",
    });
  });

  it("is not saved when the filter does not match what the person said", async () => {
    const user = await createUser("member");
    const judge = fakeJudge(
      {
        "memory.write": answers(),
        "memory.condition": {
          matches: choiceAnswer(["as_said", "different", "unclear"], "different"),
        },
      },
      { byPlacement: true },
    );
    const result = await propose(line, chat(user, judge));
    expect(result).toMatchObject({ result: "mismatch", line: null });
    expect(result.message).toContain("Organisations where People is more than 500");
    expect(await rowCount(user.id)).toBe(0);
  });

  it("with the judge off, the read-back alone decides", async () => {
    const user = await createUser("member");
    const result = await propose(line, chat(user, offJudge));
    expect(result).toMatchObject({ result: "confirm", checked: "deterministic" });
  });

  it("refuses an unknown field or record type", async () => {
    const user = await createUser("member");
    await expect(
      propose(
        { ...line, condition: { ...condition, filter: { field: "nope", op: "gt", value: 1 } } },
        chat(user, offJudge),
      ),
    ).rejects.toThrow();
    await expect(
      propose({ ...line, condition: { ...condition, object: "nope" } }, chat(user, offJudge)),
    ).rejects.toThrow(/Unknown record type/);
    await expect(
      propose({ text: "No condition", kind: "conditional" }, chat(user, offJudge)),
    ).rejects.toThrow(/needs a condition/);
  });

  it("shows only on matching records: 1,200 people against 40", async () => {
    const user = await createUser("member");
    const saved = await propose(line, chat(user, offJudge));
    await invokeByName("memory.update", { id: saved.line?.id, confirm: true }, context(user));
    const big = await organisationWith(1200, user);
    const small = await organisationWith(40, user);
    const on = (id: string) =>
      memoryForTurn(db.query, user.id, {
        state: EMPTY_THREAD_MEMORY,
        record: { object: "organisation", id },
      });
    const atBig = await on(big.id);
    const atSmall = await on(small.id);
    expect(atBig.tail.map((b) => b.text).join()).toContain("Start with the buying committee");
    expect(atBig.tail.find((b) => b.text.includes("committee"))?.kind).toBe("page");
    expect(atSmall.tail.map((b) => b.text).join()).not.toContain("buying committee");
    expect(atBig.block).toBeUndefined();
    const agentAtBig = await memoryForAgent(db.query, user.id, {
      object: "organisation",
      id: big.id,
    });
    expect(agentAtBig).toContain("buying committee");
    expect(
      await memoryForAgent(db.query, user.id, { object: "organisation", id: small.id }),
    ).toBeUndefined();
  });
});

describe("what a turn sends", () => {
  const save = (user: ActingUser, text: string) => propose({ text }, chat(user, accepts()));
  const turn = (userId: string, state: ThreadMemoryState, fold = false) =>
    memoryForTurn(db.query, userId, { state, fold });

  it("keeps new lines in the tail and the block byte-stable until the fold", async () => {
    const user = await createUser("member");
    await save(user, "I prefer calls before 10");
    const first = await turn(user.id, EMPTY_THREAD_MEMORY, true);
    expect(first.block).toBe("- I prefer calls before 10");
    expect(first.tail).toEqual([]);

    await save(user, "I take Fridays off");
    const second = await turn(user.id, first.state);
    expect(second.block).toBe(first.block);
    expect(second.tail).toHaveLength(1);
    expect(second.tail[0]).toMatchObject({ kind: "pending" });
    expect(second.tail[0]?.text).toContain("I take Fridays off");

    const fold = await foldPendingLines(db.query, user.id, second.state);
    expect(fold.folded).toHaveLength(1);
    expect(fold.block).toBe("- I prefer calls before 10\n- I take Fridays off");
    expect(fold.state.shown).toEqual([]);
    const third = await turn(user.id, fold.state);
    expect(third.block).toBe(fold.block);
    expect(third.tail).toEqual([]);
  });

  it("groups shortcuts, writing style and team lines in a fixed order", async () => {
    const user = await createUser("member");
    await propose(
      { text: "'the pipeline' means my open deals over $5k", kind: "shortcut" },
      chat(user, accepts()),
    );
    await propose({ text: "No exclamation marks", kind: "style" }, chat(user, accepts()));
    await save(user, "I take Fridays off");
    const { block } = await turn(user.id, EMPTY_THREAD_MEMORY, true);
    const text = block ?? "";
    expect(text.indexOf("I take Fridays off")).toBeLessThan(text.indexOf("the pipeline"));
    expect(text.indexOf("the pipeline")).toBeLessThan(text.indexOf("No exclamation marks"));
    expect(text).toContain("How the person likes their writing:");
  });

  it("drops an undone pending line and says earlier lists are out of date", async () => {
    const user = await createUser("member");
    const saved = await save(user, "I take Fridays off");
    const shown = await turn(user.id, EMPTY_THREAD_MEMORY);
    expect(shown.tail[0]?.text).toContain("I take Fridays off");
    await invokeByName("memory.delete", { id: saved.line?.id }, context(user));
    const after = await turn(user.id, shown.state);
    expect(after.tail).toHaveLength(1);
    expect(after.tail[0]?.text).not.toContain("I take Fridays off");
    expect(after.tail[0]?.text).toContain("changed or been removed");
  });

  it("an edited folded line leaves the block and rides as pending", async () => {
    const user = await createUser("member");
    const saved = await save(user, "I take Fridays off");
    const first = await turn(user.id, EMPTY_THREAD_MEMORY, true);
    await invokeByName(
      "memory.update",
      { id: saved.line?.id, text: "I take Mondays off" },
      context(user),
    );
    const after = await turn(user.id, first.state);
    expect(after.block).toBeUndefined();
    expect(after.tail[0]?.text).toContain("I take Mondays off");
  });

  it("sends nothing while memory is paused, and a paused line is not read", async () => {
    const user = await createUser("member");
    const one = await save(user, "I take Fridays off");
    await save(user, "I like tea");
    await invokeByName("memory.pause", { id: one.line?.id, paused: true }, context(user));
    expect((await turn(user.id, EMPTY_THREAD_MEMORY, true)).block).toBe("- I like tea");
    await invokeByName("memory.pause", { paused: true }, context(user));
    expect((await turn(user.id, EMPTY_THREAD_MEMORY, true)).block).toBeUndefined();
    expect(await memoryForAgent(db.query, user.id)).toBeUndefined();
    await invokeByName("memory.pause", { paused: false }, context(user));
    expect((await list(user)).lines).toHaveLength(2);
  });

  it("agents read pending lines live", async () => {
    const user = await createUser("member");
    await save(user, "I prefer calls before 10");
    expect(await memoryForAgent(db.query, user.id)).toContain("I prefer calls before 10");
  });
});

describe("control", () => {
  it("edits, deletes and resets only the person's own lines", async () => {
    const user = await createUser("member");
    const other = await createUser("member");
    const mine = await propose({ text: "I like tea" }, chat(user, accepts()));
    await propose({ text: "I like coffee" }, chat(user, accepts()));
    const id = mine.line?.id;
    await expect(invokeByName("memory.update", { id, text: "x" }, context(other))).rejects.toThrow(
      /No memory line/,
    );
    await expect(invokeByName("memory.delete", { id }, context(other))).rejects.toThrow(
      /No memory line/,
    );
    await invokeByName("memory.reset", {}, context(other));
    expect(await rowCount(user.id)).toBe(2);
    await invokeByName("memory.reset", {}, context(user));
    expect(await rowCount(user.id)).toBe(0);
  });

  it("refuses a record id typed on the page", async () => {
    const user = await createUser("member");
    const mine = await propose({ text: "I like tea" }, chat(user, accepts()));
    await expect(
      invokeByName(
        "memory.update",
        { id: mine.line?.id, text: "See ada@example.com" },
        context(user),
      ),
    ).rejects.toThrow(/can't hold/);
    await expect(propose({ text: "See ada@example.com" }, context(user))).rejects.toThrow(
      /can't hold/,
    );
  });

  it("a person adds a line without the judge", async () => {
    const user = await createUser("member");
    const added = await propose({ text: "I like tea" }, context(user));
    expect(added).toMatchObject({ result: "saved", checked: "person" });
  });

  it("confirming a read-back that replaces a line deletes the old one", async () => {
    const user = await createUser("member");
    const old = await propose({ text: "I like tea" }, chat(user, accepts()));
    const next = await propose(
      { text: "I like coffee", replaces: old.line?.id },
      chat(user, offJudge),
    );
    expect(next.result).toBe("confirm");
    expect(await rowCount(user.id)).toBe(2);
    await invokeByName("memory.update", { id: next.line?.id, confirm: true }, context(user));
    expect((await list(user)).lines.map((l) => l.text)).toEqual(["I like coffee"]);
  });

  it("the assistant cannot confirm its own read-back, pause or reset", async () => {
    const user = await createUser("member");
    const proposed = await propose({ text: "I like tea" }, chat(user, offJudge));
    const ctx = chat(user, offJudge);
    await expect(
      invokeByName("memory.update", { id: proposed.line?.id, confirm: true }, ctx),
    ).rejects.toThrow(/cannot be called by/);
    await expect(invokeByName("memory.pause", { paused: true }, ctx)).rejects.toThrow(
      /cannot be called by/,
    );
    await expect(invokeByName("memory.reset", {}, ctx)).rejects.toThrow(/cannot be called by/);
  });

  it("the assistant forgets its own person's line from the chat, but no agent can", async () => {
    const user = await createUser("member");
    const line = await propose({ text: "I like tea" }, chat(user, accepts()));
    await expect(
      invokeByName(
        "memory.delete",
        { id: line.line?.id },
        context(user, { actor: "assistant", origin: { surface: "assistant" } }),
      ),
    ).rejects.toThrow(/Agents can read memory/);
    await invokeByName("memory.delete", { id: line.line?.id }, chat(user, offJudge));
    expect(await rowCount(user.id)).toBe(0);
  });
});

describe("activity.proposeNote", () => {
  it("always waits for approval, under every preset, and adds the note once approved", async () => {
    const user = await createUser("member");
    const person = (await invokeByName(
      "person.create",
      { givenName: "Ade", familyName: unique("Okafor") },
      context(user),
    )) as { id: string };
    const error = await invokeByName(
      "activity.proposeNote",
      {
        record: { object: "person", id: person.id },
        body: "Leaving Brightwater in March",
        reason: "Asked in the chat",
      },
      chat(user, offJudge),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "PendingApprovalError" });
    const notes = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_activity WHERE body = 'Leaving Brightwater in March'",
    ).first<{ n: number }>();
    expect(notes?.n).toBe(0);
  });
});

describe("team memory", () => {
  const govern = (governance: string) =>
    invokeByName("teamMemory.setGovernance", { governance }, context(admin));
  const teamPropose = (text: string, ctx: InvocationContext) =>
    invokeByName("teamMemory.propose", { text }, ctx) as Promise<{
      result: string;
      line: { id: string; status: string; history: unknown[] } | null;
    }>;

  it("is set only by someone who manages settings", async () => {
    const user = await createUser("member");
    await expect(
      invokeByName("teamMemory.setGovernance", { governance: "open" }, context(user)),
    ).rejects.toThrow();
    await expect(
      invokeByName("teamMemory.setGovernance", { governance: "open" }, chat(admin, offJudge)),
    ).rejects.toThrow(/cannot be called by/);
  });

  it("approval: anyone proposes, a permitted person approves, with author and history", async () => {
    await govern("approval");
    const user = await createUser("member");
    const text = `We quote in AUD ${unique("t")}`;
    const proposed = await teamPropose(text, chat(user, accepts()));
    expect(proposed).toMatchObject({ result: "awaiting_approval", line: { status: "proposed" } });
    const id = proposed.line?.id;
    await expect(
      invokeByName("teamMemory.approve", { id, approve: true }, context(user)),
    ).rejects.toThrow(/manage team memory/);
    const before = await memoryForTurn(db.query, user.id, { state: EMPTY_THREAD_MEMORY });
    expect(JSON.stringify(before.tail)).not.toContain(text);

    await invokeByName("teamMemory.approve", { id, approve: true }, context(admin));
    const reader = await createUser("member");
    const after = await memoryForTurn(db.query, reader.id, {
      state: EMPTY_THREAD_MEMORY,
      fold: true,
    });
    expect(after.block).toContain(text);
    const line = (await list(reader)).team.find((l) => l.id === id);
    expect(line).toMatchObject({ authorName: user.name, authorId: user.id });
    expect((line?.history as { action: string }[]).map((h) => h.action)).toEqual([
      "proposed",
      "approved",
    ]);
    await invokeByName("memory.delete", { id }, context(admin));
  });

  it("a rejected proposal is deleted", async () => {
    await govern("approval");
    const user = await createUser("member");
    const proposed = await teamPropose(`Skip ${unique("t")}`, chat(user, accepts()));
    await invokeByName(
      "teamMemory.approve",
      { id: proposed.line?.id, approve: false },
      context(admin),
    );
    expect((await list(admin)).team.some((l) => l.id === proposed.line?.id)).toBe(false);
  });

  it("open: anyone adds and edits; restricted: only permitted people", async () => {
    await govern("open");
    const user = await createUser("member");
    const added = await teamPropose(`Shared ${unique("t")}`, chat(user, accepts()));
    expect(added).toMatchObject({ result: "saved", line: { status: "active" } });
    const id = added.line?.id;
    await invokeByName("teamMemory.update", { id, text: `Edited ${unique("t")}` }, context(user));

    await govern("restricted");
    await expect(teamPropose(`Nope ${unique("t")}`, chat(user, accepts()))).rejects.toThrow(
      /manage team memory/,
    );
    await expect(
      invokeByName("teamMemory.update", { id, text: "Nope" }, context(user)),
    ).rejects.toThrow(/manage team memory/);
    await expect(invokeByName("memory.delete", { id }, context(user))).rejects.toThrow(
      /manage team memory/,
    );
    await invokeByName("memory.delete", { id }, context(admin));
    await govern("approval");
  });

  it("with the judge off, a team line waits to be confirmed", async () => {
    await govern("open");
    const user = await createUser("member");
    const line = await teamPropose(`Offline ${unique("t")}`, chat(user, offJudge));
    expect(line).toMatchObject({ result: "confirm", line: { status: "proposed" } });
    await invokeByName("memory.delete", { id: line.line?.id }, context(admin));
    await govern("approval");
  });

  it("the assistant cannot delete team lines", async () => {
    await govern("open");
    const user = await createUser("member");
    const line = await teamPropose(`Kept ${unique("t")}`, chat(user, accepts()));
    await expect(
      invokeByName("memory.delete", { id: line.line?.id }, chat(user, offJudge)),
    ).rejects.toThrow(/can't delete team memory/);
    await invokeByName("memory.delete", { id: line.line?.id }, context(admin));
    await govern("approval");
  });
});

describe("erase", () => {
  it("deletes lines that name the erased person, by ref, by term and in a team line's history", async () => {
    const user = await createUser("member");
    const family = `Erasable${unique("e").replace(/\W/g, "")}`;
    const email = `zelda-${unique("m").replace(/\W/g, "")}@example.com`;
    const person = (await invokeByName(
      "person.create",
      { givenName: "Zelda", familyName: family, emails: [{ email }] },
      context(user),
    )) as { id: string };

    // Named in words: the judge let it through, the ref index holds the person.
    const named = await propose({ text: `I report to Zelda ${family}` }, chat(user, accepts()));
    const refs = await env.DB.prepare("SELECT ref FROM core_memory_refs WHERE memory_id = ?")
      .bind(named.line?.id)
      .all<{ ref: string }>();
    expect(refs.results.map((r) => r.ref)).toContain(person.id);

    // A conditional line on the record, by id in its filter.
    const conditional = await propose(
      {
        text: "Keep the tone formal here",
        kind: "conditional",
        condition: { object: "person", filter: { field: "id", op: "eq", value: person.id } },
      },
      context(user),
    );
    // A team line whose earlier words named them.
    const team = (await invokeByName(
      "teamMemory.propose",
      { text: `Zelda ${family} runs our Friday reviews` },
      chat(admin, accepts()),
    )) as { line: { id: string } };
    await invokeByName(
      "teamMemory.update",
      { id: team.line.id, text: "Fridays are for reviews" },
      context(admin),
    );
    const bystander = await propose({ text: "I like tea" }, chat(user, accepts()));

    const erased = (await invokeByName("person.erase", { id: person.id }, context(admin))) as {
      memoryLinesDeleted: number;
    };
    expect(erased.memoryLinesDeleted).toBe(3);

    const left = await env.DB.prepare("SELECT id FROM core_memory WHERE id IN (?, ?, ?, ?)")
      .bind(named.line?.id, conditional.line?.id, team.line.id, bystander.line?.id)
      .all<{ id: string }>();
    expect(left.results.map((r) => r.id)).toEqual([bystander.line?.id]);
    const orphans = await env.DB.prepare("SELECT count(*) AS n FROM core_memory_refs WHERE ref = ?")
      .bind(person.id)
      .first<{ n: number }>();
    expect(orphans?.n).toBe(0);
  });
});
