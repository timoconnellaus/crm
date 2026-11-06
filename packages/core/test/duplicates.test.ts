// Stage 16 (ADR 0247): duplicate rules, the creation check, the scan, review and bulk merge, end
// to end on real D1. Storage is shared within this file, so every name is unique() and the scan
// assertions look only at the records each test made.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { loadScanState } from "../src/duplicates/scan.ts";
import {
  type ActingUser,
  invoke,
  organisationNameKey,
  personNameKey,
  runDuplicateCron,
  runTrashPurge,
} from "../src/index.ts";
import { auditRows, context, createUser, db, setPreset, unique } from "./helpers.ts";

let admin: ActingUser;
let member: ActingUser;

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  await setPreset("balanced");
});

async function person(values: Record<string, unknown>, user = member) {
  return invoke("person.create", values as never, context(user));
}

async function organisation(name: string, extra: Record<string, unknown> = {}) {
  return invoke("organisation.create", { name, ...extra } as never, context(member));
}

async function joins(personId: string, organisationId: string) {
  await invoke("person.changeJob", { personId, organisationId }, context(member));
}

/** Runs duplicate.scan until it is done. */
async function scan(mode: "full" | "incremental" = "full") {
  let result = await invoke("duplicate.scan", { mode }, context(admin));
  for (let i = 0; i < 50 && !result.done; i++) {
    result = await invoke("duplicate.scan", { mode: "continue" }, context(admin));
  }
  expect(result.done).toBe(true);
  return result;
}

async function pair(object: string, x: string, y: string) {
  const [a, b] = x < y ? [x, y] : [y, x];
  return env.DB.prepare(
    "SELECT status, rules, details FROM core_duplicate_pair WHERE object = ? AND a_id = ? AND b_id = ?",
  )
    .bind(object, a, b)
    .first<{ status: string; rules: string; details: string }>();
}

async function groupsFor(object: "person" | "organisation", ids: string[]) {
  const list = await invoke("duplicate.list", { object, limit: 100 }, context(member));
  return list.groups.filter((g) => g.members.some((m) => ids.includes(m.id)));
}

