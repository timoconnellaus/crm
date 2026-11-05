// The prompt file is valid: 10 prompts, unique ids, accepted types the CRM has, and a reference
// widget whose type is accepted. @relationship-os/core is loaded at runtime (vitest transforms its sources).
import { describe, expect, it } from "vitest";
import { loadCore } from "../lib/core.ts";
import { DESCRIBE_OPENING } from "../lib/harness.ts";
import { tasks } from "../prompts.ts";

const core = await loadCore();

describe("prompts", () => {
  it("has exactly 10 prompts with unique ids", () => {
    expect(tasks).toHaveLength(10);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(10);
  });

  it("accepts only real data widget types, and the reference answer's type", () => {
    for (const task of tasks) {
      expect(task.accept.length, task.id).toBeGreaterThan(0);
      for (const type of task.accept) {
        expect(core.WIDGET_TYPES, task.id).toContain(type);
        expect(type, task.id).not.toBe("markdown");
      }
      expect(task.accept, task.id).toContain(task.reference.type);
      expect(task.reference.id, task.id).toBe(task.id);
    }
  });

  it("covers the chart types from the stage 4a brief", () => {
    const accepted = new Set(tasks.flatMap((t) => t.accept));
    for (const type of ["kpi", "bar", "line", "donut", "funnel", "table", "leaderboard"]) {
      expect(accepted).toContain(type);
    }
  });

  it("reads only crm_* views in the reference SQL", () => {
    for (const task of tasks) {
      const views = [...String(task.reference.sql).matchAll(/\bfrom\s+(\w+)/gi)].map((m) => m[1]);
      expect(views.length, task.id).toBeGreaterThan(0);
      for (const view of views) expect(view, task.id).toMatch(/^crm_/);
    }
  });

  it("relies on describePrompt opening with the line agent mode replaces", () => {
    const [system, user] = core.describePrompt("Tasks by status", []);
    expect(system?.role).toBe("system");
    expect(system?.content.startsWith(DESCRIBE_OPENING)).toBe(true);
    expect(user).toEqual({ role: "user", content: "Tasks by status" });
  });
});
