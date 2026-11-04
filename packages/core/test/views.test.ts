// View types (stage 4a, ADR 0027, ADR 0056): board, calendar and gallery specs, personal and
// shared views, stored stage-1 table views, board column totals (record.groups), core fields
// through record.list, and select choices that require fields (the board's validation dialog).
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  ForbiddenError,
  invoke,
  NotFoundError,
  parseStoredViewSpec,
  ValidationError,
} from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, unique } from "./helpers.ts";

const ext = extId("vw");
const project = `${ext}.project`;

let admin: ActingUser;
let alice: ActingUser;
let bob: ActingUser;

beforeAll(async () => {
  admin = await createUser("admin");
  alice = await createUser("member");
  bob = await createUser("member");
  await reconcile(
    manifest(ext, {
      objects: {
        project: {
          label: "Project",
          plural: "Projects",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            status: {
              type: "select",
              label: "Status",
              options: [
                { value: "planned", label: "Planned" },
                { value: "active", label: "Active" },
                { value: "done", label: "Done", requires: ["spent"] },
              ],
            },
            budget: { type: "currency", label: "Budget" },
            spent: { type: "currency", label: "Spent" },
            dueDate: { type: "date", label: "Due date" },
            logo: { type: "url", label: "Logo" },
            organisation: { type: "relation", label: "Organisation", to: "organisation" },
          },
        },
      },
    }),
  );
});

describe("view specs", () => {
  const create = (user: ActingUser, spec: unknown, shared = false) =>
    // biome-ignore lint/suspicious/noExplicitAny: specs under test, valid and not.
    invoke("view.create", { name: unique("View"), spec, shared } as any, context(user));

  it("saves board, calendar and gallery views of core and extension objects", async () => {
    const board = await create(alice, {
      type: "board",
      object: "task",
      groupBy: "status",
      cardFields: ["dueAt", "assigneeId"],
    });
    expect(board.spec).toEqual({
      type: "board",
      object: "task",
      filter: null,
      sort: null,
      groupBy: "status",
      columnOrder: null,
      hiddenColumns: null,
      sumField: null,
      cardFields: ["dueAt", "assigneeId"],
    });
    const projects = await create(alice, {
      type: "board",
      object: project,
      groupBy: "status",
      sumField: "budget",
      columnOrder: ["active", "planned"],
      cardFields: ["budget"],
    });
    expect(projects.spec).toMatchObject({ sumField: "budget", columnOrder: ["active", "planned"] });
    const calendar = await create(alice, { type: "calendar", object: "task", dateField: "dueAt" });
    expect(calendar.spec).toMatchObject({ type: "calendar", mode: "month", cardFields: [] });
    const gallery = await create(alice, {
      type: "gallery",
      object: "person",
      cardFields: ["jobTitle", "organisationName"],
      sort: { field: "displayName", direction: "asc" },
    });
    expect(gallery.spec).toMatchObject({ type: "gallery", imageField: null });
    const logos = await create(alice, { type: "gallery", object: project, imageField: "logo" });
    expect(logos.spec).toMatchObject({ imageField: "logo" });

    // A table view can become a board (same object, new type).
    const table = await create(alice, { type: "table", object: "task", columns: ["title"] });
    const changed = await invoke(
      "view.update",
      { id: table.id, spec: { type: "board", object: "task", groupBy: "status" } },
      context(alice),
    );
    expect(changed.spec.type).toBe("board");
  });

  it.each([
    [{ type: "board", object: "task", groupBy: "title" }, /not a single-select/],
    [{ type: "board", object: "task", groupBy: "nope" }, /no field "nope"/],
    [{ type: "board", object: "task", groupBy: "status", sumField: "title" }, /not a number/],
    [{ type: "calendar", object: "task", dateField: "status" }, /not a date/],
    [{ type: "gallery", object: "person", imageField: "tags" }, /not a text or URL/],
    [{ type: "gallery", object: "person", cardFields: ["jobTitle", "jobTitle"] }, /twice/],
    [{ type: "dashboard", object: "task", widgets: [] }, /./],
  ])("refuses %j", async (spec, message) => {
    const error = await create(alice, spec).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(String((error as Error).message)).toMatch(message);
  });

  it("reads stored stage-1 table specs, and a spec without a type as a table", () => {
    const stored = {
      type: "table",
      object: "person",
      filter: null,
      sort: { field: "createdAt", direction: "desc" },
      columns: ["displayName"],
    };
    expect(parseStoredViewSpec(JSON.stringify(stored))).toEqual(stored);
    const { type: _type, ...untyped } = stored;
    expect(parseStoredViewSpec(JSON.stringify(untyped))).toEqual(stored);
  });

  it("loads a view stored before stage 4 through view.list", async () => {
    const id = `vw_${unique("legacy").toUpperCase()}`;
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO core_views (id, user_id, object, name, spec, position, created_at, updated_at) VALUES (?, ?, 'task', 'Old', ?, 0, ?, ?)",
    )
      .bind(
        id,
        bob.id,
        JSON.stringify({ type: "table", object: "task", filter: null, sort: null, columns: ["title"] }),
        now,
        now,
      )
      .run();
    const listed = await invoke("view.list", { object: "task" }, context(bob));
    expect(listed.items.find((v) => v.id === id)).toMatchObject({
      shared: false,
      canEdit: true,
      spec: { type: "table", columns: ["title"] },
    });
  });
});

