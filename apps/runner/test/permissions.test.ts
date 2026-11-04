// AC3 (stage 3a part): an extension cannot call an operation, or touch an object, outside its
// declared permissions, and its calls are audited as actor `extension`. ("Widening permissions
// creates a review" needs the approval queue: stage 3b.)
import { beforeAll, describe, expect, it } from "vitest";
import { auditFor, call, createAdmin, install, source, unique } from "./helpers.ts";

let admin: Awaited<ReturnType<typeof createAdmin>>;
const id = unique("perm").slice(0, 20);
let orgId: string;
let personId: string;

const tool = (name: string, body: string) => `
    ${name}: defineTool({
      description: "A test tool that calls the CRM in one specific way.",
      input: z.object({ id: z.string() }),
      output: z.unknown(),
      handler: async ({ id }, ctx) => { ${body} },
    }),`;

beforeAll(async () => {
  admin = await createAdmin();
  orgId = (await call<{ id: string }>(admin, "organisation.create", { name: unique("Perm Co") }))
    .id;
  personId = (await call<{ id: string }>(admin, "person.create", { givenName: "Pat" })).id;
  await install(
    admin,
    id,
    source(
      id,
      `permissions: { read: ["organisation"], modules: ["crm"] },
  objects: {
    note: { label: "Note", plural: "Notes", titleField: "title", fields: { title: { type: "text", label: "Title" } } },
  },
  fields: { organisation: { flag: { type: "boolean", label: "Flag" } } },
  tools: {
    ${tool("readOrg", `return (await ctx.crm.call<{ name: string }>("organisation.get", { id })).name;`)}
    ${tool("writeOrg", `return ctx.crm.call("record.update", { object: "organisation", id, values: { "${id}.flag": true } });`)}
    ${tool("readPerson", `return ctx.crm.call("person.get", { id });`)}
    ${tool("ownObject", `return (await ctx.crm.call<{ title: string }>("record.create", { object: "${id}.note", values: { title: id } })).title;`)}
    ${tool("adminOp", `return ctx.crm.call("extension.list", {});`)}
    ${tool("search", `return ctx.crm.call("search.global", { query: "x" });`)}
    ${tool("deleteOrg", `return ctx.crm.call("organisation.delete", { id });`)}
  },`,
    ),
  );
});

describe("declared permissions", () => {
  it("allows reading a declared object and using its own objects", async () => {
    const name = await call<string>(admin, `x.${id}.readOrg`, { id: orgId });
    expect(name).toMatch(/^Perm Co/);
    expect(await call(admin, `x.${id}.ownObject`, { id: "hello" })).toBe("hello");
  });

  for (const [toolName, operation, reason] of [
    ["writeOrg", "record.update", /may not write organisation/],
    ["readPerson", "person.get", /may not read person/],
    ["adminOp", "extension.list", /cannot call extension\.list/],
    ["search", "search.global", /not in permissions\.operations/],
    ["deleteOrg", "organisation.delete", /permissions\.operations/],
  ] as const) {
    it(`refuses ${operation} (${toolName}) and audits the refusal as actor extension`, async () => {
      // Refusals count as failures (three quarantine the extension); start each from zero.
      await call(admin, "extension.enable", { id });
      const target = toolName === "readPerson" ? personId : orgId;
      await expect(call(admin, `x.${id}.${toolName}`, { id: target })).rejects.toMatchObject({
        code: "extension_error",
        message: expect.stringMatching(reason),
        details: expect.objectContaining({ code: "forbidden" }),
      });
      const audits = await auditFor(operation, `extension:${id}`);
      expect(audits.at(-1)).toMatchObject({ actor: "extension", outcome: "forbidden" });
    });
  }

  it("audits allowed calls as actor extension with the extension's origin", async () => {
    const audits = await auditFor("record.create", `extension:${id}`);
    expect(audits.at(-1)).toMatchObject({ actor: "extension", outcome: "ok" });
    expect(JSON.parse(audits.at(-1)?.origin ?? "{}")).toEqual({
      surface: "extension",
      extensionId: id,
    });
  });

  it("refuses permissions that can never be granted at check time", async () => {
    const other = unique("bad").slice(0, 20);
    const result = await call<{ ok: boolean; issues: { stage: string; path: string }[] }>(
      admin,
      "extension.check",
      {
        id: other,
        files: source(other, `permissions: { operations: ["policy.update"], modules: ["crm"] },`),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ stage: "contract", path: "permissions.operations.0" }),
    );
  });

  it("only admins (humans) manage extensions", async () => {
    await expect(
      call({ ...admin, role: "member" }, "extension.install", {
        id: "nope",
        files: source("nope", ""),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
