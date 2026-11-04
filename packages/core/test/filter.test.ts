// Filter JSON → parameterised SQL: validation, injection resistance, and real queries on D1.
import { env } from "cloudflare:workers";
import { sql } from "kysely";
import { beforeAll, describe, expect, it } from "vitest";
import {
  compileFilter,
  FILTER_LIMITS,
  type Filter,
  invoke,
  personObject,
  ValidationError,
} from "../src/index.ts";
import { context, createUser, db, unique } from "./helpers.ts";

function compiled(filter: Filter) {
  return db.query
    .selectFrom("crm_people")
    .select("id")
    .where(compileFilter(personObject, filter))
    .compile();
}

describe("compileFilter: validation", () => {
  const rejects = (filter: unknown, pattern: RegExp) => {
    expect(() => compileFilter(personObject, filter as Filter)).toThrow(ValidationError);
    expect(() => compileFilter(personObject, filter as Filter)).toThrow(pattern);
  };

  it("rejects unknown fields", () => {
    rejects({ field: "password", op: "eq", value: "x" }, /unknown field "password"/);
  });

  it("rejects non-filterable fields", () => {
    rejects({ field: "description", op: "contains", value: "x" }, /not filterable/);
  });

  it("rejects unsupported ops for the field type", () => {
    rejects({ field: "createdAt", op: "contains", value: "2026" }, /not supported/);
    rejects({ field: "ownerId", op: "gt", value: "usr_1" }, /not supported/);
    rejects({ field: "emails", op: "gt", value: "a" }, /not supported/);
  });

  it("rejects unknown ops and malformed structure", () => {
    rejects({ field: "displayName", op: "regexp", value: "x" }, /Invalid filter/);
    rejects({ and: [{ field: "displayName" }] }, /Invalid filter/);
    rejects({ and: [], or: [] }, /Invalid filter/);
    rejects({ field: "displayName", op: "eq", value: "x", extra: 1 }, /Invalid filter/);
  });

  it("rejects values of the wrong type", () => {
    rejects({ field: "displayName", op: "eq", value: 5 }, /needs a string/);
    rejects({ field: "createdAt", op: "gt", value: "yesterday" }, /ISO-8601/);
    rejects({ field: "displayName", op: "in", value: [] }, /non-empty array/);
    rejects({ field: "displayName", op: "in", value: "x" }, /non-empty array/);
    rejects({ field: "createdAt", op: "between", value: ["2026-01-01"] }, /between/);
    rejects({ field: "displayName", op: "eq" }, /needs a value/);
  });

  it("enforces size limits", () => {
    let deep: Filter = { field: "displayName", op: "eq", value: "x" };
    for (let i = 0; i < FILTER_LIMITS.maxDepth + 1; i++) deep = { and: [deep] };
    rejects(deep, /nested too deeply/);

    const many = Array.from({ length: 60 }, () => ({ field: "displayName", op: "eq", value: "x" }));
    rejects({ or: [{ and: many }, { and: many }] }, /too many conditions/);

    rejects(
      { field: "displayName", op: "in", value: Array.from({ length: 501 }, (_, i) => `v${i}`) },
      /too many values/,
    );
  });
});

describe("compileFilter: SQL", () => {
  it("binds every value as a parameter", () => {
    const evil = "x'); DROP TABLE core_person; --";
    const { sql: text, parameters } = compiled({
      or: [
        { field: "displayName", op: "eq", value: evil },
        { field: "emails", op: "contains", value: evil },
        { field: "tags", op: "in", value: [evil, "b"] },
      ],
    });
    expect(text).not.toContain("DROP TABLE");
    expect(parameters).toContain(evil);
    expect(parameters.filter((p) => String(p).includes("DROP TABLE"))).toHaveLength(3);
  });

  it("only uses registry identifiers", () => {
    const { sql: text } = compiled({ field: "displayName", op: "eq", value: "x" });
    expect(text).toContain('"crm_people"."display_name"');
  });

  it("escapes LIKE wildcards", () => {
    const { parameters } = compiled({ field: "displayName", op: "contains", value: "50%_off\\" });
    expect(parameters).toEqual(["%50\\%\\_off\\\\%"]);
  });
});

