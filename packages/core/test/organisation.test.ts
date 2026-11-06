// organisation.* operations, end to end through the pipeline on real D1.
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  ConflictError,
  ForbiddenError,
  invoke,
  NotFoundError,
  normaliseDomain,
  ValidationError,
} from "../src/index.ts";
import { auditChanges, context, createUser, timeline, unique } from "./helpers.ts";

let member: ActingUser;
let viewer: ActingUser;
const ctx = () => context(member);

beforeAll(async () => {
  member = await createUser("member");
  viewer = await createUser("viewer");
});

const domain = (prefix = "acme") => `${unique(prefix).toLowerCase()}.com`;

describe("organisation.create and organisation.get", () => {
  it("creates an organisation with domains, addresses, parent, owner and tags", async () => {
    const parent = await invoke("organisation.create", { name: unique("Group") }, ctx());
    const d1 = domain();
    const d2 = domain("alt");
    const tag = unique("OrgTag");
    const created = await invoke(
      "organisation.create",
      {
        name: "Acme Pty Ltd",
        domains: [{ domain: `https://www.${d1}/about` }, { domain: d2.toUpperCase() }],
        website: "https://acme.example",
        industry: "Software",
        addresses: [
          { label: "HQ", line1: "1 George St", city: "Sydney", country: "au" },
          { label: "Billing", city: "Melbourne", primary: true },
        ],
        parentId: parent.id,
        ownerId: member.id,
        tags: [tag],
        description: "**Rockets**",
      },
      ctx(),
    );
    expect(created.id).toMatch(/^org_/);
    expect(created.domains).toEqual([
      { domain: d1, primary: true },
      { domain: d2, primary: false },
    ]);
    expect(created.addresses[0]).toMatchObject({ label: "HQ", country: "AU", primary: false });
    expect(created.addresses[1]).toMatchObject({ label: "Billing", primary: true });
    expect(created.parentName).toBe(parent.name);
    expect(created.tags).toEqual([tag]);

    const read = await invoke("organisation.get", { id: created.id }, ctx());
    // The create also reports possible duplicates (stage 16); the record itself is the same.
    const { possibleDuplicates, ...record } = created;
    expect(possibleDuplicates).toEqual([]);
    expect(read).toEqual(record);

    const changes = await auditChanges(created.id);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ action: "create", operation: "organisation.create" });
    expect(changes[0]?.diff.name).toEqual({ before: null, after: "Acme Pty Ltd" });
  });

  it("normalises domains and rejects non-domains", () => {
    expect(normaliseDomain("HTTPS://WWW.Example.COM:443/path?q=1")).toBe("example.com");
    expect(normaliseDomain("sub.example.co.uk.")).toBe("sub.example.co.uk");
    expect(() => normaliseDomain("not a domain")).toThrow(ValidationError);
    expect(() => normaliseDomain("localhost")).toThrow(ValidationError);
  });

  it("rejects a domain that belongs to another live organisation, and duplicates", async () => {
    const d = domain();
    await invoke("organisation.create", { name: "First", domains: [{ domain: d }] }, ctx());
    await expect(
      invoke("organisation.create", { name: "Second", domains: [{ domain: `www.${d}` }] }, ctx()),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      invoke(
        "organisation.create",
        { name: "Twice", domains: [{ domain: `a${d}` }, { domain: `https://a${d}` }] },
        ctx(),
      ),
    ).rejects.toThrow(/listed twice/);
  });

  it("refuses viewers and unknown parents", async () => {
    await expect(
      invoke("organisation.create", { name: "Nope" }, context(viewer)),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      invoke("organisation.create", { name: "Orphan", parentId: "org_missing" }, ctx()),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(invoke("organisation.get", { id: "org_missing" }, ctx())).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("organisation.update", () => {
  it("changes only the given fields and posts timeline activities for tracked ones", async () => {
    const parent = await invoke("organisation.create", { name: unique("Parent") }, ctx());
    const org = await invoke(
      "organisation.create",
      { name: "Before", industry: "Retail", domains: [{ domain: domain() }] },
      ctx(),
    );
    const newDomain = domain("new");
    const updated = await invoke(
      "organisation.update",
      {
        id: org.id,
        name: "After",
        domains: [{ domain: newDomain }],
        parentId: parent.id,
        ownerId: member.id,
        industry: null,
      },
      ctx(),
    );
    expect(updated).toMatchObject({
      name: "After",
      industry: null,
      parentId: parent.id,
      ownerId: member.id,
    });
    expect(updated.domains).toEqual([{ domain: newDomain, primary: true }]);

    const posts = await timeline("organisation", org.id);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.type).toBe("system");
    const payload = posts[0]?.payload as { kind: string; changes: { field: string }[] };
    expect(payload.kind).toBe("field_change");
    expect(payload.changes.map((c) => c.field).sort()).toEqual([
      "domains",
      "name",
      "ownerId",
      "parentId",
    ]);

    const update = (await auditChanges(org.id)).find((c) => c.action === "update");
    expect(Object.keys(update?.diff ?? {}).sort()).toEqual([
      "domains",
      "industry",
      "name",
      "ownerId",
      "parentId",
    ]);
  });

  it("does not post to the timeline for untracked fields", async () => {
    const org = await invoke("organisation.create", { name: unique("Quiet") }, ctx());
    await invoke("organisation.update", { id: org.id, website: "https://quiet.example" }, ctx());
    expect(await timeline("organisation", org.id)).toEqual([]);
  });

  it("refuses parent cycles", async () => {
    const a = await invoke("organisation.create", { name: unique("A") }, ctx());
    const b = await invoke("organisation.create", { name: unique("B"), parentId: a.id }, ctx());
    const c = await invoke("organisation.create", { name: unique("C"), parentId: b.id }, ctx());
    await expect(
      invoke("organisation.update", { id: a.id, parentId: c.id }, ctx()),
    ).rejects.toThrow(/cycle/);
    await expect(
      invoke("organisation.update", { id: a.id, parentId: a.id }, ctx()),
    ).rejects.toThrow(/own parent/);
  });

  it("does not let an organisation take another live organisation's domain", async () => {
    const d = domain();
    await invoke("organisation.create", { name: "Owner", domains: [{ domain: d }] }, ctx());
    const other = await invoke("organisation.create", { name: unique("Other") }, ctx());
    await expect(
      invoke("organisation.update", { id: other.id, domains: [{ domain: d }] }, ctx()),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("organisation.delete and organisation.restore", () => {
  it("soft-deletes into Trash, frees domains and restores", async () => {
    const d = domain();
    const org = await invoke(
      "organisation.create",
      { name: unique("Trashed"), domains: [{ domain: d }] },
      ctx(),
    );
    const deleted = await invoke("organisation.delete", { id: org.id }, ctx());
    expect(Date.parse(deleted.restorableUntil) - Date.parse(deleted.deletedAt)).toBe(
      30 * 86_400_000,
    );
    await expect(invoke("organisation.get", { id: org.id }, ctx())).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const listed = await invoke(
      "organisation.list",
      { filter: { field: "id", op: "eq", value: org.id } },
      ctx(),
    );
    expect(listed.items).toEqual([]);

    // The domain is free while it is in Trash, so restoring over a new owner conflicts.
    const taker = await invoke(
      "organisation.create",
      { name: "Taker", domains: [{ domain: d }] },
      ctx(),
    );
    await expect(invoke("organisation.restore", { id: org.id }, ctx())).rejects.toBeInstanceOf(
      ConflictError,
    );
    await invoke("organisation.delete", { id: taker.id }, ctx());
    const restored = await invoke("organisation.restore", { id: org.id }, ctx());
    expect(restored.deletedAt).toBeNull();
    expect(restored.domains[0]?.domain).toBe(d);
    expect((await auditChanges(org.id)).map((c) => c.action)).toEqual([
      "create",
      "delete",
      "restore",
    ]);
  });

  it("refuses deletes by viewers", async () => {
    const org = await invoke("organisation.create", { name: unique("Kept") }, ctx());
    await expect(
      invoke("organisation.delete", { id: org.id }, context(viewer)),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("organisation.list", () => {
  it("filters by domain and tag, and sorts by name", async () => {
    const tag = unique("ListOrgTag");
    const d = domain();
    for (const name of ["charlie", "Alpha", "bravo"]) {
      await invoke(
        "organisation.create",
        { name, tags: [tag], ...(name === "bravo" ? { domains: [{ domain: d }] } : {}) },
        ctx(),
      );
    }
    const byTag = await invoke(
      "organisation.list",
      { filter: { field: "tags", op: "eq", value: tag } },
      ctx(),
    );
    expect(byTag.items.map((o) => o.name)).toEqual(["Alpha", "bravo", "charlie"]);
    const byDomain = await invoke(
      "organisation.list",
      { filter: { field: "domains", op: "eq", value: d }, fields: ["name", "primaryDomain"] },
      ctx(),
    );
    expect(byDomain.items).toEqual([
      { id: expect.stringMatching(/^org_/), name: "bravo", primaryDomain: d },
    ]);
  });

  it("lets viewers read", async () => {
    const page = await invoke("organisation.list", { limit: 1 }, context(viewer));
    expect(page.items.length).toBeLessThanOrEqual(1);
  });
});
