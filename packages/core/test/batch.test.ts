// Batch variants (person/organisation updateMany and deleteMany): diffs per record, timeline
// posts, all-or-nothing within a call, and the gate seeing the real bulk size.
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  BATCH_MAX,
  ForbiddenError,
  invoke,
  NotFoundError,
  PendingApprovalError,
  ValidationError,
} from "../src/index.ts";
import {
  auditChanges,
  auditRows,
  context,
  createUser,
  setPreset,
  timeline,
  unique,
} from "./helpers.ts";

let member: ActingUser;
let owner: ActingUser;
let viewer: ActingUser;
const ctx = () => context(member);

beforeAll(async () => {
  member = await createUser("member");
  owner = await createUser("member");
  viewer = await createUser("viewer");
});

afterEach(async () => {
  await setPreset("balanced");
});

async function people(count: number, tags: string[] = []) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    ids.push((await invoke("person.create", { displayName: unique("Bulk"), tags }, ctx())).id);
  }
  return ids;
}

async function orgs(count: number) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    ids.push((await invoke("organisation.create", { name: unique("BulkOrg") }, ctx())).id);
  }
  return ids;
}

describe("person.updateMany", () => {
  it("sets fields and tags on every person, with a diff and timeline post each", async () => {
    const keep = unique("Keep");
    const drop = unique("Drop");
    const ids = await people(3, [keep, drop]);
    const added = unique("Added");
    const result = await invoke(
      "person.updateMany",
      {
        ids,
        set: { ownerId: owner.id, location: "Perth" },
        addTags: [added],
        removeTags: [drop.toUpperCase()],
      },
      ctx(),
    );
    expect(result).toEqual({ ids, count: 3 });
    for (const id of ids) {
      const person = await invoke("person.get", { id }, ctx());
      expect(person).toMatchObject({ ownerId: owner.id, location: "Perth" });
      expect([...person.tags].sort()).toEqual([added, keep].sort());
      const change = (await auditChanges(id)).at(-1);
      expect(change).toMatchObject({ action: "update", operation: "person.updateMany" });
      expect(Object.keys(change?.diff ?? {}).sort()).toEqual(["location", "ownerId", "tags"]);
      const posts = await timeline("person", id);
      expect(posts.map((p) => p.payload.kind)).toEqual(["field_change"]);
    }
    const audit = (await auditRows("person.updateMany", member.id)).at(-1);
    expect(audit).toMatchObject({ risk: "bulk-write", gate_decision: "auto", outcome: "ok" });
  });

  it("applies nothing when one id is not a live person", async () => {
    const ids = await people(2);
    await expect(
      invoke(
        "person.updateMany",
        { ids: [...ids, "per_01JC0000000000000000000000"], set: { location: "Nowhere" } },
        ctx(),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    for (const id of ids) {
      expect((await invoke("person.get", { id }, ctx())).location).toBeNull();
    }
  });

  it("caps a call at BATCH_MAX ids and rejects duplicates", async () => {
    const tooMany = Array.from({ length: BATCH_MAX + 1 }, (_, i) => `per_${i}`);
    await expect(
      invoke("person.updateMany", { ids: tooMany, set: { location: "X" } }, ctx()),
    ).rejects.toBeInstanceOf(ValidationError);
    const [id = ""] = await people(1);
    await expect(
      invoke("person.updateMany", { ids: [id, id], set: { location: "X" } }, ctx()),
    ).rejects.toThrow(/twice/);
  });

  it("refuses viewers", async () => {
    const ids = await people(1);
    await expect(
      invoke("person.updateMany", { ids, set: { location: "X" } }, context(viewer)),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("person.deleteMany", () => {
  it("moves every person to Trash in one call", async () => {
    const ids = await people(3);
    const result = await invoke("person.deleteMany", { ids }, ctx());
    expect(result.count).toBe(3);
    const trash = await invoke("trash.list", { object: "person", limit: 200 }, ctx());
    for (const id of ids) {
      expect(trash.items.find((t) => t.id === id)?.deletedAt).toBe(result.deletedAt);
      expect((await auditChanges(id)).at(-1)?.action).toBe("delete");
    }
    const audit = (await auditRows("person.deleteMany", member.id)).at(-1);
    expect(audit).toMatchObject({ risk: "destructive", outcome: "ok" });
    expect(JSON.parse(String(audit?.result))).toMatchObject({ count: 3 });
  });
});

describe("gate for batch operations", () => {
  it("lets Balanced AI bulk writes through up to 25 records, and reviews larger ones", async () => {
    await setPreset("balanced");
    const ids = await people(26);
    const ai = context(member, { actor: "assistant" });
    await invoke("person.updateMany", { ids: ids.slice(0, 25), set: { timezone: "UTC" } }, ai);
    await expect(
      invoke("person.updateMany", { ids, set: { timezone: "Australia/Perth" } }, ai),
    ).rejects.toBeInstanceOf(PendingApprovalError);
    const rows = await auditRows("person.updateMany", member.id);
    expect(rows.slice(-2).map((r) => [r.gate_decision, r.outcome])).toEqual([
      ["auto", "ok"],
      ["review", "review"],
    ]);
    const { results } = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM core_person WHERE timezone = 'Australia/Perth' AND id IN (${ids
        .map(() => "?")
        .join(",")})`,
    )
      .bind(...ids)
      .all<{ n: number }>();
    expect(results[0]?.n).toBe(0);
  });

  it("reviews AI batch deletes under Balanced, and allows small ones under Autonomous", async () => {
    const ai = context(member, { actor: "mcp", origin: { surface: "mcp", clientId: "test" } });
    await setPreset("balanced");
    const small = await people(2);
    await expect(invoke("person.deleteMany", { ids: small }, ai)).rejects.toBeInstanceOf(
      PendingApprovalError,
    );
    await setPreset("autonomous");
    await invoke("person.deleteMany", { ids: small }, ai);
    const big = await people(11);
    await expect(invoke("person.deleteMany", { ids: big }, ai)).rejects.toBeInstanceOf(
      PendingApprovalError,
    );
    const last = (await auditRows("person.deleteMany", member.id)).at(-1);
    expect(last).toMatchObject({ gate_decision: "review", actor: "mcp", risk: "destructive" });
  });

  it("runs human batch calls automatically under every preset", async () => {
    await setPreset("cautious");
    const ids = await orgs(3);
    await invoke("organisation.deleteMany", { ids }, ctx());
    const last = (await auditRows("organisation.deleteMany", member.id)).at(-1);
    expect(last).toMatchObject({ gate_decision: "auto", outcome: "ok" });
  });
});

describe("organisation.updateMany and organisation.deleteMany", () => {
  it("sets owner, industry, parent and tags, posting timeline changes for owner and parent", async () => {
    const parent = await invoke("organisation.create", { name: unique("Holding") }, ctx());
    const ids = await orgs(2);
    const tag = unique("Segment");
    await invoke(
      "organisation.updateMany",
      { ids, set: { ownerId: owner.id, industry: "Mining", parentId: parent.id }, addTags: [tag] },
      ctx(),
    );
    for (const id of ids) {
      const org = await invoke("organisation.get", { id }, ctx());
      expect(org).toMatchObject({
        ownerId: owner.id,
        industry: "Mining",
        parentId: parent.id,
        tags: [tag],
      });
      const post = (await timeline("organisation", id)).at(-1)?.payload as {
        changes: { field: string }[];
      };
      expect(post.changes.map((c) => c.field).sort()).toEqual(["ownerId", "parentId"]);
    }
    await expect(
      invoke("organisation.updateMany", { ids: [parent.id], set: { parentId: parent.id } }, ctx()),
    ).rejects.toThrow(/own parent/);
  });

  it("deletes many organisations and frees their domains", async () => {
    const domain = `${unique("bulkdel").toLowerCase()}.com`;
    const org = await invoke("organisation.create", { name: "D", domains: [{ domain }] }, ctx());
    const [other = ""] = await orgs(1);
    await invoke("organisation.deleteMany", { ids: [org.id, other] }, ctx());
    const again = await invoke("organisation.create", { name: "E", domains: [{ domain }] }, ctx());
    expect(again.domains[0]?.domain).toBe(domain);
  });
});
