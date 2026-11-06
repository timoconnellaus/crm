// Stage 15 (ADR 0246): assignment rules through the operations, with the real Deals and Leads
// manifests on real D1. Rules with several conditions, round-robin exactness and deactivated
// users, the fallback owner, every create path, assignment.apply, authority, audit, and the
// rows_read budget. The record's owner is in the record's own insert: the audit row of the create
// already carries it, and nothing writes the owner afterwards.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@relationship-os/db";
import deals from "@relationship-os/extension-deals";
import leads from "@relationship-os/extension-leads";
import { toManifest } from "@relationship-os/sdk";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type ActingUser, invokeByName, type Role } from "../src/index.ts";
import { manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, unique } from "./helpers.ts";

interface Rule {
  id: string;
  name: string;
  position: number;
}
interface Record_ {
  id: string;
  title: string;
  values: Record<string, unknown>;
}

let admin: ActingUser;
let member: ActingUser;
let sam: ActingUser;
let kim: ActingUser;
let lee: ActingUser;

const call = <T>(name: string, input: unknown, user: ActingUser = admin) =>
  invokeByName(name, input, context(user)) as Promise<T>;

const rule = (input: Record<string, unknown>) =>
  call<Rule>("assignment.create", { name: unique("Rule"), ...input });

const newPerson = (input: Record<string, unknown> = {}) =>
  call<{ id: string; ownerId: string | null }>("person.create", {
    displayName: unique("Person"),
    ...input,
  });

const newOrganisation = (input: Record<string, unknown> = {}) =>
  call<{ id: string; ownerId: string | null }>("organisation.create", {
    name: unique("Org"),
    ...input,
  });

const newLead = (values: Record<string, unknown>) =>
  call<Record_>("record.create", { object: "leads.lead", values });

async function auditDiff(recordId: string) {
  const row = await env.DB.prepare(
    "SELECT diff, action FROM core_audit_changes WHERE record_id = ? ORDER BY rowid LIMIT 1",
  )
    .bind(recordId)
    .first<{ diff: string; action: string }>();
  return row ? { action: row.action, diff: JSON.parse(row.diff) } : null;
}

async function timelineSubjects(object: string, id: string) {
  const page = await call<{ items: { subject: string | null }[] }>("activity.listForRecord", {
    object,
    recordId: id,
    types: ["system"],
  });
  return page.items.map((item) => item.subject);
}

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  sam = await createUser("member" as Role);
  kim = await createUser("member" as Role);
  lee = await createUser("member" as Role);
  await reconcile(toManifest(deals));
  await reconcile(toManifest(leads));
  await reconcile(
    manifest("firmo", {
      fields: {
        organisation: {
          employees: { type: "number", label: "Employees" },
          foundedOn: { type: "date", label: "Founded on" },
        },
      },
    }),
  );
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM core_assignment_rule"),
    env.DB.prepare("DELETE FROM core_assignment_state"),
    env.DB.prepare("DELETE FROM core_assignment_fallback"),
    env.DB.prepare("UPDATE core_user SET deactivated_at = NULL"),
  ]);
});

