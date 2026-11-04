// The in-Worker type check of extension source (src/extensions/typecheck.ts), run in workerd.
import { describe, expect, it } from "vitest";
import { MAX_TYPE_ISSUES, typecheckExtension } from "../src/extensions/typecheck.ts";
import { SHIPPED_EXTENSIONS } from "../src/generated/shipped.ts";

const example = SHIPPED_EXTENSIONS.find((e) => e.id === "example");
if (!example) throw new Error("the example extension is not bundled");
const files = example.files;

/** workerd's clock only moves across I/O, so a timer tick before and after brackets the call. */
async function timed<T>(run: () => T): Promise<[T, number]> {
  await scheduler.wait(1);
  const start = Date.now();
  const result = run();
  await scheduler.wait(1);
  return [result, Date.now() - start - 1];
}

describe("typecheckExtension", () => {
  it("checks the example extension clean, cold and warm", async () => {
    const [cold, coldMs] = await timed(() => typecheckExtension(files));
    expect(cold).toEqual([]);
    const warm: number[] = [];
    for (let i = 0; i < 3; i++) {
      const [issues, ms] = await timed(() => typecheckExtension(files));
      expect(issues).toEqual([]);
      warm.push(ms);
    }
    console.log(
      `typecheck example: cold ${coldMs.toFixed(0)} ms, warm ${warm.map((ms) => ms.toFixed(0)).join(" / ")} ms`,
    );
  });

  it("reports a wrong manifest value in index.ts", () => {
    const issues = typecheckExtension({
      ...files,
      "index.ts": (files["index.ts"] as string).replace('titleField: "name"', "titleField: 123"),
    });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toMatchObject({ code: "type", path: "index.ts" });
    expect(issues[0]?.message).toMatch(/^\d+:\d+ .*\(TS\d+\)$/s);
  });

  it("reports a non-existent ctx module and a handler returning the wrong shape", () => {
    const tools = (files["tools.ts"] as string)
      .replace("await ctx.crm.call(", "await ctx.crm.cal(")
      .replace("return { organisationId, tier };", "return { organisationId: 1, tier };");
    const issues = typecheckExtension({ ...files, "tools.ts": tools });
    expect(issues.every((i) => i.code === "type" && i.path === "tools.ts")).toBe(true);
    expect(issues.map((i) => i.message).join("\n")).toMatch(
      /Property 'cal' does not exist on type 'CrmModule'/,
    );
    expect(issues.some((i) => /organisationId/.test(i.message))).toBe(true);
  });

  it("resolves own files with or without an extension, and reports unknown imports", () => {
    expect(
      typecheckExtension({
        "index.ts":
          'import { a } from "./lib";\nimport { b } from "./util.js";\nexport const c: number = a + b;',
        "lib.ts": "export const a = 1;",
        "util.ts": "export const b = 2;",
      }),
    ).toEqual([]);
    const issues = typecheckExtension({
      "index.ts": 'import { x } from "node:fs";\nexport { x };',
    });
    expect(issues[0]).toMatchObject({ code: "type", path: "index.ts" });
    expect(issues[0]?.message).toMatch(/'node:fs'/);
  });

  it("checks against ES2022 without DOM", () => {
    expect(
      typecheckExtension({
        "index.ts": "export const n: number = [1, 2].at(-1) ?? Object.hasOwn({}, 'a') ? 1 : 0;",
      }),
    ).toEqual([]);
    const issues = typecheckExtension({ "index.ts": "export const t = document.title;" });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/Cannot find name 'document'/);
  });

  it("reports syntax errors as type issues too", () => {
    const issues = typecheckExtension({ "lib/a.ts": "export const = 1;", "index.ts": "" });
    expect(issues[0]).toMatchObject({ code: "type", path: "lib/a.ts" });
  });

  it("caps the number of issues", () => {
    const body = Array.from({ length: 80 }, (_, i) => `export const v${i}: string = ${i};`).join(
      "\n",
    );
    expect(typecheckExtension({ "index.ts": body })).toHaveLength(MAX_TYPE_ISSUES);
  });
});
