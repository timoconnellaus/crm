// Contract additions (stage 4a, ADR 0058): record tabs and panels, typed settings, and select
// choices that require fields, through validateManifest and the host operations.
import { env } from "cloudflare:workers";
import { type ExtensionManifest, validateManifest } from "@crm/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, ForbiddenError, invoke, recordViewFilter } from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, unique } from "./helpers.ts";

const id = extId("ui");

function uiManifest(): ExtensionManifest {
  return manifest(id, {
    label: "UI test",
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
              { value: "active", label: "Active" },
              { value: "done", label: "Done", requires: ["spent"] },
            ],
          },
          spent: { type: "currency", label: "Spent" },
          organisation: { type: "relation", label: "Organisation", to: "organisation" },
        },
      },
    },
    recordTabs: {
      projects: {
        label: "Projects",
        on: "organisation",
        view: { type: "table", object: `${id}.project`, relation: "organisation" },
        order: 10,
      },
      board: {
        label: "Project board",
        on: "organisation",
        view: {
          type: "board",
          object: `${id}.project`,
          relation: "organisation",
          groupBy: "status",
          sumField: "spent",
        },
        order: 20,
      },
      tasks: {
        label: "Open tasks",
        on: "person",
        view: {
          type: "table",
          object: "task",
          relation: "linkedRecordId",
          filter: { field: "status", op: "eq", value: "open" },
          columns: ["title", "dueAt"],
        },
        order: 100,
      },
    },
    recordPanels: {
      spend: {
        label: "Spend",
        on: "organisation",
        view: {
          type: "gallery",
          object: `${id}.project`,
          relation: "organisation",
          cardFields: ["spent"],
        },
        order: 100,
      },
    },
    settings: {
      defaultStatus: {
        type: "select",
        label: "Default status",
        options: [
          { value: "active", label: "Active" },
          { value: "done", label: "Done" },
        ],
        default: "active",
      },
      budgetCap: { type: "number", label: "Budget cap", min: 0, max: 1_000_000 },
      notify: { type: "boolean", label: "Notify owners", default: true },
    },
  });
}

let admin: ActingUser;
let member: ActingUser;

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  const m = uiManifest();
  await reconcile(m);
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES (?, 'runtime', 'active', '1.0.0', 'c1', ?, ?, ?, ?)",
  )
    .bind(id, JSON.stringify(m), admin.id, now, now)
    .run();
});

describe("manifest checks", () => {
  it("accepts record tabs, panels and settings", () => {
    expect(validateManifest(uiManifest()).issues).toEqual([]);
  });

  it("reports bad declarations with paths", () => {
    const bad = {
      ...uiManifest(),
      recordTabs: {
        wrong: {
          label: "Wrong",
          on: "spaceship",
          view: { type: "board", object: `${id}.project`, relation: "name" },
        },
      },
      settings: {
        level: {
          type: "select",
          label: "Level",
          options: [{ value: "a", label: "A" }],
          default: "b",
        },
        count: { type: "number", label: "Count", default: "three" },
      },
    };
    const paths = validateManifest(bad).issues.map((i) => i.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "recordTabs.wrong.on",
        "recordTabs.wrong.view.relation",
        "recordTabs.wrong.view.groupBy",
        "settings.level.default",
        "settings.count.default",
      ]),
    );
    const requires = validateManifest({
      ...uiManifest(),
      objects: {
        project: {
          label: "P",
          plural: "Ps",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name" },
            status: {
              type: "select",
              label: "Status",
              options: [{ value: "x", label: "X", requires: ["ghost"] }],
            },
          },
        },
      },
      recordTabs: {},
      recordPanels: {},
    });
    expect(requires.issues.map((i) => i.message).join()).toMatch(/requires "ghost"/);
  });
});

describe("view.recordViews", () => {
  it("lists the tabs and panels for a record page as validated view specs", async () => {
    const org = await invoke("organisation.create", { name: unique("Tabs") }, context(member));
    const views = await invoke("view.recordViews", { object: "organisation" }, context(member));
    const mine = views.tabs.filter((t) => t.extension === id);
    expect(mine.map((t) => [t.id, t.label, t.spec?.type, t.error])).toEqual([
      [`${id}.projects`, "Projects", "table", null],
      [`${id}.board`, "Project board", "board", null],
    ]);
    expect(mine[0]?.spec).toMatchObject({ columns: ["name", "status", "spent"] });
    expect(views.panels.filter((p) => p.extension === id).map((p) => p.spec?.type)).toEqual([
      "gallery",
    ]);

    // The tab lists exactly the records related to the record being shown.
    const other = await invoke("organisation.create", { name: unique("Other") }, context(member));
    for (const organisation of [org.id, org.id, other.id]) {
      await invoke(
        "record.create",
        { object: `${id}.project`, values: { name: unique("P"), organisation } },
        context(member),
      );
    }
    const tab = mine[0];
    if (!tab) throw new Error("no tab");
    const page = await invoke(
      "record.list",
      { object: `${id}.project`, filter: recordViewFilter(tab, org.id) },
      context(member),
    );
    expect(page.items).toHaveLength(2);

    const person = await invoke("view.recordViews", { object: "person" }, context(member));
    const tasks = person.tabs.find((t) => t.id === `${id}.tasks`);
    expect(tasks?.spec).toMatchObject({ object: "task", columns: ["title", "dueAt"] });
    expect(tasks && recordViewFilter(tasks, "per_x")).toEqual({
      and: [
        { field: "linkedRecordId", op: "eq", value: "per_x" },
        { field: "status", op: "eq", value: "open" },
      ],
    });
  });

  it("hides views of disabled extensions", async () => {
    await env.DB.prepare("UPDATE core_extensions SET status = 'disabled' WHERE id = ?")
      .bind(id)
      .run();
    const views = await invoke("view.recordViews", { object: "organisation" }, context(member));
    expect(views.tabs.some((t) => t.extension === id)).toBe(false);
    await env.DB.prepare("UPDATE core_extensions SET status = 'active' WHERE id = ?")
      .bind(id)
      .run();
  });
});

describe("extension settings", () => {
  it("returns defaults, validates types and keeps values", async () => {
    const listed = await invoke("extensionSettings.list", { extension: id }, context(member));
    expect(listed.items[0]?.values).toEqual({
      defaultStatus: "active",
      budgetCap: null,
      notify: true,
    });
    await expect(
      invoke(
        "extensionSettings.update",
        { extension: id, values: { budgetCap: 10 } },
        context(member),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    for (const values of [
      { budgetCap: -1 },
      { budgetCap: "ten" },
      { defaultStatus: "archived" },
      { notify: "yes" },
      { unknown: 1 },
    ]) {
      await expect(
        invoke("extensionSettings.update", { extension: id, values }, context(admin)),
        JSON.stringify(values),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
    const updated = await invoke(
      "extensionSettings.update",
      { extension: id, values: { budgetCap: 5000, defaultStatus: "done", notify: false } },
      context(admin),
    );
    expect(updated.values).toEqual({ defaultStatus: "done", budgetCap: 5000, notify: false });
    const reset = await invoke(
      "extensionSettings.update",
      { extension: id, values: { defaultStatus: null } },
      context(admin),
    );
    expect(reset.values.defaultStatus).toBe("active");
    expect(
      (await invoke("extensionSettings.list", { extension: id }, context(member))).items[0]?.values
        .budgetCap,
    ).toBe(5000);
  });
});
