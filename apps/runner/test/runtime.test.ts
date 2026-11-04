// AC4: the runtime. No network, only declared host modules, quarantine after 3 consecutive
// failures, rollback to last-known-good; and extension.check's structured errors.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { call, createAdmin, extensionRow, host, install, source, unique } from "./helpers.ts";

let admin: Awaited<ReturnType<typeof createAdmin>>;
beforeAll(async () => {
  admin = await createAdmin();
});

const newId = (prefix: string) => unique(prefix).slice(0, 24);

const tool = (name: string, body: string, input = "z.object({})") => `
    ${name}: defineTool({
      description: "A test tool for the runtime acceptance tests.",
      input: ${input},
      output: z.unknown(),
      handler: async (input, ctx) => { ${body} },
    }),`;

type Check = {
  ok: boolean;
  issues: { stage: string; code: string; path: string; message: string; suggestion?: string }[];
  plan: { ddl: string[]; changes: { kind: string }[] } | null;
};

describe("sandbox", () => {
  it("has no network access", async () => {
    const id = newId("net");
    await install(
      admin,
      id,
      source(
        id,
        `tools: { ${tool("fetchIt", `return (await (globalThis as unknown as { fetch: (u: string) => Promise<{ status: number }> }).fetch("https://example.com")).status;`)} },`,
      ),
    );
    await expect(call(admin, `x.${id}.fetchIt`, {})).rejects.toMatchObject({
      code: "extension_error",
      message: expect.stringMatching(/not permitted to access the internet|fetch/i),
    });
  });

  it("refuses importing host modules, node: modules and other packages at check time", async () => {
    const id = newId("imp");
    for (const [specifier, pattern] of [
      ["codemode:crm", /do not import host modules/],
      ["node:fs/promises", /may import only @crm\/sdk/],
      ["zod", /may import only @crm\/sdk/],
    ] as const) {
      const files = source(id, "", "1.0.0", `import * as m from "${specifier}"; void m;`);
      const result = await call<Check>(admin, "extension.check", { id, files });
      expect(result.ok).toBe(false);
      expect(result.issues).toEqual([
        expect.objectContaining({
          stage: "typecheck",
          code: "import",
          path: "index.ts",
          message: expect.stringMatching(pattern),
        }),
      ]);
    }
    const dynamic = source(
      id,
      `tools: { ${tool("x", `return import(/* hidden */ "node:fs");`)} },`,
    );
    const result = await call<Check>(admin, "extension.check", { id, files: dynamic });
    expect(result.issues).toContainEqual(
      expect.objectContaining({ message: expect.stringMatching(/Dynamic import/) }),
    );
  });

  it("only gives tools the host modules they declared", async () => {
    const id = newId("mod");
    await install(
      admin,
      id,
      source(
        id,
        `permissions: { modules: ["log"] },
  tools: {
    ${tool("useAi", `return ctx.ai.summarise("hello");`)}
    ${tool("useStorage", `await ctx.storage.set("k", 1); return 1;`)}
    ${tool("useLog", `ctx.log.info("hi"); return "logged";`)}
  },`,
      ),
    );
    await expect(call(admin, `x.${id}.useAi`, {})).rejects.toMatchObject({
      message: expect.stringMatching(/Host module "ai" is not declared/),
    });
    await call(admin, "extension.enable", { id });
    await expect(call(admin, `x.${id}.useStorage`, {})).rejects.toMatchObject({
      message: expect.stringMatching(/Host module "storage" is not declared/),
    });
    await call(admin, "extension.enable", { id });
    expect(await call(admin, `x.${id}.useLog`, {})).toBe("logged");
  });

  it("fails codemode:ai gracefully when no AI is configured", async () => {
    const id = newId("ai");
    await install(
      admin,
      id,
      source(
        id,
        `permissions: { modules: ["ai"] }, tools: { ${tool("sum", `return ctx.ai.summarise("text");`)} },`,
      ),
    );
    await expect(call(admin, `x.${id}.sum`, {})).rejects.toMatchObject({
      code: "extension_error",
      message: expect.stringMatching(/AI is not configured/),
    });
  });
});

