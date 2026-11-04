// AC1: the schema reconciler (ADR 0024). Plans are applied directly here; extension.install runs
// the same plans through the runtime (apps/runner/test).
import { env } from "cloudflare:workers";
import { CompiledQuery } from "kysely";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  applyPlan,
  invoke,
  invokeByName,
  refreshSchemaRegistry,
} from "../src/index.ts";
import { columns, exists, extId, manifest, plan, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, unique } from "./helpers.ts";

let admin: ActingUser;
beforeAll(async () => {
  admin = await createUser("admin");
});

const projectObject = {
  label: "Project",
  plural: "Projects",
  titleField: "name",
  fields: {
    name: { type: "text" as const, label: "Name", required: true },
    budget: { type: "number" as const, label: "Budget" },
  },
};

describe("reconciler: objects", () => {
  it("adds an object: table, view, registry and records", async () => {
    const id = extId("obj");
    const p = await reconcile(manifest(id, { objects: { project: projectObject } }));
    expect(p.changes).toContainEqual({ kind: "create_object", object: `${id}.project` });
    expect(p.ddl.some((d) => d.startsWith(`CREATE TABLE x_${id}_project`))).toBe(true);
    expect(await columns(`x_${id}_project`)).toEqual(
      expect.arrayContaining(["id", "created_at", "deleted_at", "name", "budget"]),
    );
    expect(await exists(`crm_x_${id}_project`)).toBe(true);

    const created = await invoke(
      "record.create",
      { object: `${id}.project`, values: { name: "Apollo", budget: 100 } },
      context(admin),
    );
    expect(created).toMatchObject({ title: "Apollo", values: { name: "Apollo", budget: 100 } });
    const page = await invoke("record.list", { object: `${id}.project` }, context(admin));
    expect(page.items.map((r) => r.id)).toEqual([created.id]);
  });

  it("never touches core_* tables", async () => {
    const id = extId("core");
    const p = await plan(
      manifest(id, {
        objects: { project: projectObject },
        fields: { organisation: { tier: { type: "text", label: "Tier" } } },
      }),
    );
    for (const ddl of p.ddl) {
      expect(ddl).not.toMatch(/(CREATE|ALTER|DROP) TABLE (IF EXISTS )?core_/);
    }
  });

  it("hides a removed object, keeps its records, and restores it when declared again", async () => {
    const id = extId("hide");
    await reconcile(manifest(id, { objects: { project: projectObject } }));
    const record = await invoke(
      "record.create",
      { object: `${id}.project`, values: { name: "Kept" } },
      context(admin),
    );
    const hidden = await reconcile(manifest(id, {}));
    expect(hidden.changes).toContainEqual(
      expect.objectContaining({ kind: "hide_object", object: `${id}.project` }),
    );
    expect(await exists(`crm_x_${id}_project`)).toBe(false);
    expect(await exists(`x_${id}_project`)).toBe(true);
    await reconcile(manifest(id, { objects: { project: projectObject } }));
    const back = await invoke(
      "record.get",
      { object: `${id}.project`, id: record.id },
      context(admin),
    );
    expect(back.values.name).toBe("Kept");
  });

  it("renames an object with renamedFrom, keeping records, tags and search", async () => {
    const id = extId("ren");
    await reconcile(manifest(id, { objects: { project: projectObject } }));
    const record = await invoke(
      "record.create",
      { object: `${id}.project`, values: { name: unique("Zephyr") } },
      context(admin),
    );
    const p = await reconcile(
      manifest(id, { objects: { initiative: { ...projectObject, renamedFrom: "project" } } }),
    );
    expect(p.changes).toContainEqual(
      expect.objectContaining({ kind: "rename_object", object: `${id}.initiative` }),
    );
    expect(await exists(`x_${id}_project`)).toBe(false);
    const got = await invoke(
      "record.get",
      { object: `${id}.initiative`, id: record.id },
      context(admin),
    );
    expect(got.title).toBe(record.title);
    const search = await env.DB.prepare(
      "SELECT object_type FROM core_search_docs WHERE record_id = ?",
    )
      .bind(record.id)
      .first<{ object_type: string }>();
    expect(search?.object_type).toBe(`${id}.initiative`);
  });
});

