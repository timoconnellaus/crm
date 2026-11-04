// view.* (saved views) and audit.* (Audit page, History tab) on real D1.
import { describe, expect, it } from "vitest";
import {
  type ActingUser,
  ForbiddenError,
  invoke,
  NotFoundError,
  ValidationError,
} from "../src/index.ts";
import { createPerson } from "./fixtures.ts";
import { context, createUser, unique } from "./helpers.ts";

describe("saved views", () => {
  it("persist per user and reload exactly", async () => {
    const alice = await createUser("member");
    const bob = await createUser("member");
    const spec = {
      type: "table" as const,
      object: "person" as const,
      filter: {
        and: [
          { field: "tags", op: "eq" as const, value: "VIP" },
          { field: "organisationName", op: "contains" as const, value: "acme" },
        ],
      },
      sort: { field: "createdAt", direction: "desc" as const },
      columns: ["displayName", "primaryEmail", "organisationName", "tags"],
    };
    const view = await invoke("view.create", { name: "VIPs at Acme", spec }, context(alice));
    expect(view.id).toMatch(/^vw_/);
    expect(view.position).toBe(0);
    const second = await invoke(
      "view.create",
      { name: "All", spec: { type: "table", object: "person", columns: ["displayName"] } },
      context(alice),
    );
    expect(second.position).toBe(1);

    const listed = await invoke("view.list", { object: "person" }, context(alice));
    expect(listed.items.map((v) => v.name)).toEqual(["VIPs at Acme", "All"]);
    expect(listed.items[0]?.spec).toEqual(spec);
    expect(listed.items[0]).toEqual(view);

    // Bob sees none of Alice's views and cannot touch them.
    expect((await invoke("view.list", {}, context(bob))).items).toEqual([]);
    await expect(
      invoke("view.update", { id: view.id, name: "mine now" }, context(bob)),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(invoke("view.delete", { id: view.id }, context(bob))).rejects.toBeInstanceOf(
      NotFoundError,
    );

    const renamed = await invoke(
      "view.update",
      {
        id: view.id,
        name: "VIPs",
        spec: { ...spec, columns: ["displayName"], sort: null, filter: null },
      },
      context(alice),
    );
    expect(renamed.spec).toEqual({
      type: "table",
      object: "person",
      filter: null,
      sort: null,
      columns: ["displayName"],
    });
    const history = await invoke(
      "audit.listForRecord",
      { object: "view", recordId: view.id },
      context(alice),
    );
    expect(history.items.map((h) => h.action)).toEqual(["update", "create"]);
    expect(history.items[0]?.diff.name).toEqual({ before: "VIPs at Acme", after: "VIPs" });

    await invoke("view.delete", { id: second.id }, context(alice));
    expect((await invoke("view.list", {}, context(alice))).items.map((v) => v.id)).toEqual([
      view.id,
    ]);
  });

  it("validates specs against the field registry", async () => {
    const user = await createUser("member");
    const create = (spec: unknown) =>
      // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid specs.
      invoke("view.create", { name: "x", spec } as any, context(user));
    await expect(create({ type: "table", object: "person", columns: ["nope"] })).rejects.toThrow(
      /Unknown person columns: nope/,
    );
    await expect(
      create({ type: "table", object: "spaceship", columns: ["id"] }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      create({
        type: "table",
        object: "task",
        columns: ["title"],
        filter: { field: "secret", op: "eq", value: 1 },
      }),
    ).rejects.toThrow(/unknown field/);
    await expect(
      create({ type: "table", object: "task", columns: ["title"], sort: { field: "notes" } }),
    ).rejects.toThrow(/not sortable/);
    await expect(
      create({ type: "dashboard", object: "task", columns: ["title"] }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      create({ type: "table", object: "task", columns: ["title", "title"] }),
    ).rejects.toThrow(/twice/);
  });

  it("lets viewers list but not save views", async () => {
    const viewer = await createUser("viewer");
    expect((await invoke("view.list", {}, context(viewer))).items).toEqual([]);
    await expect(
      invoke(
        "view.create",
        { name: "x", spec: { type: "table", object: "task", columns: ["title"] } },
        context(viewer),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("audit", () => {
  let admin: ActingUser;
  let member: ActingUser;

  it("audit.list filters by user, actor, operation, record and date, and paginates", async () => {
    admin = await createUser("admin");
    member = await createUser("member");
    const t0 = new Date("2030-01-01T00:00:00.000Z");
    const at = (minutes: number) => () => new Date(t0.getTime() + minutes * 60_000);
    const person = await invoke(
      "person.create",
      { displayName: unique("Audited") },
      context(member, { clock: at(0) }),
    );
    await invoke(
      "person.update",
      { id: person.id, location: "Perth" },
      context(member, { clock: at(1) }),
    );
    const task = await invoke("task.create", { title: "t" }, context(member, { clock: at(2) }));
    await invoke("task.complete", { id: task.id }, context(member, { clock: at(3) }));
    // A refused call is audited too.
    await expect(
      invoke("audit.list", {}, context(member, { clock: at(4) })),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const all = await invoke("audit.list", { userId: member.id }, context(admin));
    expect(all.items.map((e) => e.operation)).toEqual([
      "audit.list",
      "task.complete",
      "task.create",
      "person.update",
      "person.create",
    ]);
    expect(all.items[0]?.outcome).toBe("forbidden");
    expect(all.items[3]?.changes).toEqual([
      {
        object: "person",
        recordId: person.id,
        action: "update",
        diff: { location: { before: null, after: "Perth" } },
      },
    ]);
    expect(all.items[3]?.userName).toBe("member user");
    expect(all.items[3]?.origin).toEqual({ surface: "ui" });

    const people = await invoke(
      "audit.list",
      { userId: member.id, operation: "person.*" },
      context(admin),
    );
    expect(people.items.map((e) => e.operation)).toEqual(["person.update", "person.create"]);

    const exact = await invoke(
      "audit.list",
      { userId: member.id, operation: "task.create" },
      context(admin),
    );
    expect(exact.items).toHaveLength(1);

    const byRecord = await invoke(
      "audit.list",
      { object: "task", recordId: task.id },
      context(admin),
    );
    expect(byRecord.items.map((e) => e.operation)).toEqual(["task.complete", "task.create"]);

    const window = await invoke(
      "audit.list",
      {
        userId: member.id,
        from: "2030-01-01T00:01:00Z",
        to: "2030-01-01T00:03:00Z",
      },
      context(admin),
    );
    expect(window.items.map((e) => e.operation)).toEqual(["task.create", "person.update"]);

    const humans = await invoke(
      "audit.list",
      { userId: member.id, actor: "assistant" },
      context(admin),
    );
    expect(humans.items).toEqual([]);

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await invoke(
        "audit.list",
        { userId: member.id, limit: 2, ...(cursor ? { cursor } : {}) },
        context(admin),
      );
      seen.push(...page.items.map((e) => e.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(all.items.map((e) => e.id));
  });

  it("audit.listForRecord returns field diffs for the History tab", async () => {
    const user = await createUser("member");
    const viewer = await createUser("viewer");
    const person = await createPerson(user);
    await invoke("person.update", { id: person.id, location: "Hobart" }, context(user));
    await invoke("person.update", { id: person.id, location: "Darwin" }, context(user));
    const first = await invoke(
      "audit.listForRecord",
      { object: "person", recordId: person.id, limit: 2 },
      context(viewer),
    );
    expect(first.items.map((h) => h.diff.location)).toEqual([
      { before: "Hobart", after: "Darwin" },
      { before: null, after: "Hobart" },
    ]);
    expect(first.items[0]).toMatchObject({
      operation: "person.update",
      actor: "human",
      userId: user.id,
      action: "update",
    });
    const next = await invoke(
      "audit.listForRecord",
      { object: "person", recordId: person.id, limit: 2, cursor: first.nextCursor ?? "" },
      context(viewer),
    );
    expect(next.items.map((h) => h.action)).toEqual(["create"]);
    expect(next.nextCursor).toBeNull();
  });
});
