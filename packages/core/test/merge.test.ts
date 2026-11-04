// person.merge and organisation.merge: everything moves to the survivor, and the merged-away
// record sits in Trash with a pointer and can be restored.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  ForbiddenError,
  invoke,
  newId,
  ReviewNotYetSupportedError,
  ValidationError,
} from "../src/index.ts";
import { auditChanges, context, createUser, setPreset, timeline, unique } from "./helpers.ts";

let member: ActingUser;
let viewer: ActingUser;
const ctx = () => context(member);
const NOW = new Date().toISOString();

beforeAll(async () => {
  member = await createUser("member");
  viewer = await createUser("viewer");
});

/** Activities and tasks are another stage-1 slice; insert them directly for these tests. */
async function insertActivity(subject: string, links: [string, string][]) {
  const id = newId("activity");
  await env.DB.prepare(
    "INSERT INTO core_activity (id, type, subject, occurred_at, created_at, updated_at) VALUES (?, 'note', ?, ?, ?, ?)",
  )
    .bind(id, subject, NOW, NOW, NOW)
    .run();
  for (const [object, recordId] of links) {
    await env.DB.prepare(
      "INSERT INTO core_activity_links (activity_id, object_type, record_id) VALUES (?, ?, ?)",
    )
      .bind(id, object, recordId)
      .run();
  }
  return id;
}

async function insertTask(title: string, links: [string, string][]) {
  const id = newId("task");
  await env.DB.prepare(
    "INSERT INTO core_task (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
  )
    .bind(id, title, NOW, NOW)
    .run();
  for (const [object, recordId] of links) {
    await env.DB.prepare(
      "INSERT INTO core_task_links (task_id, object_type, record_id) VALUES (?, ?, ?)",
    )
      .bind(id, object, recordId)
      .run();
  }
  return id;
}

