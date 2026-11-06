// An agent's grant (ADR 0344): where each call goes, and that it never exceeds its starter.
import { describe, expect, it } from "vitest";
import {
  type AnyOperation,
  EMPTY_GRANT_USAGE,
  type Grant,
  grantGuard,
  ungrantable,
} from "../src/index.ts";

const NOW = "2026-11-07T10:00:00.000Z";
const IN_SCOPE = "org_1";

const grant = (over: Partial<Grant> = {}): Grant => ({
  operations: ["organisation.get", "organisation.update", "activity.log", "task.create"],
  target: { ids: [IN_SCOPE] },
  caps: { changes: 2, notes: 1, tasks: 1 },
  expiresAt: "2026-11-07T18:00:00.000Z",
  ...over,
});

const op = (name: string, risk = "write") => ({ name, risk }) as unknown as AnyOperation;
const guardFor = (g: Grant = grant(), reviewEverything = false) =>
  grantGuard({ jobId: "job_1", grant: g, reviewEverything, used: EMPTY_GRANT_USAGE });
const db = undefined as never;

const fill = (id = IN_SCOPE) => ({
  object: "organisation",
  id,
  action: "update" as const,
  diff: { website: { before: null, after: "https://x.example" } },
});
const change = {
  object: "organisation",
  id: IN_SCOPE,
  action: "update" as const,
  diff: { website: { before: "https://old.example", after: "https://x.example" } },
};
const note = (link = `organisation:${IN_SCOPE}`) => ({
  object: "activity",
  id: "act_1",
  action: "create" as const,
  after: { type: "note", links: [link] },
});
const task = {
  object: "task",
  id: "tsk_1",
  action: "create" as const,
  after: { title: "Call", links: [`organisation:${IN_SCOPE}`] },
};

describe("grant routing", () => {
  const update = op("organisation.update");

  it("lets an empty field, a note and a task through on an in-scope record", async () => {
    const guard = guardFor();
    expect(await guard.route(update, [fill()], NOW, db)).toBe("auto");
    expect(await guard.route(op("activity.log"), [note()], NOW, db)).toBe("auto");
    expect(await guard.route(op("task.create"), [task], NOW, db)).toBe("auto");
  });

  it("stages a changed value, a create and an email-like risk", async () => {
    const guard = guardFor();
    expect(await guard.route(update, [change], NOW, db)).toBe("stage");
    expect(
      await guard.route(
        update,
        [{ object: "person", id: "per_1", action: "create" as const }],
        NOW,
        db,
      ),
    ).toBe("stage");
    const send = guardFor(grant({ operations: ["x.send"] }));
    expect(await send.route(op("x.send", "outbound"), [], NOW, db)).toBe("stage");
    const remove = guardFor(grant({ operations: ["organisation.delete"] }));
    expect(await remove.route(op("organisation.delete", "destructive"), [fill()], NOW, db)).toBe(
      "stage",
    );
  });

  it("sends what is outside the operations or the target back on its own", async () => {
    const guard = guardFor();
    expect(await guard.route(op("person.update"), [fill()], NOW, db)).toBe("outside");
    expect(await guard.route(update, [fill("org_2")], NOW, db)).toBe("outside");
    expect(await guard.route(op("activity.log"), [note("organisation:org_2")], NOW, db)).toBe(
      "outside",
    );
  });

  it("stages everything past a cap or the expiry, or when the person asked to see it all", async () => {
    const guard = guardFor();
    guard.applied([fill(), fill()]);
    expect(await guard.route(update, [fill()], NOW, db)).toBe("stage");
    const late = guardFor(grant({ expiresAt: "2026-11-07T09:00:00.000Z" }));
    expect(await late.route(update, [fill()], NOW, db)).toBe("stage");
    expect(await guardFor(grant(), true).route(update, [fill()], NOW, db)).toBe("stage");
  });

  it("allows reads only on its list, and its own status", () => {
    const guard = guardFor();
    expect(guard.allowsRead(op("organisation.get", "read"))).toBe(true);
    expect(guard.allowsRead(op("approval.status", "read"))).toBe(true);
    expect(guard.allowsRead(op("person.list", "read"))).toBe(false);
  });
});

describe("what can never be granted", () => {
  it("keeps memory, approvals, agents and anything that runs other operations out", () => {
    for (const name of [
      "memory.propose",
      "approval.decide",
      "agent.start",
      "code.run",
      "a2ui.act",
      "policy.update",
    ]) {
      expect(ungrantable(name)).not.toBeNull();
    }
    expect(ungrantable("organisation.update")).toBeNull();
    expect(ungrantable("integration.call")).toBeNull();
  });
});