describe("failures and quarantine", () => {
  it("quarantines after 3 consecutive failures; caller errors do not count", async () => {
    const id = newId("q");
    await install(
      admin,
      id,
      source(
        id,
        `tools: { ${tool("boom", `if (input.fail) throw new Error("kaboom"); return "fine";`, "z.object({ fail: z.boolean() })")} },`,
      ),
    );
    // A bad input is the caller's error.
    await expect(call(admin, `x.${id}.boom`, { fail: "yes" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(call(admin, `x.${id}.boom`, { fail: true })).rejects.toMatchObject({
      message: "kaboom",
    });
    await expect(call(admin, `x.${id}.boom`, { fail: true })).rejects.toMatchObject({
      message: "kaboom",
    });
    // A success resets the counter.
    expect(await call(admin, `x.${id}.boom`, { fail: false })).toBe("fine");
    expect((await extensionRow(id)).failure_count).toBe(0);
    for (let i = 0; i < 2; i++) {
      await expect(call(admin, `x.${id}.boom`, { fail: true })).rejects.toMatchObject({
        details: expect.objectContaining({ quarantined: false }),
      });
    }
    await expect(call(admin, `x.${id}.boom`, { fail: true })).rejects.toMatchObject({
      details: expect.objectContaining({ quarantined: true }),
    });
    const row = await extensionRow(id);
    expect(row).toMatchObject({ status: "quarantined", failure_count: 3 });
    expect(row.status_reason).toMatch(/3 consecutive failed runs.*kaboom/);
    // Quarantined: disabled.
    await expect(call(admin, `x.${id}.boom`, { fail: false })).rejects.toMatchObject({
      code: "forbidden",
    });
    // Every run is in the history.
    const runs = await env.DB.prepare(
      "SELECT outcome FROM core_extension_runs WHERE extension_id = ? AND kind = 'tool' ORDER BY started_at, id",
    )
      .bind(id)
      .all<{ outcome: string }>();
    // (The bad input was refused by the operation's schema before any run.)
    expect(runs.results.map((r) => r.outcome)).toEqual([
      "error",
      "error",
      "ok",
      "error",
      "error",
      "error",
    ]);
  });
});

describe("versions and rollback", () => {
  it("rolls back to the last-known-good version with data intact", async () => {
    const id = newId("rb");
    const v1 = await install(
      admin,
      id,
      source(
        id,
        `objects: { item: { label: "Item", plural: "Items", titleField: "name", fields: { name: { type: "text", label: "Name" } } } },
  permissions: { modules: ["crm"] },
  tools: { ${tool("count", `return (await ctx.crm.call<{ items: unknown[] }>("record.list", { object: "${id}.item" })).items.length;`)} },`,
      ),
    );
    const item = await call<{ id: string }>(admin, "record.create", {
      object: `${id}.item`,
      values: { name: "kept" },
    });
    expect(await call(admin, `x.${id}.count`, {})).toBe(1);
    expect((await extensionRow(id)).last_good_commit).toBe(v1.commit);

    // v2 adds a field and breaks the tool.
    const v2 = await install(
      admin,
      id,
      source(
        id,
        `objects: { item: { label: "Item", plural: "Items", titleField: "name", fields: { name: { type: "text", label: "Name" }, size: { type: "number", label: "Size" } } } },
  permissions: { modules: ["crm"] },
  tools: { ${tool("count", `throw new Error("v2 is broken");`)} },`,
        "2.0.0",
      ),
    );
    expect(v2.commit).not.toBe(v1.commit);
    await call(admin, "record.update", { object: `${id}.item`, id: item.id, values: { size: 3 } });
    for (let i = 0; i < 3; i++) await call(admin, `x.${id}.count`, {}).catch(() => undefined);
    const quarantined = await call<{
      status: string;
      lastGoodCommit: string;
      versions: { commit: string }[];
    }>(admin, "extension.get", { id });
    expect(quarantined.status).toBe("quarantined");
    expect(quarantined.lastGoodCommit).toBe(v1.commit);
    expect(quarantined.versions.map((v) => v.commit)).toEqual([v2.commit, v1.commit]);
    expect((await host.versions(id)).map((v) => v.commit)).toEqual([v2.commit, v1.commit]);

    const rolled = await call<{ version: string; changes: { kind: string; field?: string }[] }>(
      admin,
      "extension.rollback",
      { id, commit: quarantined.lastGoodCommit },
    );
    expect(rolled.version).toBe("1.0.0");
    expect(rolled.changes).toContainEqual(
      expect.objectContaining({ kind: "hide_field", field: "size" }),
    );
    const row = await extensionRow(id);
    expect(row).toMatchObject({
      status: "active",
      commit_oid: v1.commit,
      version: "1.0.0",
      failure_count: 0,
    });
    expect(await call(admin, `x.${id}.count`, {})).toBe(1);
    const got = await call<{ values: Record<string, unknown> }>(admin, "record.get", {
      object: `${id}.item`,
      id: item.id,
    });
    expect(got.values).toEqual({ name: "kept" });
    // v2's data is hidden, not lost.
    const stored = await env.DB.prepare(`SELECT size FROM x_${id}_item WHERE id = ?`)
      .bind(item.id)
      .first<{ size: number }>();
    expect(stored?.size).toBe(3);
    // Only installed versions can be rolled back to.
    await expect(
      call(admin, "extension.rollback", { id, commit: "0000000000" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("extension.check", () => {
  it("reports syntax, contract, formula and reconcile problems as structured issues", async () => {
    const id = newId("chk");
    const syntax = await call<Check>(admin, "extension.check", {
      id,
      files: { "index.ts": "export default defineExtension({ id: " },
    });
    expect(syntax.issues).toEqual([
      expect.objectContaining({ stage: "typecheck", code: "syntax", path: "index.ts" }),
    ]);

    const contract = await call<Check>(admin, "extension.check", {
      id,
      files: source(
        id,
        `objects: { person: { label: "P", plural: "Ps", titleField: "nope", fields: {} } },`,
      ),
    });
    expect(contract.issues.map((i) => [i.stage, i.path])).toEqual([
      ["contract", "objects.person"],
      ["contract", "objects.person.titleField"],
    ]);

    const formula = await call<Check>(admin, "extension.check", {
      id,
      files: source(
        id,
        `fields: { organisation: { f: { type: "formula", label: "F", expression: "name * 2" } } },`,
      ),
    });
    expect(formula.issues).toEqual([
      expect.objectContaining({
        stage: "formula",
        code: "formula_type",
        path: "fields.organisation.f.expression",
      }),
    ]);

    const ok = await call<Check>(admin, "extension.check", {
      id,
      files: source(id, `fields: { organisation: { code: { type: "text", label: "Code" } } },`),
    });
    expect(ok.ok).toBe(true);
    expect(ok.plan?.ddl).toContain(`ALTER TABLE x_${id}_organisation ADD COLUMN code TEXT`);
    // check changes nothing.
    const table = await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE name = ?")
      .bind(`x_${id}_organisation`)
      .first();
    expect(table).toBeNull();

    await install(
      admin,
      id,
      source(id, `fields: { organisation: { code: { type: "text", label: "Code" } } },`),
    );
    const lossy = await call<Check>(admin, "extension.check", {
      id,
      files: source(id, `fields: { organisation: { code: { type: "boolean", label: "Code" } } },`),
    });
    expect(lossy.issues).toEqual([
      expect.objectContaining({
        stage: "reconcile",
        code: "lossy_type_change",
        suggestion: expect.any(String),
      }),
    ]);
  });
});
