// The cases are well formed, and each reference answer declares what its case expects: the trigger
// type, the writes (object and count), the notifications and the waits. So a model that does what
// the reference does passes the test-mode grade, and the expectations are not self-contradictory.
import { describe, expect, it } from "vitest";
import { REFERENCES, referenceSource } from "../lib/reference.ts";
import { cases, extensionIdFor, promptText } from "../prompts.ts";

describe("cases", () => {
  it("has 10 cases with unique ids and id bases, covering every trigger type", () => {
    expect(cases).toHaveLength(10);
    expect(new Set(cases.map((c) => c.id)).size).toBe(10);
    expect(new Set(cases.map((c) => c.idBase)).size).toBe(10);
    for (const c of cases) expect(c.idBase).toMatch(/^[a-z][a-z0-9]{1,20}$/);
    expect(new Set(cases.flatMap((c) => c.triggers))).toEqual(
      new Set(["record", "fieldChanged", "schedule", "dateRelative", "manual", "approvalDecided"]),
    );
  });

  it("asks for an id and a proposal", () => {
    const c = cases[0];
    if (!c) throw new Error("no cases");
    const id = extensionIdFor(c, "Varodin");
    expect(id).toBe(`${c.idBase}varodin`);
    expect(promptText(c, id)).toContain(`extension whose id is \`${id}\``);
    expect(promptText(c, id)).toMatch(/propose it/);
  });

  it("has keyword groups the case's own intent satisfies", () => {
    for (const c of cases) {
      for (const group of c.keywords) {
        expect(
          group.some((p) => p.test(c.intent)),
          `${c.id}: ${group.map(String).join(" | ")}`,
        ).toBe(true);
      }
    }
  });

  it.each(cases.map((c) => [c.id, c] as const))(
    "%s: the reference declares what is expected",
    (_, c) => {
      const ref = REFERENCES[c.id];
      if (!ref) throw new Error(`no reference for ${c.id}`);
      expect(c.triggers).toContain(ref.trigger.type);
      const writes: Record<string, number> = {};
      let notifications = 0;
      let waits = 0;
      for (const step of ref.steps) {
        const s = step as {
          kind?: string;
          writes?: { object: string; count?: number }[];
          notifies?: unknown[];
        };
        if (s.kind === "sleep" || s.kind === "waitForEvent") waits += 1;
        for (const w of s.writes ?? []) writes[w.object] = (writes[w.object] ?? 0) + (w.count ?? 1);
        notifications += s.notifies?.length ?? 0;
        expect((step as { name: string }).name).toMatch(/^[a-z][a-zA-Z0-9]*$/);
      }
      expect(writes).toEqual(c.expect.writes);
      expect(notifications).toBe(c.expect.notifications);
      expect(waits).toBe(c.expect.waits);
      if (notifications > 0) expect(ref.permissions.operations).toContain("notification.send");
      if (Object.keys(writes).length) expect(ref.permissions.write).toEqual(Object.keys(writes));

      const source = referenceSource(c, `${c.idBase}abc`);
      expect(source).toContain(`id: "${c.idBase}abc"`);
      expect(source).toContain("defineAutomation({");
      // Every step the run handler uses is declared.
      for (const [, name] of source.matchAll(/step\.(?:do|sleep)\("([a-zA-Z0-9]+)"/g)) {
        expect(ref.steps.map((s) => (s as { name: string }).name)).toContain(name);
      }
    },
  );
});
