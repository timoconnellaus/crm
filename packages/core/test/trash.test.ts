// trash.list and the scheduled purge (trash.purge via runTrashPurge).
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  ForbiddenError,
  invoke,
  newId,
  runTrashPurge,
  SYSTEM_USER,
} from "../src/index.ts";
import { auditChanges, context, createUser, db, unique } from "./helpers.ts";

let member: ActingUser;
const DAY = 86_400_000;
/** A context whose clock reads `daysAgo` days in the past. */
const at = (daysAgo: number) =>
  context(member, { clock: () => new Date(Date.now() - daysAgo * DAY) });

beforeAll(async () => {
  member = await createUser("member");
});

async function exists(table: "core_person" | "core_organisation", id: string) {
  const row = await env.DB.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind(id).first();
  return row !== null;
}

describe("trash.list", () => {
  it("lists deleted people and organisations, newest first, with restorable-until dates", async () => {
    const person = await invoke("person.create", { displayName: unique("TrashP") }, at(3));
    const org = await invoke("organisation.create", { name: unique("TrashO") }, at(3));
    const live = await invoke("person.create", { displayName: unique("Live") }, at(3));
    await invoke("person.delete", { id: person.id }, at(2));
    await invoke("organisation.delete", { id: org.id }, at(1));

    const page = await invoke("trash.list", { limit: 200 }, context(member));
    const ids = page.items.map((i) => i.id);
    expect(ids).not.toContain(live.id);
    expect(ids.indexOf(org.id)).toBeLessThan(ids.indexOf(person.id));
    const item = page.items.find((i) => i.id === person.id);
    expect(item).toMatchObject({
      object: "person",
      name: person.displayName,
      deletedBy: member.id,
    });
    expect(Date.parse(item?.restorableUntil ?? "") - Date.parse(item?.deletedAt ?? "")).toBe(
      30 * DAY,
    );

    const orgsOnly = await invoke(
      "trash.list",
      { object: "organisation", limit: 200 },
      context(member),
    );
    expect(orgsOnly.items.every((i) => i.object === "organisation")).toBe(true);
  });

  it("paginates without gaps or repeats", async () => {
    for (let i = 0; i < 5; i++) {
      const p = await invoke("person.create", { displayName: unique("Page") }, at(5));
      await invoke("person.delete", { id: p.id }, at(4));
    }
    const all = await invoke("trash.list", { limit: 200 }, context(member));
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await invoke("trash.list", { limit: 2, cursor }, context(member));
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(all.items.map((i) => i.id));
  });
});

describe("scheduled purge", () => {
  it("hard-deletes only records deleted more than 30 days ago, and audits it as an automation", async () => {
    const email = `${unique("old")}@example.com`;
    const old = await invoke(
      "person.create",
      { displayName: unique("Old"), emails: [{ email }], tags: ["Purged"] },
      at(45),
    );
    const oldOrg = await invoke(
      "organisation.create",
      { name: unique("OldOrg"), domains: [{ domain: `${unique("old").toLowerCase()}.com` }] },
      at(45),
    );
    await invoke("affiliation.create", { personId: old.id, organisationId: oldOrg.id }, at(45));
    await invoke("person.delete", { id: old.id }, at(31));
    await invoke("organisation.delete", { id: oldOrg.id }, at(40));
    const recent = await invoke("person.create", { displayName: unique("Recent") }, at(45));
    await invoke("person.delete", { id: recent.id }, at(29));
    const live = await invoke("person.create", { displayName: unique("Alive") }, at(45));

    const result = await runTrashPurge(db);
    expect(result.purged).toBeGreaterThanOrEqual(2);
    expect(result.more).toBe(false);

    expect(await exists("core_person", old.id)).toBe(false);
    expect(await exists("core_organisation", oldOrg.id)).toBe(false);
    expect(await exists("core_person", recent.id)).toBe(true);
    expect(await exists("core_person", live.id)).toBe(true);
    const leftovers = await env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM core_person_emails WHERE person_id = ?1) AS emails,
        (SELECT COUNT(*) FROM core_affiliation WHERE person_id = ?1) AS affiliations,
        (SELECT COUNT(*) FROM core_record_tags WHERE record_id = ?1) AS tags,
        (SELECT COUNT(*) FROM core_search_docs WHERE record_id = ?1) AS search`,
    )
      .bind(old.id)
      .first();
    expect(leftovers).toEqual({ emails: 0, affiliations: 0, tags: 0, search: 0 });

    const audit = await env.DB.prepare(
      "SELECT * FROM core_audit WHERE operation = 'trash.purge' ORDER BY at DESC, id DESC LIMIT 1",
    ).first<Record<string, string>>();
    expect(audit).toMatchObject({
      actor: "automation",
      user_id: SYSTEM_USER.id,
      risk: "write",
      gate_decision: "auto",
      outcome: "ok",
    });
    expect(JSON.parse(audit?.origin ?? "{}")).toEqual({
      surface: "system",
      automationId: "trash.purge",
    });
    expect((await auditChanges(old.id)).at(-1)).toMatchObject({
      action: "erase",
      operation: "trash.purge",
    });

    // Nothing more is due: a second run purges nothing.
    expect((await runTrashPurge(db)).purged).toBe(0);
  });

  it("works through a backlog in rounds of at most 100", async () => {
    const ids: string[] = [];
    const now = new Date(Date.now() - 60 * DAY).toISOString();
    const statements = Array.from({ length: 130 }, () => {
      const id = newId("person");
      ids.push(id);
      return env.DB.prepare(
        "INSERT INTO core_person (id, display_name, created_at, updated_at, deleted_at) VALUES (?, 'Backlog', ?, ?, ?)",
      ).bind(id, now, now, now);
    });
    await env.DB.batch(statements);
    const result = await runTrashPurge(db);
    expect(result.rounds).toBeGreaterThanOrEqual(2);
    expect(result.purged).toBeGreaterThanOrEqual(130);
    const left = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM core_person WHERE display_name = 'Backlog'",
    ).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("can only be run by an automation", async () => {
    const admin = await createUser("admin");
    await expect(invoke("trash.purge", {}, context(admin))).rejects.toBeInstanceOf(ForbiddenError);
  });
});
