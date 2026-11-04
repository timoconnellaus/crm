// record.* and the generic features extension objects get through the field registry: timeline
// links, history (audit diffs), search, saved views, CSV export, Trash and timeline tracking.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, invoke, invokeByName, resolveActingUser } from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, unique } from "./helpers.ts";

let admin: ActingUser;
let viewer: ActingUser;
const id = extId("rec");
const object = `${id}.ticket`;

beforeAll(async () => {
  admin = await createUser("admin");
  viewer = await createUser("viewer");
  await reconcile(
    manifest(id, {
      objects: {
        ticket: {
          label: "Ticket",
          plural: "Tickets",
          titleField: "subject",
          fields: {
            subject: { type: "text", label: "Subject", required: true },
            priority: {
              type: "select",
              label: "Priority",
              track: "timeline",
              options: [
                { value: "low", label: "Low" },
                { value: "high", label: "High" },
              ],
            },
            labels: {
              type: "multiSelect",
              label: "Labels",
              options: [
                { value: "bug", label: "Bug" },
                { value: "ux", label: "UX" },
              ],
            },
            reporter: { type: "relation", label: "Reporter", to: "person" },
            watchers: { type: "relation", label: "Watchers", to: "person", many: true },
            owner: { type: "user", label: "Owner" },
            email: { type: "email", label: "Email" },
            due: { type: "datetime", label: "Due" },
            urgent: { type: "boolean", label: "Urgent" },
          },
        },
      },
    }),
  );
});

describe("record operations", () => {
  it("validates values by field type", async () => {
    const bad = [
      { subject: "x", priority: "medium" },
      { subject: "x", email: "not an email" },
      { subject: "x", labels: ["bug", "nope"] },
      { subject: "x", due: "tomorrow" },
      { subject: "x", owner: "usr_missing" },
      { priority: "low" },
      { subject: "x", unknownField: 1 },
    ];
    for (const values of bad) {
      await expect(
        invoke("record.create", { object, values }, context(admin)),
        JSON.stringify(values),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
    await expect(
      invoke("record.create", { object, values: { subject: "x" } }, context(viewer)),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("stores every type and reads it back", async () => {
    const person = await invoke("person.create", { givenName: "Rita" }, context(admin));
    const created = await invoke(
      "record.create",
      {
        object,
        values: {
          subject: unique("Login broken"),
          priority: "low",
          labels: ["bug", "ux"],
          reporter: person.id,
          watchers: [person.id],
          owner: admin.id,
          email: "rita@example.com",
          due: "2026-12-01T09:00:00.000Z",
          urgent: true,
        },
      },
      context(admin),
    );
    expect(created.values).toMatchObject({
      labels: ["bug", "ux"],
      watchers: [person.id],
      urgent: true,
      owner: admin.id,
    });
    // Multi-valued fields filter by "has a value".
    const byLabel = await invoke(
      "record.list",
      { object, filter: { field: "labels", op: "eq", value: "ux" } },
      context(admin),
    );
    expect(byLabel.items.map((r) => r.id)).toContain(created.id);
    const byWatcher = await invoke(
      "record.list",
      { object, filter: { field: "watchers", op: "in", value: [person.id] } },
      context(admin),
    );
    expect(byWatcher.items.map((r) => r.id)).toEqual([created.id]);
  });

  it("records history, posts tracked changes on the timeline, and links activities", async () => {
    const created = await invoke(
      "record.create",
      { object, values: { subject: unique("History"), priority: "low" } },
      context(admin),
    );
    await invoke(
      "record.update",
      { object, id: created.id, values: { priority: "high" } },
      context(admin),
    );
    const history = await invoke(
      "audit.listForRecord",
      { object, recordId: created.id },
      context(admin),
    );
    expect(history.items.map((h) => h.action)).toEqual(["update", "create"]);
    expect(history.items[0]?.diff).toEqual({ priority: { before: "low", after: "high" } });

    const note = await invoke(
      "activity.log",
      {
        type: "note",
        subject: "Called them",
        body: "About the ticket",
        links: [{ object, id: created.id }],
      },
      context(admin),
    );
    const timeline = await invoke(
      "activity.listForRecord",
      { object, recordId: created.id },
      context(admin),
    );
    expect(timeline.items.map((a) => a.subject)).toEqual(["Called them", "Priority changed"]);
    expect(note.links).toEqual([{ object, id: created.id, title: created.title }]);
  });

  it("is searchable, exportable and can be saved as a view", async () => {
    const subject = unique("Searchable");
    const created = await invoke("record.create", { object, values: { subject } }, context(admin));
    const { hits } = await invoke("search.global", { query: subject }, context(admin));
    expect(hits).toEqual([expect.objectContaining({ object, id: created.id, title: subject })]);

    const csv = await invoke(
      "export.csv",
      {
        object,
        columns: ["subject", "labels"],
        filter: { field: "subject", op: "eq", value: subject },
      },
      context(admin),
    );
    expect(csv.csv.trim()).toBe(`subject,labels\r\n${subject},`.trim());

    const view = await invoke(
      "view.create",
      {
        name: "High priority",
        spec: {
          type: "table",
          object,
          filter: { field: "priority", op: "eq", value: "high" },
          columns: ["subject", "priority"],
        },
      },
      context(admin),
    );
    expect(view.object).toBe(object);
  });

  it("moves records to Trash and restores them", async () => {
    const created = await invoke(
      "record.create",
      { object, values: { subject: unique("Trash me") } },
      context(admin),
    );
    await invokeByName("record.delete", { object, id: created.id }, context(admin));
    await expect(
      invoke("record.get", { object, id: created.id }, context(admin)),
    ).rejects.toMatchObject({ code: "not_found" });
    const restored = await invoke("record.restore", { object, id: created.id }, context(admin));
    expect(restored.title).toBe(created.title);
  });

  it("never resolves an extension principal as a signed-in user", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at, kind) VALUES ('extension:zz', 'zz', 'zz@extensions.crm.invalid', 0, ?, ?, 'extension')",
    )
      .bind(now, now)
      .run();
    await expect(
      resolveActingUser(db, {
        userId: "extension:zz",
        email: "zz@extensions.crm.invalid",
        name: "zz",
      }),
    ).rejects.toThrow(/Could not resolve/);
    const users = await invoke("user.list", { limit: 200 }, context(admin));
    expect(users.items.map((u) => u.id)).not.toContain("extension:zz");
  });
});