describe("rules at creation (duplicate.check)", () => {
  it("same name and same organisation", async () => {
    const org = await organisation(unique("Acme "));
    const name = unique("Jane ");
    const a = await person({ displayName: `${name} Doe` });
    await joins(a.id, org.id);
    const check = await invoke(
      "duplicate.check",
      { object: "person", values: { displayName: `Doe, ${name}`, organisationId: org.id } },
      context(member),
    );
    expect(check.conflicts).toEqual([]);
    expect(check.warnings).toEqual([
      {
        id: a.id,
        title: `${name} Doe`,
        rules: ["same_name_organisation"],
        reasons: [`Same name and same organisation: ${org.name}`],
      },
    ]);
  });

  it("same name and same email domain, but never webmail or internal domains", async () => {
    const name = `${unique("Sam ")} Lee`;
    const domain = `${unique("lee")}.example.org`;
    const a = await person({ displayName: name, emails: [{ email: `sam@${domain}` }] });
    const company = await invoke(
      "duplicate.check",
      { object: "person", values: { displayName: name, emails: [`s.lee@${domain}`] } },
      context(member),
    );
    expect(company.warnings).toEqual([
      expect.objectContaining({
        id: a.id,
        rules: ["same_name_email_domain"],
        reasons: [`Same name and same email domain: ${domain}`],
      }),
    ]);

    const webmailName = `${unique("Kim ")} Park`;
    const w = await person({
      displayName: webmailName,
      emails: [{ email: `${unique("k")}@gmail.com` }],
    });
    const webmail = await invoke(
      "duplicate.check",
      {
        object: "person",
        values: { displayName: webmailName, emails: [`${unique("p")}@gmail.com`] },
      },
      context(member),
    );
    expect(webmail.warnings).toEqual([
      expect.objectContaining({ id: w.id, rules: ["same_name_only"], reasons: ["Same name only"] }),
    ]);

    // The CRM's users are at example.com, so it is an internal domain.
    const internalName = `${unique("Lou ")} Reed`;
    const i = await person({
      displayName: internalName,
      emails: [{ email: `${unique("l")}@example.com` }],
    });
    const internal = await invoke(
      "duplicate.check",
      {
        object: "person",
        values: { displayName: internalName, emails: [`${unique("r")}@example.com`] },
      },
      context(member),
    );
    expect(internal.warnings).toEqual([
      expect.objectContaining({ id: i.id, rules: ["same_name_only"] }),
    ]);
  });

  it("same email is a blocking conflict with the owner's name", async () => {
    const email = `${unique("taken")}@acme.example`;
    const a = await person({ displayName: unique("Owner "), emails: [{ email }] });
    const check = await invoke(
      "duplicate.check",
      { object: "person", values: { displayName: unique("Other "), emails: [email] } },
      context(member),
    );
    expect(check.conflicts).toEqual([
      {
        id: a.id,
        title: a.displayName,
        rules: ["same_email"],
        reasons: [`This email belongs to ${a.displayName}`],
      },
    ]);
  });

  it("same phone number, unless the number is shared by more than the limit", async () => {
    const digits = String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
    const number = `+61 2 ${digits}`;
    const a = await person({ displayName: unique("Phone "), phones: [{ number }] });
    const check = await invoke(
      "duplicate.check",
      { object: "person", values: { displayName: unique("Other "), phones: [`+612${digits}`] } },
      context(member),
    );
    expect(check.warnings).toEqual([
      expect.objectContaining({
        id: a.id,
        rules: ["same_phone"],
        reasons: [`Same phone number: ${number}`],
      }),
    ]);
    // Two more holders make three; a fourth would pass the default limit of 3.
    await person({ displayName: unique("Phone "), phones: [{ number }] });
    await person({ displayName: unique("Phone "), phones: [{ number }] });
    const shared = await invoke(
      "duplicate.check",
      { object: "person", values: { displayName: unique("Other "), phones: [number] } },
      context(member),
    );
    expect(shared.warnings).toEqual([]);
    await invoke("duplicate.updateSettings", { phoneShareLimit: 5 }, context(admin));
    const raised = await invoke(
      "duplicate.check",
      { object: "person", values: { displayName: unique("Other "), phones: [number] } },
      context(member),
    );
    expect(raised.warnings).toHaveLength(3);
    await invoke("duplicate.updateSettings", { phoneShareLimit: 3 }, context(admin));
  });

  it("organisations: same domain conflicts, same name and website warnings", async () => {
    const base = unique("Globex");
    const domain = `${base.toLowerCase()}.example`;
    const a = await organisation(`${base} Pty Ltd`, { domains: [{ domain }] });
    const check = await invoke(
      "duplicate.check",
      {
        object: "organisation",
        values: { name: `The ${base} Inc.`, domains: [`https://www.${domain}/about`] },
      },
      context(member),
    );
    expect(check.conflicts).toEqual([
      expect.objectContaining({
        id: a.id,
        rules: ["same_domain"],
        reasons: [`The domain ${domain} belongs to ${a.name}`],
      }),
    ]);
    const site = await invoke(
      "duplicate.check",
      { object: "organisation", values: { name: unique("Other "), website: `https://${domain}` } },
      context(member),
    );
    expect(site.warnings).toEqual([
      expect.objectContaining({
        id: a.id,
        rules: ["same_domain"],
        reasons: [`Same domain: ${domain}`],
      }),
    ]);
    const named = await invoke(
      "duplicate.check",
      { object: "organisation", values: { name: `${base} Limited` } },
      context(member),
    );
    expect(named.warnings).toEqual([
      expect.objectContaining({ id: a.id, rules: ["same_name"], reasons: ["Same name"] }),
    ]);
  });

  it("person.create and organisation.create return possibleDuplicates", async () => {
    const name = unique("Possible ");
    const first = await person({ displayName: name });
    expect(first.possibleDuplicates).toEqual([]);
    const second = await person({ displayName: name });
    expect(second.possibleDuplicates).toEqual([
      { id: first.id, title: name, rules: ["same_name_only"], reasons: ["Same name only"] },
    ]);
    const orgName = unique("Initech ");
    const o1 = await organisation(orgName);
    const o2 = await organisation(`${orgName} LLC`);
    expect(o2.possibleDuplicates).toEqual([
      expect.objectContaining({ id: o1.id, rules: ["same_name"] }),
    ]);
  });
});