describe("personal and shared views", () => {
  it("shows shared views to everyone and lets only the owner and admins change them", async () => {
    const viewer = await createUser("viewer");
    const spec = { type: "board", object: "task", groupBy: "status" } as const;
    const personal = await invoke("view.create", { name: "Mine", spec }, context(alice));
    const shared = await invoke(
      "view.create",
      { name: "Team board", spec, shared: true },
      context(alice),
    );
    expect(shared).toMatchObject({ shared: true, canEdit: true, ownerId: alice.id });

    for (const user of [bob, viewer, admin]) {
      const ids = (await invoke("view.list", { object: "task" }, context(user))).items.map((v) => v.id);
      expect(ids).toContain(shared.id);
      expect(ids).not.toContain(personal.id);
    }
    expect((await invoke("view.get", { id: shared.id }, context(bob))).canEdit).toBe(false);
    await expect(invoke("view.get", { id: personal.id }, context(bob))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      invoke("view.update", { id: shared.id, name: "Bob's" }, context(bob)),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(invoke("view.delete", { id: shared.id }, context(bob))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      invoke("view.update", { id: personal.id, name: "x" }, context(admin)),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(
      (await invoke("view.update", { id: shared.id, name: "Team" }, context(admin))).name,
    ).toBe("Team");
    await expect(
      invoke("view.update", { id: shared.id, shared: false }, context(admin)),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await invoke("view.update", { id: shared.id, shared: false }, context(alice));
    expect(
      (await invoke("view.list", { object: "task" }, context(bob))).items.map((v) => v.id),
    ).not.toContain(shared.id);
    await invoke("view.delete", { id: personal.id }, context(alice));
  });
});

describe("board data", () => {
  it("counts and sums per column with record.groups", async () => {
    const org = await invoke("organisation.create", { name: unique("Groups") }, context(alice));
    for (const [status, budget] of [
      ["planned", 100],
      ["planned", 50],
      ["active", 1000],
      [null, 5],
    ] as const) {
      await invoke(
        "record.create",
        {
          object: project,
          values: { name: unique("P"), status, budget, organisation: org.id },
        },
        context(alice),
      );
    }
    const groups = await invoke(
      "record.groups",
      {
        object: project,
        groupBy: "status",
        sumField: "budget",
        filter: { field: "organisation", op: "eq", value: org.id },
      },
      context(alice),
    );
    expect(groups.capped).toBe(false);
    expect(
      Object.fromEntries(groups.groups.map((g) => [String(g.value), [g.count, g.sum]])),
    ).toEqual({ planned: [2, 150], active: [1, 1000], null: [1, 5] });

    await expect(
      invoke("record.groups", { object: "task", groupBy: "title" }, context(alice)),
    ).rejects.toBeInstanceOf(ValidationError);
    const tasks = await invoke("record.groups", { object: "task", groupBy: "status" }, context(alice));
    expect(tasks.groups.every((g) => g.sum === null)).toBe(true);
  });

  it("returns core fields from record.list when asked for", async () => {
    const task = await invoke(
      "task.create",
      { title: unique("Core"), dueAt: "2031-01-02T03:04:05.000Z" },
      context(alice),
    );
    const page = await invoke(
      "record.list",
      {
        object: "task",
        fields: ["title", "status", "dueAt"],
        filter: { field: "id", op: "eq", value: task.id },
      },
      context(alice),
    );
    expect(page.items[0]?.values).toEqual({
      title: task.title,
      status: "open",
      dueAt: "2031-01-02T03:04:05.000Z",
    });
  });

  it("refuses a choice whose required fields are empty, naming the field", async () => {
    const created = await invoke(
      "record.create",
      { object: project, values: { name: unique("Ship"), status: "active" } },
      context(alice),
    );
    const error = await invoke(
      "record.update",
      { object: project, id: created.id, values: { status: "done" } },
      context(alice),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).details).toMatchObject({
      field: "spent",
      reason: "required_by_choice",
      choice: "done",
    });
    // With the field supplied in the same update, the move applies.
    const moved = await invoke(
      "record.update",
      { object: project, id: created.id, values: { status: "done", spent: 42 } },
      context(alice),
    );
    expect(moved.values).toMatchObject({ status: "done", spent: 42 });
    // Creating straight into the choice needs it too.
    await expect(
      invoke(
        "record.create",
        { object: project, values: { name: unique("Done"), status: "done" } },
        context(alice),
      ),
    ).rejects.toMatchObject({ details: { field: "spent" } });
  });
});
