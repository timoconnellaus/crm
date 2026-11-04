// person.erase / organisation.erase: hard delete now, plus the sanctioned audit redaction
// (ADR 0019). Ordinary updates and deletes of audit rows stay refused.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, ConflictError, ForbiddenError, invoke } from "../src/index.ts";
import { insertActivity, insertTask } from "./fixtures.ts";
import { auditChanges, context, createUser, timeline, unique } from "./helpers.ts";

let admin: ActingUser;
let member: ActingUser;

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
});

async function rowExists(table: string, id: string) {
  return (await env.DB.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).bind(id).first()) !== null;
}

async function auditFor(operation: string, userId: string) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM core_audit WHERE operation = ? AND user_id = ? ORDER BY at, id",
  )
    .bind(operation, userId)
    .all<Record<string, string | null>>();
  return results;
}

describe("person.erase", () => {
  it("hard-deletes the person and redacts their personal data in the audit log", async () => {
    const email = `${unique("subject")}@example.com`;
    const org = await invoke("organisation.create", { name: unique("EraseOrg") }, context(member));
    const person = await invoke(
      "person.create",
      {
        givenName: "Grace",
        familyName: "Hopper",
        emails: [{ email }],
        phones: [{ number: "+1 555 0100 999" }],
        tags: ["Erasable"],
      },
      context(member),
    );
    await invoke("person.update", { id: person.id, location: "Arlington" }, context(member));
    await invoke(
      "person.changeJob",
      { personId: person.id, organisationId: org.id, title: "Rear Admiral" },
      context(member),
    );
    // A failed attempt whose error message carries the email.
    await expect(
      invoke("person.create", { displayName: "Dup", emails: [{ email }] }, context(member)),
    ).rejects.toBeInstanceOf(ConflictError);
    const onlyTheirs = await insertActivity("Private chat", [["person", person.id]]);
    const shared = await insertActivity("Org meeting", [
      ["person", person.id],
      ["organisation", org.id],
    ]);
    const theirTask = await insertTask("Follow up", [["person", person.id]]);
    // An unrelated person's history must survive untouched.
    const bystander = await invoke(
      "person.create",
      { displayName: "Bystander", emails: [{ email: `${unique("by")}@example.com` }] },
      context(member),
    );

    await expect(invoke("person.erase", { id: person.id }, context(member))).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    const result = await invoke("person.erase", { id: person.id }, context(admin));
    expect(result).toMatchObject({
      id: person.id,
      erased: [person.id],
      activitiesDeleted: 2, // the private note and the job-change system activity
      tasksDeleted: 1,
    });
    expect(result.auditRowsRedacted).toBeGreaterThanOrEqual(8);

    // The record and everything it owned are gone; shared activities stay, unlinked.
    expect(await rowExists("core_person", person.id)).toBe(false);
    const leftovers = await env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM core_person_emails WHERE person_id = ?1) AS emails,
        (SELECT COUNT(*) FROM core_person_phones WHERE person_id = ?1) AS phones,
        (SELECT COUNT(*) FROM core_affiliation WHERE person_id = ?1) AS affiliations,
        (SELECT COUNT(*) FROM core_record_tags WHERE record_id = ?1) AS tags,
        (SELECT COUNT(*) FROM core_activity_links WHERE record_id = ?1) AS links,
        (SELECT COUNT(*) FROM core_search_docs WHERE record_id = ?1) AS search`,
    )
      .bind(person.id)
      .first();
    expect(leftovers).toEqual({
      emails: 0,
      phones: 0,
      affiliations: 0,
      tags: 0,
      links: 0,
      search: 0,
    });
    expect(await rowExists("core_activity", onlyTheirs)).toBe(false);
    expect(await rowExists("core_activity", shared)).toBe(true);
    expect(await rowExists("core_task", theirTask)).toBe(false);
    expect((await timeline("organisation", org.id)).map((a) => a.payload.kind)).not.toContain(
      "job_change",
    );

    // Field-change history keeps its shape, with every value erased.
    const changes = await auditChanges(person.id);
    const before = changes.filter((c) => c.action !== "erase");
    expect(before.map((c) => c.operation)).toEqual(["person.create", "person.update"]);
    for (const change of before) {
      for (const value of Object.values(change.diff)) {
        expect(value).toEqual({ before: "[erased]", after: "[erased]" });
      }
    }
    expect(Object.keys(before[0]?.diff ?? {})).toContain("emails");
    expect(changes.at(-1)).toMatchObject({ action: "erase", operation: "person.erase", diff: {} });

    // Audit rows: inputs, results and errors mentioning them are erased; who/when/what kept.
    const created = await auditFor("person.create", member.id);
    const subjectCreate = created.find(
      (r) => String(r.input) === '"[erased]"' && r.outcome === "ok",
    );
    expect(subjectCreate).toMatchObject({ result: '"[erased]"', actor: "human", risk: "write" });
    const failed = created.find((r) => r.outcome === "error");
    expect(failed?.input).toBe('"[erased]"');
    expect(JSON.parse(String(failed?.error))).toEqual({ code: "conflict", message: "[erased]" });
    const bystanderRow = created.find((r) => String(r.result).includes(bystander.id));
    expect(String(bystanderRow?.input)).toContain("Bystander");
    expect((await auditFor("person.changeJob", member.id)).at(-1)?.input).toBe('"[erased]"');
    const blob = JSON.stringify(
      (
        await env.DB.prepare(
          "SELECT a.input, a.result, a.error, c.diff FROM core_audit a LEFT JOIN core_audit_changes c ON c.audit_id = a.id",
        ).all()
      ).results,
    );
    expect(blob).not.toContain(email);
    expect(blob).not.toContain("Hopper");
    expect(blob).not.toContain("+1 555 0100 999");

    // The erase itself is audited and its own row is intact.
    expect((await auditFor("person.erase", admin.id)).at(-1)).toMatchObject({
      outcome: "ok",
      risk: "destructive",
      input: JSON.stringify({ id: person.id }),
    });
    const markers = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM core_audit_redactions WHERE record_id = ? AND operation = 'person.erase' AND user_id = ?",
    )
      .bind(person.id, admin.id)
      .first<{ n: number }>();
    expect(markers?.n).toBe(result.auditRowsRedacted);
  });

  it("still refuses ordinary updates and deletes of audit rows afterwards", async () => {
    const person = await invoke("person.create", { displayName: unique("Tmp") }, context(member));
    await invoke("person.erase", { id: person.id }, context(admin));
    const redacted = await env.DB.prepare(
      "SELECT audit_id, change_id FROM core_audit_redactions WHERE record_id = ? AND audit_id IS NOT NULL",
    )
      .bind(person.id)
      .first<{ audit_id: string }>();
    const auditId = redacted?.audit_id ?? "";
    const run = (sql: string, ...params: unknown[]) =>
      env.DB.prepare(sql)
        .bind(...params)
        .run();
    // A redacted row cannot be rewritten or un-erased.
    await expect(run("UPDATE core_audit SET input = '{}' WHERE id = ?", auditId)).rejects.toThrow(
      /append-only/,
    );
    await expect(run("DELETE FROM core_audit WHERE id = ?", auditId)).rejects.toThrow(
      /append-only/,
    );
    // An unredacted row cannot be touched at all, even with the canonical values.
    await expect(
      run(
        `UPDATE core_audit SET input = '"[erased]"' WHERE id NOT IN (SELECT audit_id FROM core_audit_redactions WHERE audit_id IS NOT NULL)`,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(run("UPDATE core_audit_changes SET diff = '{}'")).rejects.toThrow(/append-only/);
    await expect(run("DELETE FROM core_audit_changes")).rejects.toThrow(/append-only/);
    await expect(run("DELETE FROM core_audit_redactions")).rejects.toThrow(/append-only/);
  });

  it("erases records that were merged into the person, and works from Trash", async () => {
    const survivor = await invoke(
      "person.create",
      { displayName: unique("Surv") },
      context(member),
    );
    const merged = await invoke(
      "person.create",
      { displayName: unique("Dupe"), emails: [{ email: `${unique("dupe")}@example.com` }] },
      context(member),
    );
    await invoke("person.merge", { survivorId: survivor.id, mergedId: merged.id }, context(member));
    await invoke("person.delete", { id: survivor.id }, context(member));
    const result = await invoke("person.erase", { id: survivor.id }, context(admin));
    expect([...result.erased].sort()).toEqual([survivor.id, merged.id].sort());
    expect(await rowExists("core_person", survivor.id)).toBe(false);
    expect(await rowExists("core_person", merged.id)).toBe(false);
  });
});

describe("organisation.erase", () => {
  it("is admin-only and hard-deletes the organisation with its domains and affiliations", async () => {
    const domain = `${unique("gone").toLowerCase()}.com`;
    const org = await invoke(
      "organisation.create",
      { name: unique("GoneCo"), domains: [{ domain }] },
      context(member),
    );
    const person = await invoke("person.create", { displayName: unique("Emp") }, context(member));
    await invoke(
      "affiliation.create",
      { personId: person.id, organisationId: org.id },
      context(member),
    );
    await expect(
      invoke("organisation.erase", { id: org.id }, context(member)),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const result = await invoke("organisation.erase", { id: org.id }, context(admin));
    expect(result.erased).toEqual([org.id]);
    expect(await rowExists("core_organisation", org.id)).toBe(false);
    expect(
      (await invoke("person.get", { id: person.id }, context(member))).primaryAffiliation,
    ).toBeNull();
    for (const change of (await auditChanges(org.id)).filter((c) => c.action !== "erase")) {
      expect(JSON.stringify(change.diff)).not.toContain(domain);
    }
    // The domain is free again.
    await invoke("organisation.create", { name: "New", domains: [{ domain }] }, context(member));
  });
});