describe("name keys are written by every path that sets a name", () => {
  async function keyOf(table: "core_person" | "core_organisation", id: string) {
    const row = await env.DB.prepare(`SELECT name_key FROM ${table} WHERE id = ?`)
      .bind(id)
      .first<{ name_key: string | null }>();
    return row?.name_key;
  }

  it("person.create, person.update and person.merge", async () => {
    const p = await person({ displayName: "Doe, Jane Q." });
    expect(await keyOf("core_person", p.id)).toBe("jane doe");
    await invoke("person.update", { id: p.id, displayName: "Zoë Brontë" }, context(member));
    expect(await keyOf("core_person", p.id)).toBe("zoe bronte");
    const other = await person({ displayName: "Someone Else" });
    await invoke(
      "person.merge",
      { survivorId: p.id, mergedId: other.id, fields: { displayName: "merged" } },
      context(member),
    );
    expect(await keyOf("core_person", p.id)).toBe("someone else");
    const emailOnly = await person({ emails: [{ email: `${unique("e")}@x.example` }] });
    expect(await keyOf("core_person", emailOnly.id)).toBeNull();
  });

  it("organisation.create, organisation.update and organisation.merge", async () => {
    const o = await organisation("The Acme Co. Pty Ltd");
    expect(await keyOf("core_organisation", o.id)).toBe("acme");
    await invoke("organisation.update", { id: o.id, name: "Smith & Sons GmbH" }, context(member));
    expect(await keyOf("core_organisation", o.id)).toBe("smith and sons");
    const other = await organisation("Initrode S.A.");
    await invoke(
      "organisation.merge",
      { survivorId: o.id, mergedId: other.id, fields: { name: "merged" } },
      context(member),
    );
    expect(await keyOf("core_organisation", o.id)).toBe("initrode");
  });

  it("import.csv.commit, for people, their new organisations and organisations", async () => {
    const tag = unique("imp");
    const people = await invoke(
      "import.csv.commit",
      {
        object: "person",
        csv: `name,email,organisation\n"Doe, Ann ${tag}",ann-${tag}@x.example,The ${tag} Ltd\n`,
      },
      context(member),
    );
    const pid = people.rows[0]?.id as string;
    expect(await keyOf("core_person", pid)).toBe(personNameKey(`Ann ${tag} Doe`));
    const org = await env.DB.prepare("SELECT id, name_key FROM core_organisation WHERE name = ?")
      .bind(`The ${tag} Ltd`)
      .first<{ id: string; name_key: string }>();
    expect(org?.name_key).toBe(tag.toLowerCase());

    const orgs = await invoke(
      "import.csv.commit",
      { object: "organisation", csv: `name\n${tag} Holdings Inc.\n` },
      context(member),
    );
    expect(await keyOf("core_organisation", orgs.rows[0]?.id as string)).toBe(
      organisationNameKey(`${tag} Holdings Inc.`),
    );
  });
});

