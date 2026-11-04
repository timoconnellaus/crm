// The reviewer's view of an extension proposal (ADR 0041): the per-file diff and the host-computed
// impact, including permissions widened over the installed version (AC3).
import { type ExtensionManifest, manifestSchema } from "@crm/sdk";
import { describe, expect, it } from "vitest";
import {
  computeImpact,
  diffFiles,
  summaryPrompt,
  unifiedDiff,
} from "../src/extensions/proposal.ts";

function manifest(overrides: Record<string, unknown> = {}): ExtensionManifest {
  return manifestSchema.parse({
    id: "proj",
    version: "1.0.0",
    contractVersion: 1,
    permissions: { read: ["organisation"], write: [], operations: [], modules: ["crm"] },
    objects: {},
    fields: {},
    views: {},
    tools: {},
    automations: {},
    ...overrides,
  });
}

describe("diffFiles", () => {
  it("diffs added, modified and deleted files with hunks and line numbers", () => {
    const before = { "a.ts": "one\ntwo\nthree\n", "gone.ts": "x\n", "same.ts": "s\n" };
    const after = { "a.ts": "one\nTWO\nthree\nfour\n", "new.ts": "n\n", "same.ts": "s\n" };
    const diff = diffFiles(before, after);
    expect(diff.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ["a.ts", "modified", 2, 1],
      ["gone.ts", "deleted", 0, 1],
      ["new.ts", "added", 1, 0],
    ]);
    const lines = diff[0]?.hunks[0]?.lines ?? [];
    expect(lines.map((l) => `${l.op}${l.text}`)).toEqual([
      " one",
      "-two",
      "+TWO",
      " three",
      "+four",
    ]);
    expect(lines[2]).toMatchObject({ new: 2 });
    expect(lines[1]).toMatchObject({ old: 2 });
    expect(unifiedDiff(diff)).toContain("@@ -1,3 +1,4 @@");
  });

  it("treats a missing base as all additions, and splits distant changes into hunks", () => {
    expect(diffFiles(null, { "index.ts": "a\nb\n" })[0]).toMatchObject({
      status: "added",
      additions: 2,
    });
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const changed = [...long];
    changed[2] = "changed 2";
    changed[35] = "changed 35";
    const [file] = diffFiles({ f: long.join("\n") }, { f: changed.join("\n") });
    expect(file?.hunks).toHaveLength(2);
  });
});

describe("computeImpact", () => {
  it("lists schema changes and every permission as widened on a new install", () => {
    const m = manifest();
    const impact = computeImpact({
      manifest: m,
      previous: null,
      changes: [
        { kind: "create_object", object: "proj.project" },
        { kind: "add_field", object: "proj.project", field: "budget" },
      ],
      diff: diffFiles(null, { "index.ts": "x\n" }),
    });
    expect(impact).toMatchObject({
      kind: "install",
      risks: ["extension", "schema"],
      schema: { newObjects: ["proj.project"], newFields: ["proj.project.budget"] },
      permissions: { widens: false, widened: { read: ["organisation"] } },
      modules: ["crm"],
      files: { changed: 1, additions: 1 },
    });
  });

  it("flags permissions widened over the installed version (AC3)", () => {
    const previous = manifest();
    const next = manifest({
      version: "1.1.0",
      permissions: {
        read: ["organisation"],
        write: ["person"],
        operations: ["task.create"],
        modules: ["crm", "ai"],
      },
      automations: {},
    });
    const impact = computeImpact({ manifest: next, previous, changes: [], diff: [] });
    expect(impact.kind).toBe("upgrade");
    expect(impact.risks).toEqual(["extension"]);
    expect(impact.permissions.widens).toBe(true);
    expect(impact.permissions.widened).toEqual({
      read: [],
      write: ["person"],
      operations: ["task.create"],
      modules: ["ai"],
    });
    expect(impact.warnings).toContain("Asks for permissions beyond the installed version.");
    const prompt = summaryPrompt(impact, []);
    expect(prompt).toContain('"widened"');
    expect(prompt).toContain("untrusted");
  });

  it("warns about ejecting and hiding", () => {
    const impact = computeImpact({
      manifest: manifest(),
      previous: manifest(),
      changes: [{ kind: "hide_field", object: "organisation", field: "tier" }],
      diff: [],
      eject: true,
    });
    expect(impact.kind).toBe("eject");
    expect(impact.schema.hidden).toEqual(["organisation.tier"]);
    expect(impact.warnings.join(" ")).toMatch(/upstream updates/);
    expect(impact.warnings.join(" ")).toMatch(/30 days/);
  });
});
