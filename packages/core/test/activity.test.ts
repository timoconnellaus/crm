// activity.* operations end to end on real D1.
import { describe, expect, it } from "vitest";
import { type ActingUser, ForbiddenError, invoke, ValidationError } from "../src/index.ts";
import { createPerson, insertOrganisation } from "./fixtures.ts";
import { auditChanges, auditRows, context, createUser, timeline } from "./helpers.ts";

let member: ActingUser;
let viewer: ActingUser;

async function setup() {
  member ??= await createUser("member");
  viewer ??= await createUser("viewer");
}

describe("activity.log", () => {
  it("logs a note on a person and an organisation, visible on both timelines", async () => {
    await setup();
    const person = await createPerson(member);
    const org = await insertOrganisation();
    const note = await invoke(
      "activity.log",
      {
        type: "note",
        body: "Met at the conference",
        links: [
          { object: "person", id: person.id },
          { object: "organisation", id: org.id },
          { object: "person", id: person.id },
        ],
      },
      context(member),
    );
    expect(note.id).toMatch(/^act_/);
    expect(note.type).toBe("note");
    expect(note.authorUserId).toBe(member.id);
    expect(note.authorName).toBe("member user");
    expect(note.authorActor).toBe("human");
    expect(note.links).toHaveLength(2);
    expect(note.links.find((l) => l.object === "person")?.title).toBe(person.displayName);
    expect(note.links.find((l) => l.object === "organisation")?.title).toBe(org.name);

    for (const ref of [
      { object: "person", recordId: person.id },
      { object: "organisation", recordId: org.id },
    ]) {
      const page = await invoke("activity.listForRecord", ref, context(viewer));
      expect(page.items.map((a) => a.id)).toContain(note.id);
    }

    const changes = await auditChanges(note.id);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("create");
    expect(changes[0]?.diff.body).toEqual({ before: null, after: "Met at the conference" });
  });

  it("validates the typed payload per type", async () => {
    await setup();
    const person = await createPerson(member);
    const links = [{ object: "person", id: person.id }];
    const email = await invoke(
      "activity.log",
      {
        type: "email",
        subject: "Proposal",
        body: "Attached.",
        payload: { direction: "outbound", to: [{ email: "A@Example.com", name: "A" }] },
        links,
      },
      context(member),
    );
    expect(email.payload).toEqual({
      direction: "outbound",
      to: [{ email: "a@example.com", name: "A" }],
      cc: [],
    });

    const call = await invoke(
      "activity.log",
      {
        type: "call",
        subject: "Intro call",
        payload: { durationSeconds: 300, outcome: "connected" },
        links,
        occurredAt: "2026-01-02T03:04:05+10:00",
      },
      context(member),
    );
    expect(call.occurredAt).toBe("2026-01-01T17:04:05.000Z");

    const meeting = await invoke(
      "activity.log",
      {
        type: "meeting",
        subject: "Quarterly review",
        payload: { startsAt: "2026-02-01T10:00:00Z", attendees: [{ personId: person.id }] },
        links,
      },
      context(member),
    );
    expect(meeting.payload.attendees).toEqual([{ personId: person.id }]);

    // Wrong payload for the type, unknown payload keys, missing direction.
    await expect(
      invoke(
        "activity.log",
        // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid input.
        { type: "call", subject: "x", payload: { durationSeconds: -1 }, links } as any,
        context(member),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      invoke(
        "activity.log",
        // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid input.
        { type: "note", body: "x", payload: { extra: 1 }, links } as any,
        context(member),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      invoke(
        "activity.log",
        // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid input.
        { type: "email", subject: "x", payload: {}, links } as any,
        context(member),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses system activities, empty notes, unknown objects and missing records", async () => {
    await setup();
    const person = await createPerson(member);
    const links = [{ object: "person", id: person.id }];
    await expect(
      invoke(
        "activity.log",
        // biome-ignore lint/suspicious/noExplicitAny: humans cannot log system activities.
        { type: "system", subject: "fake", payload: { kind: "x" }, links } as any,
        context(member),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      invoke("activity.log", { type: "note", body: "  ", links }, context(member)),
    ).rejects.toThrow(/needs a body/);
    await expect(
      invoke(
        "activity.log",
        { type: "note", body: "x", links: [{ object: "spaceship", id: "x_1" }] },
        context(member),
      ),
    ).rejects.toThrow(/Cannot link/);
    await expect(
      invoke(
        "activity.log",
        { type: "note", body: "x", links: [{ object: "person", id: "per_missing" }] },
        context(member),
      ),
    ).rejects.toThrow(/No live person/);
    await expect(
      invoke("activity.log", { type: "note", body: "x", links: [] }, context(member)),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses viewers and audits the refusal", async () => {
    await setup();
    const person = await createPerson(member);
    await expect(
      invoke(
        "activity.log",
        { type: "note", body: "x", links: [{ object: "person", id: person.id }] },
        context(viewer),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const rows = await auditRows("activity.log", viewer.id);
    expect(rows.at(-1)?.outcome).toBe("forbidden");
  });
});

describe("activity.update, delete and restore", () => {
  it("edits fields and links, recording diffs", async () => {
    await setup();
    const a = await createPerson(member);
    const b = await createPerson(member);
    const note = await invoke(
      "activity.log",
      { type: "note", body: "first", links: [{ object: "person", id: a.id }] },
      context(member),
    );
    const updated = await invoke(
      "activity.update",
      { id: note.id, body: "second", links: [{ object: "person", id: b.id }] },
      context(member),
    );
    expect(updated.body).toBe("second");
    expect(updated.links.map((l) => l.id)).toEqual([b.id]);

    const onA = await invoke(
      "activity.listForRecord",
      { object: "person", recordId: a.id },
      context(member),
    );
    expect(onA.items.map((x) => x.id)).not.toContain(note.id);

    const diff = (await auditChanges(note.id)).at(-1)?.diff;
    expect(diff).toEqual({
      body: { before: "first", after: "second" },
      links: { before: [`person:${a.id}`], after: [`person:${b.id}`] },
    });
  });

  it("validates a new payload against the activity's type", async () => {
    await setup();
    const p = await createPerson(member);
    const call = await invoke(
      "activity.log",
      { type: "call", subject: "c", links: [{ object: "person", id: p.id }] },
      context(member),
    );
    await expect(
      invoke(
        "activity.update",
        { id: call.id, payload: { durationSeconds: "long" } },
        context(member),
      ),
    ).rejects.toThrow(/Invalid call payload/);
    const ok = await invoke(
      "activity.update",
      { id: call.id, payload: { durationSeconds: 60 } },
      context(member),
    );
    expect(ok.payload).toEqual({ durationSeconds: 60 });
  });

  it("refuses to edit system activities", async () => {
    await setup();
    const p = await createPerson(member);
    // Changing the owner (a timeline-worthy field) posts a system activity.
    await invoke("person.update", { id: p.id, ownerId: member.id }, context(member));
    const system = (await timeline("person", p.id)).find((x) => x.type === "system");
    expect(system).toBeDefined();
    const page = await invoke(
      "activity.listForRecord",
      { object: "person", recordId: p.id, types: ["system"] },
      context(member),
    );
    const id = page.items[0]?.id as string;
    await expect(invoke("activity.update", { id, body: "x" }, context(member))).rejects.toThrow(
      /cannot be edited/,
    );
  });

  it("soft-deletes and restores", async () => {
    await setup();
    const p = await createPerson(member);
    const note = await invoke(
      "activity.log",
      { type: "note", body: "temp", links: [{ object: "person", id: p.id }] },
      context(member),
    );
    const deleted = await invoke("activity.delete", { id: note.id }, context(member));
    expect(deleted.deletedAt).toBeTruthy();
    const page = await invoke(
      "activity.listForRecord",
      { object: "person", recordId: p.id },
      context(member),
    );
    expect(page.items.map((x) => x.id)).not.toContain(note.id);
    await expect(invoke("activity.get", { id: note.id }, context(member))).rejects.toThrow(
      /No activity/,
    );
    expect(
      (await invoke("activity.get", { id: note.id, includeDeleted: true }, context(member)))
        .deletedAt,
    ).toBe(deleted.deletedAt);
    await expect(
      invoke("activity.delete", { id: note.id }, context(viewer)),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const restored = await invoke("activity.restore", { id: note.id }, context(member));
    expect(restored.deletedAt).toBeNull();
    expect((await auditChanges(note.id)).map((c) => c.action)).toEqual([
      "create",
      "delete",
      "restore",
    ]);
  });
});

describe("activity.listForRecord", () => {
  it("pages newest first and filters by type", async () => {
    await setup();
    const p = await createPerson(member);
    const links = [{ object: "person", id: p.id }];
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const a = await invoke(
        "activity.log",
        i % 2
          ? { type: "call", subject: `call ${i}`, links, occurredAt: `2026-03-0${i + 1}T00:00:00Z` }
          : { type: "note", body: `note ${i}`, links, occurredAt: `2026-03-0${i + 1}T00:00:00Z` },
        context(member),
      );
      ids.push(a.id);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await invoke(
        "activity.listForRecord",
        { object: "person", recordId: p.id, limit: 3, ...(cursor ? { cursor } : {}) },
        context(member),
      );
      seen.push(...page.items.map((a) => a.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual([...ids].reverse());

    const calls = await invoke(
      "activity.listForRecord",
      { object: "person", recordId: p.id, types: ["call"] },
      context(member),
    );
    expect(calls.items.map((a) => a.type)).toEqual(["call", "call", "call"]);
  });
});