describe("the scan", () => {
  it("a full scan finds pairs, with every rule they match", async () => {
    const org = await organisation(unique("Scan Org "));
    const name = unique("Scan ");
    const a = await person({
      displayName: `${name} Smith`,
      emails: [{ email: `a@${unique("d")}.io` }],
    });
    const b = await person({ displayName: `Smith, ${name}` });
    await joins(a.id, org.id);
    await joins(b.id, org.id);
    const lone = unique("Lone ");
    const c = await person({ displayName: lone });
    const d = await person({ displayName: lone });
    const o1 = await organisation(unique("Scan Corp "));
    const o2 = await organisation(`${o1.name} Inc`);
    await scan("full");
    expect(await pair("person", a.id, b.id)).toMatchObject({
      status: "open",
      rules: JSON.stringify(["same_name_organisation"]),
    });
    expect(await pair("person", c.id, d.id)).toMatchObject({
      rules: JSON.stringify(["same_name_only"]),
    });
    expect(await pair("organisation", o1.id, o2.id)).toMatchObject({
      rules: JSON.stringify(["same_name"]),
    });

    const [likely] = await groupsFor("person", [a.id]);
    expect(likely).toMatchObject({
      kind: "likely",
      preselected: true,
      reasons: [`Same name and same organisation: ${org.name}`],
    });
    const [nameOnly] = await groupsFor("person", [c.id]);
    expect(nameOnly).toMatchObject({ kind: "nameOnly", preselected: false });
  });

  it("the incremental scan finds pairs among records changed since the cursor", async () => {
    await scan("full");
    const name = unique("Incr ");
    const a = await person({ displayName: name });
    const b = await person({ displayName: name });
    expect(await pair("person", a.id, b.id)).toBeNull();
    const result = await scan("incremental");
    expect(result.ran).toContain("incremental");
    expect(await pair("person", a.id, b.id)).toMatchObject({ status: "open" });

    // A rename that no longer matches drops the pair on the next scan.
    await invoke("person.update", { id: b.id, displayName: unique("Renamed ") }, context(member));
    await scan("incremental");
    expect(await pair("person", a.id, b.id)).toBeNull();
  });

  it("dismissed pairs never return", async () => {
    const name = unique("Dismiss ");
    const a = await person({ displayName: name });
    const b = await person({ displayName: name });
    await scan("incremental");
    const dismissed = await invoke(
      "duplicate.dismiss",
      { object: "person", ids: [a.id, b.id] },
      context(member),
    );
    expect(dismissed).toEqual({ dismissed: 1 });
    await invoke("person.update", { id: a.id, location: "Sydney" }, context(member));
    await scan("incremental");
    await scan("full");
    expect(await pair("person", a.id, b.id)).toMatchObject({ status: "dismissed" });
    expect(await groupsFor("person", [a.id, b.id])).toEqual([]);
  });

  it("trashed and merged records close their pairs", async () => {
    const name = unique("Close ");
    const a = await person({ displayName: name });
    const b = await person({ displayName: name });
    const c = await person({ displayName: name });
    await scan("incremental");
    expect(await groupsFor("person", [a.id])).toHaveLength(1);

    await invoke("person.delete", { id: c.id }, context(member));
    // Hidden at once, removed by the next scan.
    expect((await groupsFor("person", [a.id]))[0]?.members.map((m) => m.id).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    await scan("incremental");
    expect(await pair("person", a.id, c.id)).toBeNull();

    await invoke("person.merge", { survivorId: a.id, mergedId: b.id }, context(member));
    expect(await pair("person", a.id, b.id)).toMatchObject({ status: "merged" });
    expect(await groupsFor("person", [a.id])).toEqual([]);
  });

  it("an import asks for a scan on the next tick, over the imported records", async () => {
    await scan("full");
    const name = unique("Imported ");
    const existing = await person({ displayName: name });

    // The dry run flags the row, which still creates.
    const input = {
      object: "person" as const,
      csv: `name,email\n${name},${unique("i")}@x.example\n`,
    };
    const preview = await invoke("import.csv.preview", input, context(member));
    expect(preview.rows[0]).toMatchObject({
      action: "create",
      reason: `Possible duplicate of ${name}: same name`,
    });

    const before = await loadScanState(db.query);
    const committed = await invoke("import.csv.commit", input, context(member));
    const importedId = committed.rows[0]?.id as string;
    expect(await pair("person", existing.id, importedId)).toBeNull();

    const tick = await runDuplicateCron(db, new Date());
    expect(tick.mode).toBe("continue");
    expect(await pair("person", existing.id, importedId)).toMatchObject({ status: "open" });
    // Tonight's scan still runs.
    expect((await loadScanState(db.query)).lastIncrementalDate).toBe(before.lastIncrementalDate);
  });

  it("erasing or purging a record removes its pairs, dismissed ones too", async () => {
    const name = unique("Gone ");
    const a = await person({ displayName: name });
    const b = await person({ displayName: name });
    const c = await person({ displayName: name });
    await scan("incremental");
    await invoke("duplicate.dismiss", { object: "person", ids: [a.id, b.id] }, context(member));
    await invoke("person.erase", { id: a.id }, context(admin));
    expect(await pair("person", a.id, b.id)).toBeNull();
    expect(await pair("person", a.id, c.id)).toBeNull();
    expect(await pair("person", b.id, c.id)).toMatchObject({ status: "open" });

    await invoke("person.delete", { id: c.id }, context(member));
    await env.DB.prepare(
      "UPDATE core_person SET deleted_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    )
      .bind(c.id)
      .run();
    await runTrashPurge(db);
    expect(await pair("person", b.id, c.id)).toBeNull();
  });

  it("an erased organisation leaves no reason naming it on other pairs", async () => {
    const org = await organisation(unique("Erased Org "));
    const name = unique("Staff ");
    const a = await person({ displayName: name });
    const b = await person({ displayName: name });
    await joins(a.id, org.id);
    await joins(b.id, org.id);
    await scan("incremental");
    expect((await pair("person", a.id, b.id))?.details).toContain(org.id);
    await invoke("organisation.erase", { id: org.id }, context(admin));
    expect(await pair("person", a.id, b.id)).toBeNull();
  });

  it("groups of three show as one group, with a proposed survivor", async () => {
    const org = await organisation(unique("Trio "));
    const name = unique("Trio ");
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const p = await person({ displayName: name });
      await joins(p.id, org.id);
      ids.push(p.id);
    }
    // The second has the most activities, so it is proposed as the survivor.
    await invoke(
      "activity.log",
      { type: "note", body: "Met", links: [{ object: "person", id: ids[1] as string }] },
      context(member),
    );
    await scan("incremental");
    const groups = await groupsFor("person", ids);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((m) => m.id).sort()).toEqual([...ids].sort());
    expect(groups[0]?.pairs).toHaveLength(3);
    expect(groups[0]?.survivorId).toBe(ids[1]);
    expect(groups[0]?.survivorReason).toMatch(/more activities/);

    const filtered = await invoke(
      "duplicate.list",
      { object: "person", rule: "same_phone", limit: 100 },
      context(member),
    );
    expect(filtered.groups.some((g) => g.members.some((m) => ids.includes(m.id)))).toBe(false);
    const count = await invoke("duplicate.count", {}, context(member));
    expect(count.person).toBeGreaterThanOrEqual(3);
  });

  it("only admins run a full scan", async () => {
    await expect(invoke("duplicate.scan", { mode: "full" }, context(member))).rejects.toMatchObject(
      { code: "forbidden" },
    );
  });
});

