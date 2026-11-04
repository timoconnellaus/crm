// task.* operations end to end on real D1.
import { describe, expect, it } from "vitest";
import {
  type ActingUser,
  dueBucket,
  ForbiddenError,
  invoke,
  ValidationError,
} from "../src/index.ts";
import { createPerson, insertOrganisation } from "./fixtures.ts";
import { auditChanges, context, createUser, timeline } from "./helpers.ts";

let member: ActingUser;
let viewer: ActingUser;
async function setup() {
  member ??= await createUser("member");
  viewer ??= await createUser("viewer");
}

describe("task lifecycle", () => {
  it("creates, updates, completes, reopens, deletes and restores a task", async () => {
    await setup();
    const person = await createPerson(member);
    const org = await insertOrganisation();
    const task = await invoke(
      "task.create",
      {
        title: "Send proposal",
        dueAt: "2026-11-10",
        links: [
          { object: "person", id: person.id },
          { object: "organisation", id: org.id },
        ],
      },
      context(member),
    );
    expect(task).toMatchObject({
      title: "Send proposal",
      status: "open",
      dueAt: "2026-11-10",
      assigneeId: member.id,
      assigneeName: "member user",
      createdBy: member.id,
    });
    expect(task.links.map((l) => l.title).sort()).toEqual([org.name, person.displayName].sort());

    const updated = await invoke(
      "task.update",
      { id: task.id, dueAt: "2026-11-12T09:30:00+11:00", notes: "With pricing", assigneeId: null },
      context(member),
    );
    expect(updated.dueAt).toBe("2026-11-11T22:30:00.000Z");
    expect(updated.assigneeId).toBeNull();
    expect(updated.notes).toBe("With pricing");

    const done = await invoke("task.complete", { id: task.id }, context(member));
    expect(done.status).toBe("done");
    expect(done.completedBy).toBe(member.id);
    expect(done.completedAt).toBeTruthy();
    // Completing again is a no-op.
    expect((await invoke("task.complete", { id: task.id }, context(member))).completedAt).toBe(
      done.completedAt,
    );
    // The completion is on the person's and organisation's timelines and the task's own.
    for (const [object, id] of [
      ["person", person.id],
      ["organisation", org.id],
      ["task", task.id],
    ] as const) {
      const posts = (await timeline(object, id)).filter((a) => a.payload.kind === "task_completed");
      expect(posts).toHaveLength(1);
      expect(posts[0]?.subject).toBe("Task completed: Send proposal");
    }

    const reopened = await invoke("task.reopen", { id: task.id }, context(member));
    expect(reopened.status).toBe("open");
    expect(reopened.completedAt).toBeNull();

    await invoke("task.delete", { id: task.id }, context(member));
    await expect(invoke("task.get", { id: task.id }, context(member))).rejects.toThrow(/No task/);
    const restored = await invoke("task.restore", { id: task.id }, context(member));
    expect(restored.deletedAt).toBeNull();

    expect((await auditChanges(task.id)).map((c) => c.action)).toEqual([
      "create",
      "update",
      "update",
      "update",
      "delete",
      "restore",
    ]);
    const updateDiff = (await auditChanges(task.id))[1]?.diff;
    expect(Object.keys(updateDiff ?? {}).sort()).toEqual(["assigneeId", "dueAt", "notes"]);
  });

  it("validates input and refuses viewers", async () => {
    await setup();
    await expect(invoke("task.create", { title: "  " }, context(member))).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      invoke("task.create", { title: "x", dueAt: "next tuesday" }, context(member)),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      invoke("task.create", { title: "x", assigneeId: "usr_nobody" }, context(member)),
    ).rejects.toThrow(/No user/);
    await expect(
      invoke(
        "task.create",
        { title: "x", links: [{ object: "person", id: "per_x" }] },
        context(member),
      ),
    ).rejects.toThrow(/No live person/);
    await expect(invoke("task.create", { title: "x" }, context(viewer))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe("task.list", () => {
  it("filters with filter JSON, including by linked record, and paginates", async () => {
    await setup();
    const person = await createPerson(member);
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const t = await invoke(
        "task.create",
        {
          title: `Linked ${i}`,
          dueAt: `2027-01-0${i}`,
          links: [{ object: "person", id: person.id }],
        },
        context(member),
      );
      ids.push(t.id);
    }
    await invoke("task.complete", { id: ids[0] as string }, context(member));

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await invoke(
        "task.list",
        {
          filter: { field: "linkedRecordId", op: "eq", value: person.id },
          limit: 2,
          ...(cursor ? { cursor } : {}),
        },
        context(viewer),
      );
      seen.push(...page.items.map((t) => t.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(ids);

    const open = await invoke(
      "task.list",
      {
        filter: {
          and: [
            { field: "linkedRecordId", op: "eq", value: person.id },
            { field: "status", op: "eq", value: "open" },
          ],
        },
        sort: { field: "dueAt", direction: "desc" },
        fields: ["title"],
      },
      context(member),
    );
    expect(open.items).toEqual([
      { id: ids[4], title: "Linked 5" },
      { id: ids[3], title: "Linked 4" },
      { id: ids[2], title: "Linked 3" },
      { id: ids[1], title: "Linked 2" },
    ]);
    await expect(
      invoke("task.list", { filter: { field: "nope", op: "eq", value: 1 } }, context(member)),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("task.listMine", () => {
  it("groups my open tasks into due buckets in my timezone", async () => {
    const me = await createUser("member");
    const other = await createUser("member");
    // Wednesday 2026-11-04 12:00 UTC: 23:00 the same day in Sydney (UTC+11).
    const clock = () => new Date("2026-11-04T12:00:00.000Z");
    const make = (title: string, dueAt: string | null, assigneeId = me.id) =>
      invoke("task.create", { title, dueAt, assigneeId }, context(me, { clock }));
    await make("overdue", "2026-11-03");
    await make("today", "2026-11-04");
    await make("sunday", "2026-11-08");
    await make("monday", "2026-11-09");
    await make("no date", null);
    await make("early utc tomorrow sydney", "2026-11-04T14:00:00Z");
    await make("someone else's", "2026-11-04", other.id);
    const done = await make("done", "2026-11-04");
    await invoke("task.complete", { id: done.id }, context(me, { clock }));

    const titles = (b: { title: string }[]) => b.map((t) => t.title);
    const sydney = await invoke(
      "task.listMine",
      { timezone: "Australia/Sydney" },
      context(me, { clock }),
    );
    expect(sydney.today).toBe("2026-11-04");
    expect(titles(sydney.buckets.overdue)).toEqual(["overdue"]);
    expect(titles(sydney.buckets.today)).toEqual(["today"]);
    expect(titles(sydney.buckets.thisWeek).sort()).toEqual(["early utc tomorrow sydney", "sunday"]);
    expect(titles(sydney.buckets.later)).toEqual(["monday"]);
    expect(titles(sydney.buckets.none)).toEqual(["no date"]);
    expect(sydney.counts).toEqual({ overdue: 1, today: 1, thisWeek: 2, later: 1, none: 1 });

    const utc = await invoke("task.listMine", {}, context(me, { clock }));
    expect(titles(utc.buckets.today).sort()).toEqual(["early utc tomorrow sydney", "today"]);

    await expect(
      invoke("task.listMine", { timezone: "Mars/Olympus" }, context(me)),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("puts Sunday's later dates in later", () => {
    // Today is Sunday: this week has nothing after today.
    expect(dueBucket("2026-11-09", "2026-11-08", "UTC")).toBe("later");
    expect(dueBucket("2026-11-08", "2026-11-08", "UTC")).toBe("today");
  });
});