describe("reconciler: fields on core objects", () => {
  it("adds fields to organisation in a side table joined into crm_organisations", async () => {
    const id = extId("side");
    const p = await reconcile(
      manifest(id, {
        fields: {
          organisation: {
            tier: { type: "select", label: "Tier", options: [{ value: "gold", label: "Gold" }] },
            score: { type: "number", label: "Score" },
          },
        },
      }),
    );
    expect(p.ddl).toContain(`CREATE TABLE x_${id}_organisation (id TEXT PRIMARY KEY NOT NULL)`);
    expect(await columns(`x_${id}_organisation`)).toEqual(["id", "tier", "score"]);
    expect(await columns("crm_organisations")).toEqual(
      expect.arrayContaining(["name", `${id}__tier`, `${id}__score`]),
    );

    const org = await invoke("organisation.create", { name: unique("Side Co") }, context(admin));
    const updated = await invoke(
      "record.update",
      {
        object: "organisation",
        id: org.id,
        values: { [`${id}.tier`]: "gold", [`${id}.score`]: 7 },
      },
      context(admin),
    );
    expect(updated.values).toMatchObject({ [`${id}.tier`]: "gold", [`${id}.score`]: 7 });

    // Filter the core list by the extension field.
    const list = await invoke(
      "organisation.list",
      { filter: { field: `${id}.score`, op: "gte", value: 5 } },
      context(admin),
    );
    expect(list.items.map((o) => o.id)).toEqual([org.id]);

    // Core fields still come from organisation.update.
    await expect(
      invoke(
        "record.update",
        { object: "organisation", id: org.id, values: { name: "x" } },
        context(admin),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("renames a field with renamedFrom and keeps its data", async () => {
    const id = extId("rf");
    await reconcile(
      manifest(id, { fields: { organisation: { score: { type: "number", label: "Score" } } } }),
    );
    const org = await invoke("organisation.create", { name: unique("Rename Co") }, context(admin));
    await invoke(
      "record.update",
      { object: "organisation", id: org.id, values: { [`${id}.score`]: 42 } },
      context(admin),
    );
    const p = await reconcile(
      manifest(id, {
        fields: {
          organisation: { rating: { type: "number", label: "Rating", renamedFrom: "score" } },
        },
      }),
    );
    expect(p.changes).toContainEqual(
      expect.objectContaining({ kind: "rename_field", field: `${id}.rating`, from: `${id}.score` }),
    );
    expect(p.ddl).toContain(`ALTER TABLE x_${id}_organisation RENAME COLUMN score TO rating`);
    const got = await invoke("record.get", { object: "organisation", id: org.id }, context(admin));
    expect(got.values[`${id}.rating`]).toBe(42);
    expect(got.values).not.toHaveProperty(`${id}.score`);
  });

  it("without renamedFrom, a missing field is hidden (not dropped) and a new one added", async () => {
    const id = extId("norf");
    await reconcile(
      manifest(id, { fields: { organisation: { score: { type: "number", label: "S" } } } }),
    );
    const p = await reconcile(
      manifest(id, { fields: { organisation: { rating: { type: "number", label: "R" } } } }),
    );
    expect(p.changes.map((c) => c.kind).sort()).toEqual(["add_field", "hide_field"]);
    expect(await columns(`x_${id}_organisation`)).toEqual(["id", "score", "rating"]);
  });

  it("hides a removed field, keeps its data 30 days, then drops it only on request", async () => {
    const id = extId("drop");
    await reconcile(
      manifest(id, {
        fields: {
          organisation: {
            keep: { type: "text", label: "Keep" },
            gone: { type: "text", label: "Gone" },
          },
        },
      }),
    );
    const org = await invoke("organisation.create", { name: unique("Drop Co") }, context(admin));
    await invoke(
      "record.update",
      { object: "organisation", id: org.id, values: { [`${id}.gone`]: "precious" } },
      context(admin),
    );
    const hidden = await reconcile(
      manifest(id, { fields: { organisation: { keep: { type: "text", label: "Keep" } } } }),
    );
    expect(hidden.changes).toContainEqual(
      expect.objectContaining({ kind: "hide_field", field: `${id}.gone` }),
    );
    expect(await columns("crm_organisations")).not.toContain(`${id}__gone`);
    const stored = await env.DB.prepare(`SELECT gone FROM x_${id}_organisation WHERE id = ?`)
      .bind(org.id)
      .first<{ gone: string }>();
    expect(stored?.gone).toBe("precious");

    // Too early: nothing is dropped.
    const early = (await invokeByName("extension.dropHidden", { id }, context(admin))) as {
      changes: unknown[];
    };
    expect(early.changes).toEqual([]);
    expect(await columns(`x_${id}_organisation`)).toContain("gone");

    // After 30 days, an explicit destructive call drops it (and is audited).
    const later = new Date(Date.now() + 31 * 86_400_000);
    const dropped = (await invokeByName(
      "extension.dropHidden",
      { id },
      context(admin, { clock: () => later }),
    )) as { changes: { kind: string; field?: string }[] };
    expect(dropped.changes).toEqual([
      { kind: "drop_field", object: "organisation", field: `${id}.gone` },
    ]);
    expect(await columns(`x_${id}_organisation`)).toEqual(["id", "keep"]);
    const audit = await env.DB.prepare(
      "SELECT risk FROM core_audit WHERE operation = 'extension.dropHidden' AND outcome = 'ok' ORDER BY at DESC LIMIT 1",
    ).first<{ risk: string }>();
    expect(audit?.risk).toBe("destructive");
  });

  it("dropHidden asked for by an MCP client always waits for a person", async () => {
    await expect(
      invokeByName("extension.dropHidden", { id: "whatever" }, context(admin, { actor: "mcp" })),
    ).rejects.toMatchObject({ code: "pending_approval" });
  });
});

describe("reconciler: type changes", () => {
  it("accepts a lossless change (number → currency, text → longText)", async () => {
    const id = extId("ll");
    await reconcile(
      manifest(id, {
        fields: {
          organisation: {
            amount: { type: "number", label: "Amount" },
            notes: { type: "text", label: "Notes" },
          },
        },
      }),
    );
    const p = await reconcile(
      manifest(id, {
        fields: {
          organisation: {
            amount: { type: "currency", label: "Amount", currency: "EUR" },
            notes: { type: "longText", label: "Notes" },
          },
        },
      }),
    );
    expect(p.issues).toEqual([]);
    expect(p.changes).toContainEqual(
      expect.objectContaining({
        kind: "change_type",
        field: `${id}.amount`,
        detail: "number → currency",
      }),
    );
  });

  it("refuses a lossy change with a suggestion", async () => {
    const id = extId("lossy");
    await reconcile(
      manifest(id, { fields: { organisation: { code: { type: "text", label: "Code" } } } }),
    );
    const p = await plan(
      manifest(id, { fields: { organisation: { code: { type: "number", label: "Code" } } } }),
    );
    expect(p.issues).toEqual([
      expect.objectContaining({
        code: "lossy_type_change",
        path: "fields.organisation.code.type",
        suggestion: expect.stringContaining("Add a new number field"),
      }),
    ]);
    await expect(applyPlan((s) => db.batch(s), p)).rejects.toThrow(/issues/);
  });
});

describe("reconciler: views", () => {
  it("regenerates crm_* views with every extension's columns and formulas", async () => {
    const a = extId("va");
    const b = extId("vb");
    await reconcile(
      manifest(a, { fields: { person: { nickname: { type: "text", label: "Nick" } } } }),
    );
    await reconcile(
      manifest(b, {
        fields: {
          person: {
            vip: { type: "boolean", label: "VIP" },
            shout: { type: "formula", label: "Shout", expression: "upper(displayName)" },
          },
        },
      }),
    );
    const cols = await columns("crm_people");
    expect(cols).toEqual(
      expect.arrayContaining(["display_name", `${a}__nickname`, `${b}__vip`, `${b}__shout`]),
    );
    const person = await invoke(
      "person.create",
      { givenName: "Ada", familyName: "Byron" },
      context(admin),
    );
    const row = await env.DB.prepare(`SELECT ${b}__shout AS shout FROM crm_people WHERE id = ?`)
      .bind(person.id)
      .first<{ shout: string }>();
    expect(row?.shout).toBe("ADA BYRON");
    // Stage-1 queries over crm_people still work unchanged.
    const list = await invoke("person.list", { limit: 5 }, context(admin));
    expect(list.items.length).toBeGreaterThan(0);
    // query.sql can read the new columns but never the base views.
    const sqlResult = await invoke(
      "query.sql",
      { sql: `SELECT id, ${b}__shout FROM crm_people WHERE id = ?`, params: [person.id] },
      context(admin),
    );
    expect(sqlResult.rows).toHaveLength(1);
    await expect(
      invoke("query.sql", { sql: "SELECT * FROM core_base_people" }, context(admin)),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("reconciler: atomic apply", () => {
  it("rolls back fully when a statement fails", async () => {
    const id = extId("atom");
    const p = await plan(
      manifest(id, {
        objects: { project: projectObject },
        fields: { organisation: { flag: { type: "boolean", label: "Flag" } } },
      }),
    );
    const viewsBefore = await columns("crm_organisations");
    const failing = {
      ...p,
      statements: [...p.statements, CompiledQuery.raw("SELECT * FROM no_such_table")],
    };
    await expect(applyPlan((s) => db.batch(s), failing)).rejects.toThrow();
    expect(await exists(`x_${id}_project`)).toBe(false);
    expect(await exists(`x_${id}_organisation`)).toBe(false);
    expect(await exists(`crm_x_${id}_project`)).toBe(false);
    expect(await columns("crm_organisations")).toEqual(viewsBefore);
    const state = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM core_extension_fields WHERE extension_id = ?",
    )
      .bind(id)
      .first<{ n: number }>();
    expect(state?.n).toBe(0);
    await refreshSchemaRegistry(db.query);
    await expect(
      invoke("record.list", { object: `${id}.project` }, context(admin)),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