describe("compileFilter on D1", () => {
  const tag = unique("tag");
  let org = "";
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const user = await createUser("admin");
    const ctx = context(user);
    const make = async (key: string, input: Parameters<typeof invoke<"person.create">>[1]) => {
      ids[key] = (await invoke("person.create", input, ctx)).id;
    };
    org = unique("Org");
    await make("ada", {
      givenName: "Ada",
      familyName: "Lovelace",
      emails: [{ email: `${unique("ada")}@analytical.example` }],
      location: "London",
      tags: [tag],
    });
    await make("grace", {
      givenName: "Grace",
      familyName: "Hopper",
      emails: [{ email: `${unique("grace")}@navy.example` }],
      tags: [tag, "Admiral"],
    });
    await make("alan", { givenName: "Alan", familyName: "Turing", location: "Manchester" });
    // Give Alan an organisation through a primary affiliation, so the view's organisation_name is set.
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO core_organisation (id, name, created_at, updated_at) VALUES ('org_f1', ?, ?, ?)",
      ).bind(org, now, now),
      env.DB.prepare(
        "INSERT INTO core_affiliation (id, person_id, organisation_id, title, is_primary, created_at, updated_at) VALUES ('aff_f1', ?, 'org_f1', 'Mathematician', 1, ?, ?)",
      ).bind(ids.alan, now, now),
    ]);
  });

  async function matching(filter: Filter): Promise<string[]> {
    const scoped: Filter = {
      and: [{ field: "id", op: "in", value: Object.values(ids) }, filter],
    };
    const rows = await db.query
      .selectFrom("crm_people")
      .select("id")
      .where(compileFilter(personObject, scoped))
      .orderBy(sql`display_name`)
      .execute();
    const byId = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]));
    return rows.map((r) => byId[r.id] ?? r.id);
  }

  it("eq is case-insensitive for text", async () => {
    expect(await matching({ field: "givenName", op: "eq", value: "ada" })).toEqual(["ada"]);
  });

  it("neq includes nulls", async () => {
    expect(await matching({ field: "location", op: "neq", value: "London" })).toEqual([
      "alan",
      "grace",
    ]);
  });

  it("contains, starts_with and ends_with", async () => {
    expect(await matching({ field: "familyName", op: "contains", value: "OPP" })).toEqual([
      "grace",
    ]);
    expect(await matching({ field: "familyName", op: "starts_with", value: "tur" })).toEqual([
      "alan",
    ]);
    expect(await matching({ field: "familyName", op: "ends_with", value: "lace" })).toEqual([
      "ada",
    ]);
  });

  it("is_null / is_not_null", async () => {
    expect(await matching({ field: "location", op: "is_null" })).toEqual(["grace"]);
    expect(await matching({ field: "primaryEmail", op: "is_not_null" })).toEqual(["ada", "grace"]);
  });

  it("matches multi-valued fields by any value", async () => {
    expect(await matching({ field: "emails", op: "ends_with", value: "@navy.example" })).toEqual([
      "grace",
    ]);
    expect(await matching({ field: "tags", op: "eq", value: tag.toUpperCase() })).toEqual([
      "ada",
      "grace",
    ]);
    expect(await matching({ field: "tags", op: "neq", value: "Admiral" })).toEqual(["ada", "alan"]);
    expect(await matching({ field: "tags", op: "is_null" })).toEqual(["alan"]);
  });

  it("combines and/or groups", async () => {
    expect(
      await matching({
        or: [
          { field: "location", op: "eq", value: "London" },
          {
            and: [
              { field: "tags", op: "eq", value: "admiral" },
              { field: "givenName", op: "eq", value: "grace" },
            ],
          },
        ],
      }),
    ).toEqual(["ada", "grace"]);
    expect(await matching({ or: [] })).toEqual([]);
    expect(await matching({ and: [] })).toHaveLength(3);
  });

  it("filters on derived view columns", async () => {
    expect(await matching({ field: "organisationName", op: "eq", value: org })).toEqual(["alan"]);
    expect(await matching({ field: "jobTitle", op: "contains", value: "math" })).toEqual(["alan"]);
  });

  it("treats injection attempts as plain values", async () => {
    expect(await matching({ field: "givenName", op: "eq", value: "x' OR '1'='1" })).toEqual([]);
    expect(await matching({ field: "givenName", op: "contains", value: "%" })).toEqual([]);
    const people = await env.DB.prepare("SELECT COUNT(*) AS n FROM core_person").first<{
      n: number;
    }>();
    expect(people?.n).toBeGreaterThanOrEqual(3);
  });
});
