// Behaviour the stage-1 schema itself guarantees (constraints, triggers, FTS, read views), checked
// against real D1. Operations rely on these as the backstop behind their own validation.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/index.ts";

const NOW = "2026-11-04T10:00:00.000Z";
const db = () => env.DB;

async function run(sql: string, ...params: unknown[]) {
  return db()
    .prepare(sql)
    .bind(...params)
    .run();
}

async function addUser(id: string, email: string) {
  await run(
    "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)",
    id,
    email,
    email,
    NOW,
    NOW,
  );
}

async function addPerson(id: string, name: string, emails: string[] = []) {
  await run(
    "INSERT INTO core_person (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    id,
    name,
    NOW,
    NOW,
  );
  for (const [i, email] of emails.entries()) {
    await run(
      "INSERT INTO core_person_emails (id, person_id, email, is_primary, position, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      `eml_${id}_${i}`,
      id,
      email,
      i === 0 ? 1 : 0,
      i,
      NOW,
    );
  }
}

async function search(query: string) {
  const { results } = await db()
    .prepare(
      "SELECT d.object_type, d.record_id FROM core_search s JOIN core_search_docs d ON d.id = s.rowid WHERE core_search MATCH ? ORDER BY rank",
    )
    .bind(query)
    .all<{ object_type: string; record_id: string }>();
  return results;
}

// D1 storage is shared by the tests in this file, so each test starts from empty record tables.
// (The audit tables are append-only and cannot be cleared; the audit test uses its own ids.)
beforeEach(async () => {
  await applyMigrations(env.DB, env.TEST_MIGRATIONS);
  await db().batch(
    [
      "core_affiliation",
      "core_person",
      "core_organisation",
      "core_record_tags",
      "core_tags",
      "core_activity",
      "core_task",
      "core_user",
    ].map((table) => db().prepare(`DELETE FROM ${table}`)),
  );
});

describe("users and settings", () => {
  it("makes the first user admin and later users members", async () => {
    await addUser("usr_1", "a@example.com");
    await addUser("usr_2", "b@example.com");
    const { results } = await db()
      .prepare("SELECT id, role FROM core_user ORDER BY id")
      .all<{ id: string; role: string }>();
    expect(results).toEqual([
      { id: "usr_1", role: "admin" },
      { id: "usr_2", role: "member" },
    ]);
  });

  it("rejects unknown roles", async () => {
    await addUser("usr_1", "a@example.com");
    await expect(run("UPDATE core_user SET role = 'owner'")).rejects.toThrow(/CHECK/);
  });

  it("seeds the Balanced approval policy", async () => {
    const row = await db()
      .prepare("SELECT value FROM core_settings WHERE key = 'approval_policy'")
      .first<{ value: string }>();
    expect(JSON.parse(row?.value ?? "null")).toEqual({ preset: "balanced" });
  });
});

describe("people", () => {
  it("keeps emails unique across live people only", async () => {
    await addPerson("per_1", "Ada", ["ada@example.com"]);
    await expect(addPerson("per_2", "Ada 2", ["ada@example.com"])).rejects.toThrow(/UNIQUE/);

    await run("UPDATE core_person SET deleted_at = ? WHERE id = 'per_1'", NOW);
    await addPerson("per_3", "Ada 3", ["ada@example.com"]);

    // Restoring per_1 would duplicate a live email, so it fails.
    await expect(
      run("UPDATE core_person SET deleted_at = NULL WHERE id = 'per_1'"),
    ).rejects.toThrow(/UNIQUE/);
  });

  it("allows one primary email per person", async () => {
    await addPerson("per_1", "Ada", ["ada@example.com"]);
    await expect(
      run(
        "INSERT INTO core_person_emails (id, person_id, email, is_primary, created_at) VALUES ('e2', 'per_1', 'b@example.com', 1, ?)",
        NOW,
      ),
    ).rejects.toThrow(/UNIQUE/);
  });

  it("allows one primary affiliation per person", async () => {
    await addPerson("per_1", "Ada");
    await run(
      "INSERT INTO core_organisation (id, name, created_at, updated_at) VALUES ('org_1', 'Acme', ?, ?)",
      NOW,
      NOW,
    );
    const insert = (id: string) =>
      run(
        "INSERT INTO core_affiliation (id, person_id, organisation_id, is_primary, created_at, updated_at) VALUES (?, 'per_1', 'org_1', 1, ?, ?)",
        id,
        NOW,
        NOW,
      );
    await insert("aff_1");
    await expect(insert("aff_2")).rejects.toThrow(/UNIQUE/);
  });
});

describe("organisations", () => {
  it("keeps domains unique across live organisations", async () => {
    const addOrg = async (id: string, domain: string) => {
      await run(
        "INSERT INTO core_organisation (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
        id,
        id,
        NOW,
        NOW,
      );
      await run(
        "INSERT INTO core_organisation_domains (id, organisation_id, domain, is_primary, created_at) VALUES (?, ?, ?, 1, ?)",
        `dom_${id}`,
        id,
        domain,
        NOW,
      );
    };
    await addOrg("org_1", "acme.com");
    await expect(addOrg("org_2", "acme.com")).rejects.toThrow(/UNIQUE/);
    await run("UPDATE core_organisation SET deleted_at = ? WHERE id = 'org_1'", NOW);
    await addOrg("org_3", "acme.com");
  });
});