describe("bulk merge", () => {
  it("merges 50 groups through person.merge, each audited, and lists failures", async () => {
    const groups: { survivorId: string; mergedIds: string[] }[] = [];
    for (let i = 0; i < 50; i++) {
      const name = unique("Bulk ");
      const a = await person({ displayName: name });
      const b = await person({ displayName: name });
      groups.push({ survivorId: a.id, mergedIds: [b.id] });
    }
    // One duplicate is already in Trash: its merge fails, the others go ahead.
    const failing = groups[7]?.mergedIds[0] as string;
    await invoke("person.delete", { id: failing }, context(member));
    const before = (await auditRows("person.merge", member.id)).length;
    const result = await invoke(
      "duplicate.mergeMany",
      { object: "person", groups },
      context(member),
    );
    expect(result).toMatchObject({ merged: 49, failed: 1, queued: 0, changeSetId: null });
    expect(result.results[7]?.failed).toEqual([
      expect.objectContaining({ id: failing, code: "not_found" }),
    ]);
    const audits = await auditRows("person.merge", member.id);
    expect(audits.length - before).toBe(50);
    expect(audits.slice(before).filter((a) => a.outcome === "ok")).toHaveLength(49);
    const merged = await env.DB.prepare("SELECT merged_into_id FROM core_person WHERE id = ?")
      .bind(groups[0]?.mergedIds[0])
      .first<{ merged_into_id: string }>();
    expect(merged?.merged_into_id).toBe(groups[0]?.survivorId);
  });

  it("an AI client's bulk merge is one titled change set", async () => {
    const groups: { survivorId: string; mergedIds: string[] }[] = [];
    for (let i = 0; i < 3; i++) {
      const name = unique("Ai ");
      const a = await person({ displayName: name });
      const b = await person({ displayName: name });
      const c = await person({ displayName: name });
      groups.push({ survivorId: a.id, mergedIds: [b.id, c.id] });
    }
    const sessionId = unique("session");
    const result = await invoke(
      "duplicate.mergeMany",
      { object: "person", groups },
      context(member, {
        actor: "mcp",
        origin: { surface: "mcp", clientId: "c1", clientName: "Client", sessionId },
      }),
    );
    expect(result).toMatchObject({ merged: 0, queued: 6, failed: 0 });
    const set = await env.DB.prepare("SELECT title, state FROM core_change_set WHERE id = ?")
      .bind(result.changeSetId)
      .first<{ title: string; state: string }>();
    expect(set).toEqual({ title: "Merge 6 duplicate people", state: "committed" });
    const actions = await env.DB.prepare(
      "SELECT operation FROM core_pending_action WHERE change_set_id = ?",
    )
      .bind(result.changeSetId)
      .all<{ operation: string }>();
    expect(actions.results.map((a) => a.operation)).toEqual(Array(6).fill("person.merge"));
  });

  it("refuses ids of the wrong object and repeated ids", async () => {
    const p = await person({ displayName: unique("Wrong ") });
    const o = await organisation(unique("Wrong "));
    await expect(
      invoke(
        "duplicate.mergeMany",
        { object: "person", groups: [{ survivorId: p.id, mergedIds: [o.id] }] },
        context(member),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      invoke(
        "duplicate.mergeMany",
        { object: "person", groups: [{ survivorId: p.id, mergedIds: [p.id] }] },
        context(member),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
