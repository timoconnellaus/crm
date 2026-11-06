// person.* reference operations, end to end through the pipeline on real D1.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  ConflictError,
  invoke,
  NotFoundError,
  ValidationError,
} from "../src/index.ts";
import { auditChanges, context, createUser, unique } from "./helpers.ts";

let user: ActingUser;
const ctx = () => context(user);

beforeAll(async () => {
  user = await createUser("member");
});

describe("person.create and person.get", () => {
  it("creates a person with emails, phones, tags and derived display name", async () => {
    const email = `${unique("ada")}@Example.COM`;
    const tag = unique("Tag");
    const created = await invoke(
      "person.create",
      {
        givenName: "Ada",
        familyName: "Lovelace",
        emails: [{ email: `  ${email} `, label: "work" }, { email: `${unique("b")}@example.com` }],
        phones: [{ number: "+61 2 9999 0000", label: "office" }],
        socialProfiles: [{ network: "github", url: "https://github.com/ada" }],
        tags: [tag, tag.toLowerCase()],
        ownerId: user.id,
        description: "**Mathematician**",
      },
      ctx(),
    );
    expect(created.id).toMatch(/^per_/);
    expect(created.displayName).toBe("Ada Lovelace");
    expect(created.emails[0]).toEqual({ email: email.toLowerCase(), label: "work", primary: true });
    expect(created.emails[1]?.primary).toBe(false);
    expect(created.phones).toEqual([{ number: "+61 2 9999 0000", label: "office", primary: true }]);
    expect(created.tags).toEqual([tag]);

    const read = await invoke("person.get", { id: created.id }, ctx());
    // The create also reports possible duplicates (stage 16); the record itself is the same.
    const { possibleDuplicates, ...record } = created;
    expect(possibleDuplicates).toEqual([]);
    expect(read).toEqual(record);

    const phone = await env.DB.prepare(
      "SELECT number_normalised FROM core_person_phones WHERE person_id = ?",
    )
      .bind(created.id)
      .first<{ number_normalised: string }>();
    expect(phone?.number_normalised).toBe("+61299990000");
  });

  it("falls back to the primary email for the display name, and needs one or the other", async () => {
    const email = `${unique("x")}@example.com`;
    const p = await invoke("person.create", { emails: [{ email }] }, ctx());
    expect(p.displayName).toBe(email);
    await expect(invoke("person.create", {}, ctx())).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects two primary emails and duplicate emails", async () => {
    const a = `${unique("a")}@example.com`;
    await expect(
      invoke(
        "person.create",
        {
          displayName: "X",
          emails: [
            { email: a, primary: true },
            { email: `b${a}`, primary: true },
          ],
        },
        ctx(),
      ),
    ).rejects.toThrow(/Only one email/);
    await expect(
      invoke(
        "person.create",
        { displayName: "X", emails: [{ email: a }, { email: a.toUpperCase() }] },
        ctx(),
      ),
    ).rejects.toThrow(/listed twice/);
  });

  it("rejects an email that belongs to another live person", async () => {
    const email = `${unique("dup")}@example.com`;
    const first = await invoke("person.create", { displayName: "One", emails: [{ email }] }, ctx());
    const error = await invoke(
      "person.create",
      { displayName: "Two", emails: [{ email }] },
      ctx(),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).details).toMatchObject({
      taken: [{ email, personId: first.id }],
    });
  });

  it("rejects an unknown owner", async () => {
    await expect(
      invoke("person.create", { displayName: "X", ownerId: "usr_nope" }, ctx()),
    ).rejects.toThrow(/No user/);
  });

  it("reports missing people as not found", async () => {
    await expect(invoke("person.get", { id: "per_missing" }, ctx())).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("person.update", () => {
  it("changes only the given fields, clears with null and replaces lists", async () => {
    const p = await invoke(
      "person.create",
      {
        givenName: "Grace",
        familyName: "Hopper",
        location: "Arlington",
        emails: [{ email: `${unique("g")}@navy.example` }],
        tags: ["Navy"],
      },
      ctx(),
    );
    const newEmail = `${unique("g2")}@yale.example`;
    const updated = await invoke(
      "person.update",
      { id: p.id, location: null, emails: [{ email: newEmail }], tags: ["Yale", "navy"] },
      ctx(),
    );
    expect(updated).toMatchObject({
      givenName: "Grace",
      familyName: "Hopper",
      location: null,
      emails: [{ email: newEmail, label: null, primary: true }],
      tags: ["Navy", "Yale"],
    });
    expect(updated.updatedAt >= p.updatedAt).toBe(true);
  });

  it("does not let a person take another live person's email", async () => {
    const email = `${unique("taken")}@example.com`;
    await invoke("person.create", { displayName: "Owner", emails: [{ email }] }, ctx());
    const other = await invoke("person.create", { displayName: "Other" }, ctx());
    await expect(
      invoke("person.update", { id: other.id, emails: [{ email }] }, ctx()),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("records nothing as changed when nothing changes", async () => {
    const p = await invoke("person.create", { displayName: unique("Same") }, ctx());
    await invoke("person.update", { id: p.id, displayName: p.displayName }, ctx());
    const changes = await auditChanges(p.id);
    expect(changes.at(-1)).toMatchObject({ action: "update", diff: {} });
  });
});

describe("person.delete and person.restore", () => {
  it("soft-deletes into Trash and restores", async () => {
    const email = `${unique("trash")}@example.com`;
    const p = await invoke("person.create", { displayName: "Trashed", emails: [{ email }] }, ctx());
    const deleted = await invoke("person.delete", { id: p.id }, ctx());
    expect(deleted.id).toBe(p.id);
    expect(Date.parse(deleted.restorableUntil) - Date.parse(deleted.deletedAt)).toBe(
      30 * 86_400_000,
    );

    await expect(invoke("person.get", { id: p.id }, ctx())).rejects.toBeInstanceOf(NotFoundError);
    const inTrash = await invoke("person.get", { id: p.id, includeDeleted: true }, ctx());
    expect(inTrash.deletedAt).toBe(deleted.deletedAt);
    const listed = await invoke(
      "person.list",
      { filter: { field: "id", op: "eq", value: p.id } },
      ctx(),
    );
    expect(listed.items).toEqual([]);
    await expect(invoke("person.delete", { id: p.id }, ctx())).rejects.toBeInstanceOf(
      NotFoundError,
    );

    const restored = await invoke("person.restore", { id: p.id }, ctx());
    expect(restored.deletedAt).toBeNull();
    expect(restored.emails[0]?.email).toBe(email);
    await expect(invoke("person.restore", { id: p.id }, ctx())).rejects.toThrow(/not in Trash/);

    expect((await auditChanges(p.id)).map((c) => c.action)).toEqual([
      "create",
      "delete",
      "restore",
    ]);
  });

  it("frees a deleted person's email, and refuses to restore over it", async () => {
    const email = `${unique("reuse")}@example.com`;
    const old = await invoke("person.create", { displayName: "Old", emails: [{ email }] }, ctx());
    await invoke("person.delete", { id: old.id }, ctx());
    const fresh = await invoke("person.create", { displayName: "New", emails: [{ email }] }, ctx());
    expect(fresh.emails[0]?.email).toBe(email);
    await expect(invoke("person.restore", { id: old.id }, ctx())).rejects.toBeInstanceOf(
      ConflictError,
    );
  });
});

describe("person.list", () => {
  const tag = unique("ListTag");
  const names = ["delta", "Alpha", "charlie", "Bravo", "echo"];
  const byTag = { field: "tags", op: "eq", value: tag } as const;

  beforeAll(async () => {
    for (const name of names) {
      await invoke("person.create", { displayName: name, tags: [tag] }, ctx());
    }
    // Two with no location, so null-ordering in pagination is exercised.
    const all = await invoke("person.list", { filter: byTag, limit: 10 }, ctx());
    for (const [i, item] of all.items.entries()) {
      if (i < 3) await invoke("person.update", { id: item.id, location: `City ${i % 2}` }, ctx());
    }
  });

  it("sorts by display name case-insensitively by default", async () => {
    const page = await invoke("person.list", { filter: byTag }, ctx());
    expect(page.items.map((i) => i.displayName)).toEqual([
      "Alpha",
      "Bravo",
      "charlie",
      "delta",
      "echo",
    ]);
    expect(page.nextCursor).toBeNull();
  });

  for (const direction of ["asc", "desc"] as const) {
    for (const field of ["displayName", "location", "createdAt", "id"]) {
      it(`paginates by ${field} ${direction} without gaps or repeats`, async () => {
        const full = await invoke(
          "person.list",
          { filter: byTag, sort: { field, direction }, limit: 50 },
          ctx(),
        );
        const seen: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await invoke(
            "person.list",
            { filter: byTag, sort: { field, direction }, limit: 2, ...(cursor ? { cursor } : {}) },
            ctx(),
          );
          seen.push(...page.items.map((i) => i.id));
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        expect(seen).toEqual(full.items.map((i) => i.id));
        expect(seen).toHaveLength(names.length);
      });
    }
  }

  it("rejects a cursor used with a different sort", async () => {
    const page = await invoke("person.list", { filter: byTag, limit: 2 }, ctx());
    await expect(
      invoke(
        "person.list",
        {
          filter: byTag,
          limit: 2,
          cursor: page.nextCursor ?? "",
          sort: { field: "createdAt", direction: "asc" },
        },
        ctx(),
      ),
    ).rejects.toThrow(/different sort/);
    await expect(
      invoke("person.list", { filter: byTag, cursor: "garbage" }, ctx()),
    ).rejects.toThrow(/Invalid cursor/);
  });

  it("rejects unsortable fields and invalid filters", async () => {
    await expect(
      invoke("person.list", { sort: { field: "emails", direction: "asc" } }, ctx()),
    ).rejects.toThrow(/not sortable/);
    await expect(
      invoke("person.list", { filter: { field: "secret", op: "eq", value: 1 } }, ctx()),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("returns only the selected fields", async () => {
    const page = await invoke(
      "person.list",
      { filter: byTag, fields: ["displayName", "tags"], limit: 1 },
      ctx(),
    );
    expect(Object.keys(page.items[0] ?? {}).sort()).toEqual(["displayName", "id", "tags"]);
    await expect(invoke("person.list", { filter: byTag, fields: ["nope"] }, ctx())).rejects.toThrow(
      /Unknown fields/,
    );
  });
});