describe("search index", () => {
  it("indexes people by name and email and follows edits and soft deletes", async () => {
    await addPerson("per_1", "Ada Lovelace", ["ada@analytical.example"]);
    expect(await search("lovelace")).toEqual([{ object_type: "person", record_id: "per_1" }]);
    expect(await search("analytical")).toEqual([{ object_type: "person", record_id: "per_1" }]);
    expect(await search("lov*")).toHaveLength(1);

    await run("UPDATE core_person SET display_name = 'Ada King' WHERE id = 'per_1'");
    expect(await search("lovelace")).toEqual([]);
    expect(await search("king")).toHaveLength(1);

    await run("DELETE FROM core_person_emails WHERE person_id = 'per_1'");
    expect(await search("analytical")).toEqual([]);

    await run("UPDATE core_person SET deleted_at = ? WHERE id = 'per_1'", NOW);
    expect(await search("king")).toEqual([]);
    await run("UPDATE core_person SET deleted_at = NULL WHERE id = 'per_1'");
    expect(await search("king")).toHaveLength(1);

    await run("DELETE FROM core_person WHERE id = 'per_1'");
    expect(await search("king")).toEqual([]);
  });

  it("indexes organisations by name and domain, and activity and task text", async () => {
    await run(
      "INSERT INTO core_organisation (id, name, created_at, updated_at) VALUES ('org_1', 'Initech', ?, ?)",
      NOW,
      NOW,
    );
    await run(
      "INSERT INTO core_organisation_domains (id, organisation_id, domain, created_at) VALUES ('d1', 'org_1', 'initech.example', ?)",
      NOW,
    );
    await run(
      "INSERT INTO core_activity (id, type, subject, body, occurred_at, created_at, updated_at) VALUES ('act_1', 'note', 'Kickoff', 'Discussed staplers', ?, ?, ?)",
      NOW,
      NOW,
      NOW,
    );
    await run(
      "INSERT INTO core_task (id, title, created_at, updated_at) VALUES ('tsk_1', 'Send TPS report', ?, ?)",
      NOW,
      NOW,
    );
    expect(await search("initech")).toEqual([{ object_type: "organisation", record_id: "org_1" }]);
    expect(await search("staplers")).toEqual([{ object_type: "activity", record_id: "act_1" }]);
    expect(await search("tps")).toEqual([{ object_type: "task", record_id: "tsk_1" }]);
  });
});

describe("audit log", () => {
  it("is append-only", async () => {
    await run(
      `INSERT INTO core_audit (id, at, operation, risk, actor, origin, input, gate_decision, outcome)
       VALUES ('aud_1', ?, 'person.create', 'write', 'human', '{}', '{}', 'auto', 'ok')`,
      NOW,
    );
    await run(
      "INSERT INTO core_audit_changes (audit_id, object_type, record_id, action, diff, at) VALUES ('aud_1', 'person', 'per_1', 'create', '{}', ?)",
      NOW,
    );
    await expect(run("UPDATE core_audit SET outcome = 'error'")).rejects.toThrow(/append-only/);
    await expect(run("DELETE FROM core_audit")).rejects.toThrow(/append-only/);
    await expect(run("UPDATE core_audit_changes SET diff = '[]'")).rejects.toThrow(/append-only/);
    await expect(run("DELETE FROM core_audit_changes")).rejects.toThrow(/append-only/);
  });
});

describe("crm_* read views", () => {
  it("crm_people shows live people with primary email, job and tags", async () => {
    await addPerson("per_1", "Ada", ["ada@example.com", "ada2@example.com"]);
    await addPerson("per_2", "Gone", []);
    await run("UPDATE core_person SET deleted_at = ? WHERE id = 'per_2'", NOW);
    await run(
      "INSERT INTO core_organisation (id, name, created_at, updated_at) VALUES ('org_1', 'Acme', ?, ?)",
      NOW,
      NOW,
    );
    await run(
      "INSERT INTO core_affiliation (id, person_id, organisation_id, title, is_primary, created_at, updated_at) VALUES ('aff_1', 'per_1', 'org_1', 'CTO', 1, ?, ?)",
      NOW,
      NOW,
    );
    await run("INSERT INTO core_tags (id, name, created_at) VALUES ('tag_1', 'VIP', ?)", NOW);
    await run(
      "INSERT INTO core_record_tags (tag_id, object_type, record_id, created_at) VALUES ('tag_1', 'person', 'per_1', ?)",
      NOW,
    );

    const { results } = await db().prepare("SELECT * FROM crm_people").all();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: "per_1",
      primary_email: "ada@example.com",
      emails: '["ada@example.com","ada2@example.com"]',
      job_title: "CTO",
      organisation_name: "Acme",
      tags: '["VIP"]',
    });
  });

  it("crm_users exposes no auth columns", async () => {
    const { results } = await db().prepare("SELECT name FROM pragma_table_info('crm_users')").all<{
      name: string;
    }>();
    expect(results.map((r) => r.name).sort()).toEqual(
      ["created_at", "email", "id", "image", "name", "role"].sort(),
    );
  });
});
