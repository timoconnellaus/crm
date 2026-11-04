// The task file is valid: 20 tasks, unique ids, and every tool or operation a task names exists.
// Tool names come from the operations registry the MCP server is generated from (curated
// operations become tools, `.` → `_`), plus the two meta tools.
import { describe, expect, it } from "vitest";
import type { ToolExpectation } from "../lib/grading.ts";
import type { SetupContext } from "../lib/harness.ts";
import { tasks } from "../tasks.ts";

// @crm/core is imported by a non-literal specifier so tsc does not type-check its Workers-typed
// sources under this Node-typed package; vitest loads it at runtime like any other module.
interface RegistryOperation {
  name: string;
  mcp?: { curated?: boolean; expose?: boolean; toolName?: string };
}
const coreSpecifier = "@crm/core";
const { coreRegistry } = (await import(coreSpecifier)) as {
  coreRegistry: { list(): RegistryOperation[] };
};
const operations = coreRegistry.list();
const exposed = operations.filter((op) => op.mcp?.expose !== false);
const curatedTools = new Set([
  ...exposed
    .filter((op) => op.mcp?.curated)
    .map((op) => op.mcp?.toolName ?? op.name.replace(/\./g, "_")),
  "describe_operations",
  "call_operation",
]);

const tokensOf = (expectations: ToolExpectation[] = []) =>
  expectations.flatMap((e) => (typeof e === "string" ? [e] : e.anyOf));

describe("tasks", () => {
  it("has exactly 20 tasks with unique ids", () => {
    expect(tasks).toHaveLength(20);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(20);
  });

  it("snapshots the curated MCP tool names", () => {
    expect([...curatedTools].sort()).toMatchInlineSnapshot(`
      [
        "activity_listForRecord",
        "activity_log",
        "approval_status",
        "call_operation",
        "changeset_begin",
        "changeset_commit",
        "code",
        "connection_list",
        "describe_operations",
        "extension_check",
        "extension_eject",
        "extension_list",
        "extension_propose",
        "extension_read",
        "extension_write",
        "integration_call",
        "organisation_create",
        "organisation_get",
        "organisation_update",
        "person_changeJob",
        "person_create",
        "person_get",
        "person_update",
        "query_sql",
        "search_global",
        "suggestedContact_list",
        "task_complete",
        "task_create",
        "task_list",
      ]
    `);
  });

  it("names only tools and operations that MCP exposes", () => {
    for (const task of tasks) {
      const tokens = [
        ...tokensOf(task.expectTools),
        ...(task.expectReason ?? []).map((r) => r.tool),
      ];
      for (const token of tokens) {
        if (token.startsWith("op:")) {
          expect(
            exposed.map((op) => op.name),
            `${task.id}: ${token}`,
          ).toContain(token.slice(3));
        } else {
          expect([...curatedTools], `${task.id}: ${token}`).toContain(token);
        }
      }
      // Forbidden ones may be hidden operations (that is the point), but must be real.
      for (const token of [...(task.forbidTools ?? []), ...(task.forbidSuccess ?? [])]) {
        const name = token.startsWith("op:") ? token.slice(3) : token;
        const known = operations.some((op) => op.name === name) || curatedTools.has(name);
        expect(known, `${task.id}: ${token}`).toBe(true);
      }
    }
  });

  it("covers the stage 2 eval themes", () => {
    const covered = tasks.flatMap((t) => [...tokensOf(t.expectTools), ...(t.forbidSuccess ?? [])]);
    for (const needed of [
      "person_create",
      "person_update",
      "organisation_create",
      "op:person.changeJob",
      "activity_log",
      "task_create",
      "task_complete",
      "query_sql",
      "op:person.updateMany",
      "op:person.merge",
      "changeset_begin",
      "changeset_commit",
      "approval_status",
      "op:person.erase",
    ]) {
      expect(covered).toContain(needed);
    }
    expect(tasks.some((t) => t.expectReason?.length)).toBe(true);
  });

  it("sets up fixtures through curated tools and builds complete prompts", async () => {
    const words = ["Varodin", "Kelipas", "Monuter", "Saridol", "Fetanol"];
    for (const task of tasks) {
      let n = 0;
      const called: string[] = [];
      const call = async (tool: string) => {
        called.push(tool);
        n += 1;
        return { id: `fake_${n}` };
      };
      const setup: SetupContext = {
        suffix: "Varodin",
        slug: "varodin",
        words,
        today: "2026-11-04",
        call,
        person: async () => String((await call("person_create")).id),
        organisation: async () => String((await call("organisation_create")).id),
      };
      const fixture = {
        suffix: "Varodin",
        slug: "varodin",
        today: "2026-11-04",
        ...(await task.setup?.(setup)),
      };
      for (const tool of called) expect([...curatedTools], `${task.id} setup`).toContain(tool);
      const prompts = task.prompts(fixture);
      expect(prompts.length).toBeGreaterThan(0);
      for (const prompt of prompts) {
        expect(prompt, task.id).not.toContain("undefined");
        expect(prompt, task.id).not.toMatch(/fake_/);
      }
    }
  });
});
