// AC2: formula fields compile to SQLite in the crm_* views, so they filter and sort in lists, and
// check reports their errors. Grammar and type rules are unit-tested in packages/sdk.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, invoke } from "../src/index.ts";
import { check, extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser } from "./helpers.ts";

let admin: ActingUser;
const id = extId("fx");
const object = `${id}.deal`;

beforeAll(async () => {
  admin = await createUser("admin");
  await reconcile(
    manifest(id, {
      objects: {
        deal: {
          label: "Deal",
          plural: "Deals",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name" },
            budget: { type: "currency", label: "Budget" },
            spent: { type: "currency", label: "Spent" },
            closesOn: { type: "date", label: "Closes" },
            won: { type: "boolean", label: "Won" },
            remaining: {
              type: "formula",
              label: "Remaining",
              expression: "coalesce(budget, 0) - coalesce(spent, 0)",
            },
            ratio: { type: "formula", label: "Ratio", expression: "round(spent / budget, 2)" },
            band: {
              type: "formula",
              label: "Band",
              expression: "if(remaining > 500, 'healthy', if(remaining > 0, 'tight', 'over'))",
            },
            label: {
              type: "formula",
              label: "Label",
              expression: 'upper(name) & " — it\'s " & band',
            },
            followUp: {
              type: "formula",
              label: "Follow up",
              expression: "dateAdd(closesOn, 2, 'week')",
            },
            daysOpen: {
              type: "formula",
              label: "Days",
              expression: "dateDiff(closesOn, '2026-03-01', 'day')",
            },
            isWon: { type: "formula", label: "Is won", expression: "coalesce(won, false)" },
          },
        },
      },
    }),
  );
  for (const [name, budget, spent, won] of [
    ["alpha", 1000, 100, true],
    ["beta", 1000, 900, false],
    ["gamma", 200, 300, null],
  ] as const) {
    await invoke(
      "record.create",
      { object, values: { name, budget, spent, closesOn: "2026-02-01", won } },
      context(admin),
    );
  }
});

describe("formula fields in views", () => {
  it("computes values, including nested formulas, text, dates and booleans", async () => {
    const page = await invoke("record.list", { object, sort: { field: "name" } }, context(admin));
    const alpha = page.items.find((r) => r.title === "alpha");
    expect(alpha?.values).toMatchObject({
      remaining: 900,
      ratio: 0.1,
      band: "healthy",
      label: "ALPHA — it's healthy",
      followUp: "2026-02-15",
      daysOpen: 28,
      isWon: true,
    });
    const gamma = page.items.find((r) => r.title === "gamma");
    expect(gamma?.values).toMatchObject({ remaining: -100, band: "over", isWon: false });
  });

  it("filters and sorts lists by formula fields", async () => {
    const filtered = await invoke(
      "record.list",
      {
        object,
        filter: { field: "remaining", op: "gt", value: 0 },
        sort: { field: "remaining", direction: "desc" },
      },
      context(admin),
    );
    expect(filtered.items.map((r) => r.title)).toEqual(["alpha", "beta"]);
    const byBand = await invoke(
      "record.list",
      { object, filter: { field: "band", op: "eq", value: "over" } },
      context(admin),
    );
    expect(byBand.items.map((r) => r.title)).toEqual(["gamma"]);
    const won = await invoke(
      "record.list",
      { object, filter: { field: "isWon", op: "eq", value: true } },
      context(admin),
    );
    expect(won.items.map((r) => r.title)).toEqual(["alpha"]);
  });

  it("cannot be written", async () => {
    await expect(
      invoke("record.create", { object, values: { name: "x", remaining: 1 } }, context(admin)),
    ).rejects.toMatchObject({ code: "invalid_input", message: /computed/ });
  });

  it("is exposed with its expression and result type in schema.objects", async () => {
    const { objects } = await invoke("schema.objects", { object }, context(admin));
    const remaining = objects[0]?.fields.find((f) => f.name === "remaining");
    expect(remaining).toMatchObject({
      fieldType: "formula",
      readOnly: true,
      type: "number",
      options: { expression: "coalesce(budget, 0) - coalesce(spent, 0)", resultType: "number" },
    });
  });

  it("keeps string literals inert in the generated view", async () => {
    const sql = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE name = ?")
      .bind(`crm_x_${id}_deal`)
      .first<{ sql: string }>();
    expect(sql?.sql).toContain("' — it''s '");
  });
});

describe("formula checks", () => {
  const withFormula = (expression: string) =>
    manifest(extId("fc"), {
      fields: { organisation: { f: { type: "formula", label: "F", expression } } },
    });

  it("reports type errors with path and span", async () => {
    const result = await check(withFormula("name + 1"));
    expect(result.issues).toEqual([
      expect.objectContaining({
        stage: "formula",
        code: "formula_type",
        path: "fields.organisation.f.expression",
        span: expect.objectContaining({ start: 0 }),
      }),
    ]);
  });

  it("can read core fields of the object it extends", async () => {
    const result = await check(withFormula("length(name) + currentPeopleCount"));
    expect(result.issues).toEqual([]);
    expect(result.plan?.changes).toContainEqual(expect.objectContaining({ kind: "add_field" }));
  });

  it("rejects injection-like input before it reaches SQL", async () => {
    for (const expression of [
      "name); DROP TABLE core_user; --",
      "name' || (SELECT password FROM core_account) || '",
      "(SELECT 1)",
      "name -- ",
    ]) {
      const result = await check(withFormula(expression));
      expect(result.issues.length, expression).toBeGreaterThan(0);
      expect(result.plan).toBeNull();
    }
  });
});