describe("rules", () => {
  it("picks the first enabled rule whose conditions all hold, in order", async () => {
    const off = await rule({
      object: "person",
      enabled: false,
      conditions: [],
      method: "user",
      userIds: [lee.id],
    });
    await rule({
      object: "person",
      conditions: [
        { field: "location", op: "in", value: ["Sydney", "Perth"] },
        { field: "primaryEmail", op: "is_not_null" },
      ],
      method: "user",
      userIds: [sam.id],
    });
    await rule({
      object: "person",
      conditions: [{ field: "location", op: "is_null" }],
      method: "user",
      userIds: [kim.id],
    });
    const email = `${unique("a")}@example.com`;
    expect(
      (await newPerson({ location: "sydney", emails: [{ email }] })).ownerId,
      "a list, case-insensitive, and not empty",
    ).toBe(sam.id);
    expect((await newPerson({ location: "Sydney" })).ownerId, "one condition fails").toBeNull();
    expect((await newPerson({})).ownerId, "the empty check").toBe(kim.id);
    expect(off.position).toBe(1);
  });

  it("assigns organisations and keeps a given owner", async () => {
    await rule({
      object: "organisation",
      conditions: [{ field: "industry", op: "eq", value: "Mining" }],
      method: "user",
      userIds: [sam.id],
    });
    expect((await newOrganisation({ industry: "Mining" })).ownerId).toBe(sam.id);
    expect((await newOrganisation({ industry: "Retail" })).ownerId).toBeNull();
    expect((await newOrganisation({ industry: "Mining", ownerId: kim.id })).ownerId).toBe(kim.id);
    const person = await newPerson({ ownerId: kim.id });
    expect(person.ownerId).toBe(kim.id);
  });

  it("tests ranges on numbers and dates, and fields of a lead's organisation", async () => {
    await rule({
      object: "leads.lead",
      conditions: [
        { via: "organisation", field: "firmo.employees", op: "between", value: [50, 500] },
        {
          via: "organisation",
          field: "firmo.foundedOn",
          op: "between",
          value: ["2000-01-01", "2010-12-31"],
        },
      ],
      method: "user",
      userIds: [sam.id],
    });
    await rule({
      object: "leads.lead",
      conditions: [
        { via: "organisation", field: "industry", op: "in", value: ["Mining", "Energy"] },
      ],
      method: "user",
      userIds: [kim.id],
    });
    const org = async (employees: number, foundedOn: string, industry = "Retail") => {
      const { id } = await newOrganisation({ industry });
      await call("record.update", {
        object: "organisation",
        id,
        values: { "firmo.employees": employees, "firmo.foundedOn": foundedOn },
      });
      return id;
    };
    const owner = async (organisation: string) =>
      (await newLead({ organisation })).values.owner ?? null;
    expect(await owner(await org(100, "2005-06-01"))).toBe(sam.id);
    expect(await owner(await org(50, "2000-01-01")), "bounds are inclusive").toBe(sam.id);
    expect(await owner(await org(501, "2005-06-01"))).toBeNull();
    expect(await owner(await org(100, "2011-01-01"))).toBeNull();
    expect(await owner(await org(10, "1999-01-01", "Energy"))).toBe(kim.id);
    // A lead of a person only: conditions on its organisation do not hold.
    const person = await newPerson();
    expect((await newLead({ person: person.id })).values.owner ?? null).toBeNull();
  });

  it("uses the fallback owner when nothing matches, and allows no owner", async () => {
    await rule({
      object: "leads.lead",
      conditions: [{ field: "source", op: "eq", value: "partner" }],
      method: "user",
      userIds: [sam.id],
    });
    const { id: organisation } = await newOrganisation();
    await call("assignment.setFallback", { object: "leads.lead", userId: kim.id });
    expect((await newLead({ organisation })).values.owner).toBe(kim.id);
    expect((await newLead({ organisation, source: "partner" })).values.owner).toBe(sam.id);
    expect((await newLead({ organisation, owner: lee.id })).values.owner).toBe(lee.id);
    await call("assignment.setFallback", { object: "leads.lead", userId: null });
    expect((await newLead({ organisation })).values.owner ?? null).toBeNull();
    // A deactivated fallback owner assigns nobody.
    await call("assignment.setFallback", { object: "leads.lead", userId: kim.id });
    await env.DB.prepare("UPDATE core_user SET deactivated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), kim.id)
      .run();
    expect((await newLead({ organisation })).values.owner ?? null).toBeNull();
  });

  it("rotates exactly across 100 sequential creates and skips deactivated users", async () => {
    await rule({
      object: "person",
      conditions: [],
      method: "roundRobin",
      userIds: [sam.id, kim.id, lee.id],
    });
    const owners: (string | null)[] = [];
    for (let i = 0; i < 100; i += 1) owners.push((await newPerson()).ownerId);
    const cycle = [sam.id, kim.id, lee.id];
    expect(owners).toEqual(owners.map((_, i) => cycle[i % 3]));

    await env.DB.prepare("UPDATE core_user SET deactivated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), kim.id)
      .run();
    const after: (string | null)[] = [];
    for (let i = 0; i < 10; i += 1) after.push((await newPerson()).ownerId);
    expect(new Set(after)).toEqual(new Set([sam.id, lee.id]));
    expect(after.filter((id) => id === sam.id)).toHaveLength(5);
  });

  it("stays exact under concurrent creates: a moved state re-runs the call", async () => {
    await rule({
      object: "person",
      conditions: [],
      method: "roundRobin",
      userIds: [sam.id, kim.id],
    });
    const created = await Promise.all(Array.from({ length: 6 }, () => newPerson()));
    const owners = created.map((p) => p.ownerId);
    expect(owners.filter((id) => id === sam.id)).toHaveLength(3);
    expect(owners.filter((id) => id === kim.id)).toHaveLength(3);
  });

  it("skips a rule with no active users", async () => {
    await rule({ object: "person", conditions: [], method: "user", userIds: [sam.id] });
    await rule({ object: "person", conditions: [], method: "user", userIds: [kim.id] });
    await env.DB.prepare("UPDATE core_user SET deactivated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), sam.id)
      .run();
    expect((await newPerson()).ownerId).toBe(kim.id);
  });

  it("refuses conditions the field registry does not allow", async () => {
    const base = { object: "person", method: "user", userIds: [sam.id] };
    await expect(
      rule({ ...base, conditions: [{ field: "nope", op: "eq", value: "x" }] }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      rule({ ...base, conditions: [{ field: "location", op: "between", value: ["a", "b"] }] }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      rule({ ...base, conditions: [{ field: "name", via: "location", op: "eq", value: "x" }] }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      rule({ object: "person", conditions: [], method: "user", userIds: [sam.id, kim.id] }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      rule({ object: "core", conditions: [], method: "user", userIds: [sam.id] }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("reorders, updates, deletes and lists rules", async () => {
    const first = await rule({
      object: "person",
      conditions: [],
      method: "user",
      userIds: [sam.id],
    });
    const second = await rule({
      object: "person",
      conditions: [],
      method: "user",
      userIds: [kim.id],
    });
    await call("assignment.reorder", { object: "person", ids: [second.id, first.id] });
    expect((await newPerson()).ownerId).toBe(kim.id);
    await call("assignment.update", { id: second.id, enabled: false });
    expect((await newPerson()).ownerId).toBe(sam.id);
    await call("assignment.delete", { id: first.id });
    const listed = await call<{ objects: { object: string; rules: Rule[] }[] }>(
      "assignment.list",
      {},
    );
    expect(listed.objects.map((o) => o.object)).toEqual(
      expect.arrayContaining(["person", "organisation", "leads.lead", "deals.deal"]),
    );
    expect(listed.objects.find((o) => o.object === "person")?.rules.map((r) => r.id)).toEqual([
      second.id,
    ]);
  });

  it("assignment.test shows the match without moving the rotation", async () => {
    const roundRobin = await rule({
      object: "person",
      conditions: [{ field: "location", op: "eq", value: "Sydney" }],
      method: "roundRobin",
      userIds: [sam.id, kim.id],
    });
    await call("assignment.setFallback", { object: "person", userId: lee.id });
    const input = { object: "person", values: { location: "Sydney" } };
    for (let i = 0; i < 3; i += 1) {
      expect(await call("assignment.test", input)).toMatchObject({
        ruleId: roundRobin.id,
        ownerId: sam.id,
        fallback: false,
      });
    }
    expect(await call("assignment.test", { object: "person", values: {} })).toMatchObject({
      ruleId: null,
      ownerId: lee.id,
      fallback: true,
    });
  });
});

describe("audit and timeline", () => {
  it("names the rule in the create's audit diff and on the timeline", async () => {
    const named = await rule({
      name: "West coast",
      object: "person",
      conditions: [],
      method: "user",
      userIds: [sam.id],
    });
    const person = await newPerson();
    const audit = await auditDiff(person.id);
    expect(audit?.action).toBe("create");
    expect(audit?.diff.ownerId).toMatchObject({ after: sam.id, assignedBy: "West coast" });
    const subjects = await timelineSubjects("person", person.id);
    expect(subjects).toContain(`Assigned to ${sam.name} by rule West coast`);
    expect(named.name).toBe("West coast");
  });

  it("says so for the fallback owner", async () => {
    await call("assignment.setFallback", { object: "organisation", userId: sam.id });
    const organisation = await newOrganisation();
    expect((await auditDiff(organisation.id))?.diff.ownerId).toMatchObject({
      after: sam.id,
      assignedBy: "Fallback owner",
    });
    expect(await timelineSubjects("organisation", organisation.id)).toContain(
      `Assigned to ${sam.name} (fallback owner)`,
    );
  });
});

describe("authority", () => {
  it("refuses rule and fallback changes for non-human actors, and for non-admins", async () => {
    const existing = await rule({
      object: "person",
      conditions: [],
      method: "user",
      userIds: [sam.id],
    });
    const attempts: [string, unknown][] = [
      [
        "assignment.create",
        { object: "person", name: "x", conditions: [], method: "user", userIds: [sam.id] },
      ],
      ["assignment.update", { id: existing.id, enabled: false }],
      ["assignment.delete", { id: existing.id }],
      ["assignment.reorder", { object: "person", ids: [existing.id] }],
      ["assignment.setFallback", { object: "person", userId: sam.id }],
    ];
    for (const [name, input] of attempts) {
      for (const actor of ["mcp", "assistant", "automation", "extension"] as const) {
        await expect(
          invokeByName(name, input, context(admin, { actor })),
          `${name} as ${actor}`,
        ).rejects.toMatchObject({ code: "forbidden" });
      }
      await expect(invokeByName(name, input, context(member))).rejects.toMatchObject({
        code: "forbidden",
      });
    }
    const { results } = await env.DB.prepare(
      "SELECT outcome FROM core_audit WHERE operation = 'assignment.setFallback' AND outcome = 'forbidden'",
    ).all();
    expect(results.length).toBeGreaterThanOrEqual(5);
  });

  it("audits a human admin's changes", async () => {
    await rule({ object: "person", conditions: [], method: "user", userIds: [sam.id] });
    const row = await env.DB.prepare(
      "SELECT outcome, user_id FROM core_audit WHERE operation = 'assignment.create' AND outcome = 'ok' ORDER BY at DESC LIMIT 1",
    ).first<{ outcome: string; user_id: string }>();
    expect(row).toMatchObject({ user_id: admin.id });
  });
});

describe("create paths", () => {
  it("import.csv.commit assigns people and organisations in row order", async () => {
    await rule({
      object: "person",
      conditions: [],
      method: "roundRobin",
      userIds: [sam.id, kim.id],
    });
    await call("assignment.setFallback", { object: "organisation", userId: lee.id });
    const tag = unique("imp");
    const csv = `Name,Email,Organisation\n${[0, 1, 2, 3]
      .map((i) => `Row ${tag} ${i},r${i}${tag}@example.com,Org ${tag}`)
      .join("\n")}\n`;
    await call("import.csv.commit", { object: "person", csv });
    const { results } = await env.DB.prepare(
      "SELECT display_name, owner_id FROM core_person WHERE display_name LIKE ? ORDER BY display_name",
    )
      .bind(`Row ${tag}%`)
      .all<{ display_name: string; owner_id: string }>();
    expect(results.map((r) => r.owner_id)).toEqual([sam.id, kim.id, sam.id, kim.id]);
    const org = await env.DB.prepare("SELECT owner_id FROM core_organisation WHERE name = ?")
      .bind(`Org ${tag}`)
      .first<{ owner_id: string }>();
    expect(org?.owner_id).toBe(lee.id);
    // One chunk, one state write: the next create continues the rotation.
    expect((await newPerson()).ownerId).toBe(sam.id);
  });

  it("import.csv.commit assigns organisations imported directly", async () => {
    await rule({ object: "organisation", conditions: [], method: "user", userIds: [sam.id] });
    const name = unique("Direct");
    await call("import.csv.commit", { object: "organisation", csv: `Name\n${name}\n` });
    const org = await env.DB.prepare("SELECT owner_id FROM core_organisation WHERE name = ?")
      .bind(name)
      .first<{ owner_id: string }>();
    expect(org?.owner_id).toBe(sam.id);
  });

  it("import.records.commit assigns leads and keeps a given owner", async () => {
    await rule({
      object: "leads.lead",
      conditions: [],
      method: "roundRobin",
      userIds: [sam.id, kim.id],
    });
    const { id: organisation } = await newOrganisation();
    const tag = unique("L");
    const csv = `Name,Organisation,Owner\n${tag} a,${organisation},\n${tag} b,${organisation},\n${tag} c,${organisation},${lee.email}\n${tag} d,${organisation},\n`;
    const result = await call<{ created: string[] }>("import.records.commit", {
      object: "leads.lead",
      csv,
    });
    const owners: unknown[] = [];
    for (const id of result.created) {
      owners.push((await call<Record_>("record.get", { object: "leads.lead", id })).values.owner);
    }
    expect(owners).toEqual([sam.id, kim.id, lee.id, sam.id]);
  });

  it("suggestedContact.add assigns the people and organisations it creates", async () => {
    await rule({ object: "person", conditions: [], method: "user", userIds: [sam.id] });
    await call("assignment.setFallback", { object: "organisation", userId: kim.id });
    const domain = `${unique("sc")}.example`;
    const email = `new@${domain}`;
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO core_suggested_contact (email, domain, name, message_count, first_seen_at, last_seen_at, status) VALUES (?, ?, 'New Contact', 3, ?, ?, 'open')",
    )
      .bind(email, domain, now, now)
      .run();
    const out = await call<{ added: { personId: string }[]; organisationIds: string[] }>(
      "suggestedContact.add",
      { emails: [email], createOrganisation: true },
    );
    const person = await call<{ ownerId: string }>("person.get", {
      id: out.added[0]?.personId,
    });
    expect(person.ownerId).toBe(sam.id);
    const org = await call<{ ownerId: string }>("organisation.get", {
      id: out.organisationIds[0],
    });
    expect(org.ownerId).toBe(kim.id);
  });

  it("assigns records created by MCP and assistant callers", async () => {
    await rule({ object: "person", conditions: [], method: "user", userIds: [sam.id] });
    await env.DB.prepare("UPDATE core_settings SET value = ? WHERE key = 'approval_policy'")
      .bind(JSON.stringify({ preset: "autonomous" }))
      .run();
    for (const actor of ["mcp", "assistant"] as const) {
      const person = (await invokeByName(
        "person.create",
        { displayName: unique("AI") },
        context(admin, { actor, reason: "test" }),
      )) as { ownerId: string };
      expect(person.ownerId, actor).toBe(sam.id);
    }
  });
});

describe("assignment.apply", () => {
  it("reassigns selected records by the rules, audited and on the timeline", async () => {
    const a = await newPerson({ location: "Sydney" });
    const b = await newPerson({ location: "Perth", ownerId: lee.id });
    const c = await newPerson({ location: "Hobart", ownerId: lee.id });
    await rule({
      name: "East",
      object: "person",
      conditions: [{ field: "location", op: "eq", value: "Sydney" }],
      method: "user",
      userIds: [sam.id],
    });
    await rule({
      name: "West",
      object: "person",
      conditions: [{ field: "location", op: "eq", value: "Perth" }],
      method: "roundRobin",
      userIds: [kim.id],
    });
    const out = await call<{ items: { id: string; ownerId: string; changed: boolean }[] }>(
      "assignment.apply",
      { object: "person", ids: [a.id, b.id, c.id] },
    );
    expect(out.items.map((i) => [i.ownerId, i.changed])).toEqual([
      [sam.id, true],
      [kim.id, true],
      [lee.id, false],
    ]);
    expect((await call<{ ownerId: string }>("person.get", { id: b.id })).ownerId).toBe(kim.id);
    const { results } = await env.DB.prepare(
      "SELECT diff FROM core_audit_changes WHERE record_id = ? ORDER BY rowid DESC LIMIT 1",
    )
      .bind(a.id)
      .all<{ diff: string }>();
    expect(JSON.parse(results[0]?.diff ?? "{}").ownerId).toMatchObject({
      after: sam.id,
      assignedBy: "East",
    });
    expect(await timelineSubjects("person", a.id)).toContain(
      `Assigned to ${sam.name} by rule East`,
    );
  });

  it("reassigns extension records and refuses a missing one", async () => {
    const { id: organisation } = await newOrganisation();
    const lead = await newLead({ organisation, owner: lee.id });
    await rule({ object: "leads.lead", conditions: [], method: "user", userIds: [sam.id] });
    await call("assignment.apply", { object: "leads.lead", ids: [lead.id] });
    const after = await call<Record_>("record.get", { object: "leads.lead", id: lead.id });
    expect(after.values.owner).toBe(sam.id);
    await expect(
      call("assignment.apply", { object: "leads.lead", ids: ["rec_missing"] }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("cost (rows_read budget)", () => {
  let rowsRead = 0;
  const metered = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (query: string) => {
          const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
            new Proxy(stmt, {
              get(s, p) {
                if (p === "bind") return (...args: unknown[]) => wrap(s.bind(...args));
                if (p === "all") {
                  return async () => {
                    const result = await s.all();
                    rowsRead += result.meta.rows_read;
                    return result;
                  };
                }
                const value = Reflect.get(s, p);
                return typeof value === "function" ? value.bind(s) : value;
              },
            });
          return wrap(target.prepare(query));
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const db = createCrmDb(metered);

  async function readsFor(values: Record<string, unknown>): Promise<number> {
    rowsRead = 0;
    await invokeByName("record.create", { object: "leads.lead", values }, context(admin, { db }));
    return rowsRead;
  }

  it("adds a small fixed number of rows per create, however many records exist", async () => {
    const { id: organisation } = await newOrganisation({ industry: "Mining" });
    const baseline = await readsFor({ name: "Baseline", organisation, owner: sam.id });
    await rule({
      object: "leads.lead",
      conditions: [{ via: "organisation", field: "industry", op: "eq", value: "Mining" }],
      method: "roundRobin",
      userIds: [sam.id, kim.id, lee.id],
    });
    await rule({ object: "leads.lead", conditions: [], method: "user", userIds: [sam.id] });
    await call("assignment.setFallback", { object: "leads.lead", userId: kim.id });
    const assigned = await readsFor({ name: "Assigned", organisation });
    // Rules and fallback (3 rows), rule users (3), the organisation's row, the rotation state,
    // and the index and view rows those take: a fixed cost, whatever the table sizes.
    expect(assigned - baseline).toBeLessThanOrEqual(16);
  });

  it("reads nothing more than one query when an object has no rules", async () => {
    const { id: organisation } = await newOrganisation();
    const given = await readsFor({ name: "Given", organisation, owner: sam.id });
    const none = await readsFor({ name: "None", organisation });
    expect(none - given).toBeLessThanOrEqual(2);
  });

  it("an import chunk adds one state read and one state write", async () => {
    await rule({
      object: "person",
      conditions: [],
      method: "roundRobin",
      userIds: [sam.id, kim.id],
    });
    const tag = unique("B");
    const rows = Array.from({ length: 50 }, (_, i) => `${tag} ${i}`).join("\n");
    const statements: string[] = [];
    const counting = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (query: string) => {
            statements.push(query);
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await invokeByName(
      "import.csv.commit",
      { object: "person", csv: `Name\n${rows}\n` },
      context(admin, { db: createCrmDb(counting) }),
    );
    const onState = statements.filter((s) => s.includes("core_assignment_state"));
    expect(onState.filter((s) => s.startsWith("select"))).toHaveLength(1);
    expect(onState.filter((s) => s.startsWith("INSERT"))).toHaveLength(1);
  });
});

describe("the lead object", () => {
  it("needs a person or an organisation, on create and on update", async () => {
    await expect(newLead({ name: "Nobody" })).rejects.toMatchObject({ code: "invalid_input" });
    const { id: organisation } = await newOrganisation();
    const lead = await newLead({ name: "Somebody", organisation });
    await expect(
      call("record.update", { object: "leads.lead", id: lead.id, values: { organisation: null } }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("is named after its person, else its organisation, unless given a name", async () => {
    const person = await call<{ id: string; displayName: string }>("person.create", {
      displayName: "Ada Lovelace",
    });
    const org = await call<{ id: string }>("organisation.create", { name: "Analytical Engines" });
    expect((await newLead({ person: person.id, organisation: org.id })).title).toBe(
      "Ada Lovelace lead",
    );
    expect((await newLead({ organisation: org.id })).title).toBe("Analytical Engines lead");
    expect((await newLead({ name: "Mine", organisation: org.id })).title).toBe("Mine");
  });

  it("starts new, with the default source setting", async () => {
    const { id: organisation } = await newOrganisation();
    const lead = await newLead({ organisation });
    expect(lead.values).toMatchObject({ status: "new", source: "other" });
    await env.DB.prepare(
      "INSERT INTO core_extension_settings (extension_id, value, updated_at) VALUES ('leads', ?, ?)",
    )
      .bind(JSON.stringify({ defaultSource: "website" }), new Date().toISOString())
      .run();
    expect((await newLead({ organisation })).values.source).toBe("website");
    expect((await newLead({ organisation, source: "event" })).values.source).toBe("event");
  });

  it("cannot be set converted or given a deal by hand", async () => {
    const { id: organisation } = await newOrganisation();
    const lead = await newLead({ organisation });
    await expect(
      call("record.update", { object: "leads.lead", id: lead.id, values: { status: "converted" } }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      call("record.update", { object: "leads.lead", id: lead.id, values: { deal: "x" } }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      call("record.update", {
        object: "leads.lead",
        id: lead.id,
        values: { status: "unqualified" },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("editable options", () => {
  it("lets an admin add and relabel options, keeps fixed ones, and goes back to defaults", async () => {
    const { id: organisation } = await newOrganisation();
    const listed = await call<{ items: { field: string; options: { value: string }[] }[] }>(
      "fieldOptions.list",
      { object: "leads.lead" },
    );
    expect(listed.items.map((i) => i.field).sort()).toEqual(["source", "status"]);
    const status = listed.items.find((i) => i.field === "status");
    await expect(
      call("fieldOptions.update", {
        object: "leads.lead",
        field: "status",
        options: [{ value: "new", label: "New" }],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await call("fieldOptions.update", {
      object: "leads.lead",
      field: "status",
      options: [
        ...(status?.options ?? []).map((o) => ({
          value: o.value,
          label: o.value === "new" ? "Fresh" : o.value,
        })),
        { value: "nurturing", label: "Nurturing" },
      ],
    });
    await expect(
      invokeByName(
        "fieldOptions.update",
        { object: "leads.lead", field: "source", options: null },
        context(member),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    const lead = await newLead({ organisation, status: "nurturing" });
    expect(lead.values.status).toBe("nurturing");
    await call("fieldOptions.update", { object: "leads.lead", field: "status", options: null });
    await expect(newLead({ organisation, status: "nurturing" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    // A record holding a removed option keeps it.
    const kept = await call<Record_>("record.get", { object: "leads.lead", id: lead.id });
    expect(kept.values.status).toBe("nurturing");
  });
});
