// affiliation.* and person.changeJob, end to end on real D1.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, ForbiddenError, invoke, ValidationError } from "../src/index.ts";
import { auditChanges, context, createUser, timeline, unique } from "./helpers.ts";

let member: ActingUser;
let viewer: ActingUser;
const ctx = () => context(member);

beforeAll(async () => {
  member = await createUser("member");
  viewer = await createUser("viewer");
});

async function personAndOrgs(count = 2) {
  const person = await invoke("person.create", { displayName: unique("Worker") }, ctx());
  const orgs = [];
  for (let i = 0; i < count; i++) {
    orgs.push(await invoke("organisation.create", { name: unique(`Org${i}`) }, ctx()));
  }
  return { person, orgs };
}

describe("affiliation.create, update and end", () => {
  it("makes the first current affiliation primary, which sets the job title", async () => {
    const { person, orgs } = await personAndOrgs();
    const [a, b] = orgs;
    const first = await invoke(
      "affiliation.create",
      {
        personId: person.id,
        organisationId: a?.id ?? "",
        title: "Engineer",
        startedOn: "2024-01-01",
      },
      ctx(),
    );
    expect(first).toMatchObject({ current: true, primary: true, organisationName: a?.name });
    const second = await invoke(
      "affiliation.create",
      { personId: person.id, organisationId: b?.id ?? "", title: "Advisor" },
      ctx(),
    );
    expect(second.primary).toBe(false);

    const read = await invoke("person.get", { id: person.id }, ctx());
    expect(read.jobTitle).toBe("Engineer");
    expect(read.primaryAffiliation?.organisationId).toBe(a?.id);

    // Moving primary takes the flag from the other one.
    await invoke("affiliation.update", { id: second.id, primary: true }, ctx());
    const list = await invoke("affiliation.list", { personId: person.id }, ctx());
    expect(list.items.map((x) => [x.id, x.primary])).toEqual([
      [second.id, true],
      [first.id, false],
    ]);
    expect((await invoke("person.get", { id: person.id }, ctx())).jobTitle).toBe("Advisor");
    const firstChanges = await auditChanges(first.id);
    expect(firstChanges.at(-1)?.diff).toEqual({ primary: { before: true, after: false } });
  });

  it("enforces one primary per person and primary only for current affiliations", async () => {
    const { person, orgs } = await personAndOrgs();
    await invoke(
      "affiliation.create",
      { personId: person.id, organisationId: orgs[0]?.id ?? "", primary: true },
      ctx(),
    );
    const second = await invoke(
      "affiliation.create",
      { personId: person.id, organisationId: orgs[1]?.id ?? "", primary: true },
      ctx(),
    );
    const { results } = await env.DB.prepare(
      "SELECT id FROM core_affiliation WHERE person_id = ? AND is_primary = 1",
    )
      .bind(person.id)
      .all<{ id: string }>();
    expect(results.map((r) => r.id)).toEqual([second.id]);

    await expect(
      invoke(
        "affiliation.create",
        {
          personId: person.id,
          organisationId: orgs[0]?.id ?? "",
          endedOn: "2020-01-01",
          primary: true,
        },
        ctx(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      invoke(
        "affiliation.create",
        {
          personId: person.id,
          organisationId: orgs[0]?.id ?? "",
          startedOn: "2021-01-01",
          endedOn: "2020-01-01",
        },
        ctx(),
      ),
    ).rejects.toThrow(/before startedOn/);
  });

  it("ends an affiliation, dropping current and primary", async () => {
    const { person, orgs } = await personAndOrgs(1);
    const aff = await invoke(
      "affiliation.create",
      { personId: person.id, organisationId: orgs[0]?.id ?? "" },
      ctx(),
    );
    const ended = await invoke("affiliation.end", { id: aff.id, endedOn: "2026-10-31" }, ctx());
    expect(ended).toMatchObject({ current: false, primary: false, endedOn: "2026-10-31" });
    expect((await invoke("person.get", { id: person.id }, ctx())).jobTitle).toBeNull();
    await expect(invoke("affiliation.end", { id: aff.id }, ctx())).rejects.toThrow(/already/);
    const orgList = await invoke(
      "affiliation.list",
      { organisationId: orgs[0]?.id ?? "", currentOnly: true },
      ctx(),
    );
    expect(orgList.items).toEqual([]);
  });

  it("refuses viewers and links to deleted records", async () => {
    const { person, orgs } = await personAndOrgs(1);
    await expect(
      invoke(
        "affiliation.create",
        { personId: person.id, organisationId: orgs[0]?.id ?? "" },
        context(viewer),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await invoke("organisation.delete", { id: orgs[0]?.id ?? "" }, ctx());
    await expect(
      invoke(
        "affiliation.create",
        { personId: person.id, organisationId: orgs[0]?.id ?? "" },
        ctx(),
      ),
    ).rejects.toThrow(/No organisation/);
  });
});

describe("person.changeJob", () => {
  it("ends the primary affiliation, starts a new primary one, and posts to all three timelines", async () => {
    const { person, orgs } = await personAndOrgs();
    const [oldOrg, newOrg] = orgs;
    const old = await invoke(
      "affiliation.create",
      {
        personId: person.id,
        organisationId: oldOrg?.id ?? "",
        title: "Analyst",
        startedOn: "2022-03-01",
      },
      ctx(),
    );
    const result = await invoke(
      "person.changeJob",
      {
        personId: person.id,
        organisationId: newOrg?.id ?? "",
        title: "Head of Data",
        startedOn: "2026-11-01",
      },
      ctx(),
    );
    expect(result.ended).toMatchObject({
      id: old.id,
      current: false,
      primary: false,
      endedOn: "2026-11-01",
    });
    expect(result.started).toMatchObject({
      organisationId: newOrg?.id,
      title: "Head of Data",
      current: true,
      primary: true,
      startedOn: "2026-11-01",
    });
    expect(result.person.jobTitle).toBe("Head of Data");
    expect(result.person.primaryAffiliation?.organisationName).toBe(newOrg?.name);

    for (const [object, id] of [
      ["person", person.id],
      ["organisation", oldOrg?.id ?? ""],
      ["organisation", newOrg?.id ?? ""],
    ] as const) {
      const posts = await timeline(object, id);
      expect(posts.map((p) => p.payload.kind)).toEqual(["job_change"]);
      expect((posts[0] as { id?: string } | undefined)?.id).toBe(result.activityId);
      expect(posts[0]?.subject).toBe(
        `Job change: ${person.displayName} moved from ${oldOrg?.name} to ${newOrg?.name}`,
      );
    }
    const payload = (await timeline("person", person.id))[0]?.payload as {
      from: { organisationId: string; title: string };
      to: { organisationId: string; title: string };
    };
    expect(payload.from).toMatchObject({ organisationId: oldOrg?.id, title: "Analyst" });
    expect(payload.to).toMatchObject({ organisationId: newOrg?.id, title: "Head of Data" });

    // Both affiliations are audited.
    expect((await auditChanges(old.id)).at(-1)).toMatchObject({
      operation: "person.changeJob",
      action: "update",
    });
    expect((await auditChanges(result.started.id))[0]).toMatchObject({
      operation: "person.changeJob",
      action: "create",
    });
    const history = await invoke("affiliation.list", { personId: person.id }, ctx());
    expect(history.items.map((a) => a.id)).toEqual([result.started.id, old.id]);
  });

  it("starts a first job when there is no primary affiliation", async () => {
    const { person, orgs } = await personAndOrgs(1);
    const result = await invoke(
      "person.changeJob",
      { personId: person.id, organisationId: orgs[0]?.id ?? "", title: "Founder" },
      ctx(),
    );
    expect(result.ended).toBeNull();
    expect(result.started.primary).toBe(true);
    const posts = await timeline("person", person.id);
    expect(posts[0]?.subject).toBe(`Job change: ${person.displayName} joined ${orgs[0]?.name}`);
  });

  it("refuses an end date before the previous job started, writing nothing", async () => {
    const { person, orgs } = await personAndOrgs();
    await invoke(
      "affiliation.create",
      { personId: person.id, organisationId: orgs[0]?.id ?? "", startedOn: "2026-06-01" },
      ctx(),
    );
    await expect(
      invoke(
        "person.changeJob",
        {
          personId: person.id,
          organisationId: orgs[1]?.id ?? "",
          startedOn: "2026-07-01",
          previousEndedOn: "2026-01-01",
        },
        ctx(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await timeline("person", person.id)).toEqual([]);
  });
});