async function linkedTo(table: "activity" | "task", object: string, recordId: string) {
  const column = table === "activity" ? "activity_id" : "task_id";
  const { results } = await env.DB.prepare(
    `SELECT ${column} AS id FROM core_${table}_links WHERE object_type = ? AND record_id = ? ORDER BY 1`,
  )
    .bind(object, recordId)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

const email = (prefix: string) => `${unique(prefix)}@example.com`;

describe("person.merge", () => {
  it("moves emails, phones, affiliations, activities, tasks and tags onto the survivor", async () => {
    const [orgA, orgB] = [
      await invoke("organisation.create", { name: unique("MergeOrgA") }, ctx()),
      await invoke("organisation.create", { name: unique("MergeOrgB") }, ctx()),
    ];
    const keepEmail = email("keep");
    const dupEmail = email("dup");
    const shared = email("shared");
    const survivor = await invoke(
      "person.create",
      {
        givenName: "Ada",
        familyName: "Lovelace",
        emails: [{ email: keepEmail }],
        phones: [{ number: "+61 2 1111 1111" }],
        tags: ["SurvivorTag"],
      },
      ctx(),
    );
    const merged = await invoke(
      "person.create",
      {
        givenName: "Augusta",
        familyName: "King",
        emails: [{ email: dupEmail }, { email: shared }],
        phones: [{ number: "+61211111111" }, { number: "+61 3 2222 2222" }],
        location: "London",
        socialProfiles: [{ network: "github", url: "https://github.com/ada" }],
        tags: ["MergedTag"],
      },
      ctx(),
    );
    const survivorJob = await invoke(
      "affiliation.create",
      { personId: survivor.id, organisationId: orgA.id, title: "Mathematician" },
      ctx(),
    );
    const mergedJob = await invoke(
      "affiliation.create",
      { personId: merged.id, organisationId: orgB.id, title: "Countess" },
      ctx(),
    );
    const onMerged = await insertActivity("Met Augusta", [["person", merged.id]]);
    const onBoth = await insertActivity("Met both", [
      ["person", merged.id],
      ["person", survivor.id],
    ]);
    const task = await insertTask("Call Augusta", [["person", merged.id]]);

    const result = await invoke(
      "person.merge",
      { survivorId: survivor.id, mergedId: merged.id, fields: { givenName: "merged" } },
      ctx(),
    );

    // Chosen and filled-in values.
    expect(result.givenName).toBe("Augusta");
    expect(result.familyName).toBe("Lovelace");
    expect(result.location).toBe("London");
    expect(result.displayName).toBe(survivor.displayName);
    // Combined lists; the survivor's primary stays primary; duplicate phone dropped.
    expect(result.emails).toEqual([
      { email: keepEmail, label: null, primary: true },
      { email: dupEmail, label: null, primary: false },
      { email: shared, label: null, primary: false },
    ]);
    expect(result.phones.map((p) => p.number)).toEqual(["+61 2 1111 1111", "+61 3 2222 2222"]);
    expect(result.socialProfiles).toHaveLength(1);
    expect(result.tags).toEqual(["MergedTag", "SurvivorTag"]);
    expect(result.moved).toEqual({ affiliations: 1, activities: 2, tasks: 1 });

    // Affiliations: both on the survivor, the survivor's primary kept.
    const jobs = await invoke("affiliation.list", { personId: survivor.id }, ctx());
    expect(jobs.items.map((a) => [a.id, a.primary]).sort()).toEqual(
      [
        [survivorJob.id, true],
        [mergedJob.id, false],
      ].sort(),
    );
    expect(result.jobTitle).toBe("Mathematician");

    // Activity and task links moved (the shared activity stays linked once).
    expect(await linkedTo("activity", "person", survivor.id)).toEqual(
      expect.arrayContaining([onMerged, onBoth]),
    );
    expect(await linkedTo("activity", "person", merged.id)).toEqual(
      (await timeline("person", merged.id)).map((a) => (a as unknown as { id: string }).id),
    );
    expect(await linkedTo("task", "person", survivor.id)).toEqual([task]);
    expect(await linkedTo("task", "person", merged.id)).toEqual([]);

    // The merged person is in Trash with a pointer, and its email is now the survivor's.
    const gone = await invoke("person.get", { id: merged.id, includeDeleted: true }, ctx());
    expect(gone.deletedAt).not.toBeNull();
    expect(gone.mergedIntoId).toBe(survivor.id);
    expect(gone.emails).toEqual([]);
    const trash = await invoke("trash.list", { object: "person", limit: 200 }, ctx());
    expect(trash.items.find((t) => t.id === merged.id)).toMatchObject({
      mergedIntoId: survivor.id,
    });
    const found = await invoke(
      "person.list",
      { filter: { field: "emails", op: "eq", value: dupEmail } },
      ctx(),
    );
    expect(found.items.map((p) => p.id)).toEqual([survivor.id]);

    // Audit: a merge diff on both, and a merge activity on both timelines.
    const survivorAudit = (await auditChanges(survivor.id)).at(-1);
    expect(survivorAudit).toMatchObject({ action: "merge", operation: "person.merge" });
    expect(survivorAudit?.diff.givenName).toEqual({ before: "Ada", after: "Augusta" });
    expect(survivorAudit?.diff.absorbedId).toEqual({ before: null, after: merged.id });
    const mergedAudit = (await auditChanges(merged.id)).at(-1);
    expect(mergedAudit?.diff.mergedIntoId).toEqual({ before: null, after: survivor.id });
    expect(mergedAudit?.diff.emails).toMatchObject({ after: null });
    const posts = await timeline("person", survivor.id);
    expect(posts.at(-1)?.payload).toMatchObject({ kind: "merge", mergedId: merged.id });

    // The loser can be restored from Trash; its pointer is cleared.
    const restored = await invoke("person.restore", { id: merged.id }, ctx());
    expect(restored).toMatchObject({ deletedAt: null, mergedIntoId: null, givenName: "Augusta" });
    expect(restored.emails).toEqual([]);
  });

  it("gives the survivor the merged person's primary job when it has none", async () => {
    const org = await invoke("organisation.create", { name: unique("JobOrg") }, ctx());
    const survivor = await invoke("person.create", { displayName: unique("S") }, ctx());
    const merged = await invoke("person.create", { displayName: unique("M") }, ctx());
    await invoke(
      "affiliation.create",
      { personId: merged.id, organisationId: org.id, title: "CTO" },
      ctx(),
    );
    const result = await invoke(
      "person.merge",
      { survivorId: survivor.id, mergedId: merged.id },
      ctx(),
    );
    expect(result.jobTitle).toBe("CTO");
  });

  it("refuses self-merges, deleted records and viewers", async () => {
    const a = await invoke("person.create", { displayName: unique("A") }, ctx());
    const b = await invoke("person.create", { displayName: unique("B") }, ctx());
    await expect(
      invoke("person.merge", { survivorId: a.id, mergedId: a.id }, ctx()),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      invoke("person.merge", { survivorId: a.id, mergedId: b.id }, context(viewer)),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await invoke("person.delete", { id: b.id }, ctx());
    await expect(
      invoke("person.merge", { survivorId: a.id, mergedId: b.id }, ctx()),
    ).rejects.toThrow(/No person/);
  });

  it("is destructive, so the gate sends AI merges to review under Balanced", async () => {
    await setPreset("balanced");
    const a = await invoke("person.create", { displayName: unique("A") }, ctx());
    const b = await invoke("person.create", { displayName: unique("B") }, ctx());
    await expect(
      invoke(
        "person.merge",
        { survivorId: a.id, mergedId: b.id },
        context(member, { actor: "mcp" }),
      ),
    ).rejects.toBeInstanceOf(ReviewNotYetSupportedError);
    expect((await invoke("person.get", { id: b.id }, ctx())).deletedAt).toBeNull();
  });
});

describe("organisation.merge", () => {
  it("moves domains, addresses, affiliations, children, activities, tasks and tags", async () => {
    const d1 = `${unique("keep").toLowerCase()}.com`;
    const d2 = `${unique("dup").toLowerCase()}.com`;
    const survivor = await invoke(
      "organisation.create",
      {
        name: "Acme",
        domains: [{ domain: d1 }],
        addresses: [{ label: "HQ", city: "Sydney" }],
        tags: ["Customer"],
      },
      ctx(),
    );
    const merged = await invoke(
      "organisation.create",
      {
        name: "ACME Inc",
        domains: [{ domain: d2 }],
        addresses: [{ label: "US office", city: "Austin" }],
        industry: "Rockets",
        tags: ["Partner"],
      },
      ctx(),
    );
    const child = await invoke(
      "organisation.create",
      { name: unique("Subsidiary"), parentId: merged.id },
      ctx(),
    );
    const person = await invoke("person.create", { displayName: unique("Employee") }, ctx());
    const job = await invoke(
      "affiliation.create",
      { personId: person.id, organisationId: merged.id, title: "Engineer" },
      ctx(),
    );
    const activity = await insertActivity("Kick-off", [["organisation", merged.id]]);
    const task = await insertTask("Renewal", [
      ["organisation", merged.id],
      ["organisation", survivor.id],
    ]);

    const result = await invoke(
      "organisation.merge",
      { survivorId: survivor.id, mergedId: merged.id, fields: { name: "merged" } },
      ctx(),
    );
    expect(result.name).toBe("ACME Inc");
    expect(result.industry).toBe("Rockets");
    expect(result.domains).toEqual([
      { domain: d1, primary: true },
      { domain: d2, primary: false },
    ]);
    expect(result.addresses.map((a) => [a.label, a.primary])).toEqual([
      ["HQ", true],
      ["US office", false],
    ]);
    expect(result.tags).toEqual(["Customer", "Partner"]);
    expect(result.moved).toEqual({ affiliations: 1, activities: 1, tasks: 1, children: 1 });

    expect((await invoke("organisation.get", { id: child.id }, ctx())).parentId).toBe(survivor.id);
    const people = await invoke("affiliation.list", { organisationId: survivor.id }, ctx());
    expect(people.items.map((a) => a.id)).toEqual([job.id]);
    expect((await invoke("person.get", { id: person.id }, ctx())).primaryAffiliation).toMatchObject(
      { organisationId: survivor.id },
    );
    expect(await linkedTo("activity", "organisation", survivor.id)).toContain(activity);
    expect(await linkedTo("task", "organisation", survivor.id)).toEqual([task]);
    expect(await linkedTo("task", "organisation", merged.id)).toEqual([]);

    const gone = await invoke("organisation.get", { id: merged.id, includeDeleted: true }, ctx());
    expect(gone).toMatchObject({ mergedIntoId: survivor.id, domains: [] });
    expect(gone.deletedAt).not.toBeNull();
    const byDomain = await invoke(
      "organisation.list",
      { filter: { field: "domains", op: "eq", value: d2 } },
      ctx(),
    );
    expect(byDomain.items.map((o) => o.id)).toEqual([survivor.id]);

    const restored = await invoke("organisation.restore", { id: merged.id }, ctx());
    expect(restored).toMatchObject({ deletedAt: null, mergedIntoId: null, name: "ACME Inc" });
  });

  it("drops a parent that would make the survivor its own ancestor", async () => {
    const merged = await invoke("organisation.create", { name: unique("Parent") }, ctx());
    const survivor = await invoke(
      "organisation.create",
      { name: unique("Child"), parentId: merged.id },
      ctx(),
    );
    const result = await invoke(
      "organisation.merge",
      { survivorId: survivor.id, mergedId: merged.id },
      ctx(),
    );
    expect(result.parentId).toBeNull();
  });
});
