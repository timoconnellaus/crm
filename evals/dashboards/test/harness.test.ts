// runDashboardTask end to end with a scripted model and an in-memory CRM (test/fake-crm.ts), in
// both modes: the agent's tool loop and the in-app box's prompt, then the grader's own preview.
import { reply, scriptedModel, toolCall } from "@crm/evals-mcp/test/fakes.ts";
import { describe, expect, it } from "vitest";
import { loadCore } from "../lib/core.ts";
import {
  buildingGuide,
  type DashboardsHarnessDeps,
  DESCRIBE_OPENING,
  dashboardFilters,
  type Mode,
  parseAnswer,
  previewAllowed,
  runDashboardTask,
} from "../lib/harness.ts";
import { referenceModel } from "../lib/reference.ts";
import { tasks } from "../prompts.ts";
import { fakeCrm } from "./fake-crm.ts";

const core = await loadCore();
const filters = dashboardFilters(core);
const byStatus = tasks.find((t) => t.id === "tasks-by-status");
if (!byStatus) throw new Error("tasks-by-status missing");

function deps(model: DashboardsHarnessDeps["model"], crm = fakeCrm()) {
  const sessions: ReturnType<ReturnType<typeof fakeCrm>["session"]>[] = [];
  const names: string[] = [];
  const value: DashboardsHarnessDeps = {
    openSession: async (name) => {
      names.push(name);
      const session = crm.session();
      sessions.push(session);
      return session;
    },
    core,
    model,
    modelId: "@cf/test/model",
    maxTurns: 10,
    today: "2026-11-05",
  };
  return { value, sessions, names, crm };
}

const good = {
  id: "tasks-by-status",
  type: "bar",
  title: "Tasks by status",
  sql: "SELECT status AS label, COUNT(*) AS value FROM crm_tasks GROUP BY status",
  mapping: { x: "label", y: "value" },
};
const previewCall = (widget: Record<string, unknown>, withFilters = true) =>
  toolCall("call_operation", {
    name: "widget.preview",
    input: { widget, ...(withFilters ? { dashboardFilters: filters } : {}) },
  });

describe("agent mode", () => {
  it("passes when the model fixes a failing preview; the grader re-runs the final widget", async () => {
    const broken = {
      ...good,
      sql: `${good.sql.replace("GROUP", "WHERE created_at >= :since GROUP")}`,
    };
    const script = scriptedModel([
      reply(null, [toolCall("query_sql", { sql: "SELECT DISTINCT status FROM crm_tasks" })]),
      reply(null, [previewCall(broken)]),
      reply("Fixing the parameter.", [previewCall(good)]),
      reply("Here is tasks by status as a bar chart."),
    ]);
    const { value, sessions, names } = deps(script.model);
    const result = await runDashboardTask(byStatus, "agent", value);

    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.mode).toBe("agent");
    expect(result.attempts).toBe(2);
    expect(result.candidate?.widget).toEqual(good);
    expect(result.candidate?.dashboardFilters).toEqual(filters);
    expect(result.preview).toMatchObject({ ok: true, columns: ["label", "value"], rowCount: 7 });
    expect(result.toolCalls).toEqual([
      "query_sql",
      "call_operation(widget.preview) ✗",
      "call_operation(widget.preview)",
    ]);
    expect(result.turns).toBe(4);
    expect(result.notes).toEqual([]);

    // The grader previewed on its own connection, opened first; the agent on a second.
    expect(names).toEqual([
      "Dashboards eval grader (tasks-by-status)",
      "Agent dashboards eval (tasks-by-status)",
    ]);
    expect(sessions[0]?.calls).toEqual([
      {
        name: "call_operation",
        args: {
          name: "widget.preview",
          input: { widget: good, dashboardFilters: filters, filters: {}, refresh: true },
        },
      },
    ]);
    expect(sessions.every((s) => s.closed)).toBe(true);

    // The system prompt carries the server's instructions, the date and the in-app guidance.
    const system = String(script.requests[0]?.messages[0]?.content);
    expect(system).toContain("CRM instructions");
    expect(system).toContain("Today's date is 2026-11-05");
    expect(system).toContain("widget.preview");
    expect(system).toContain("Mapping by type: kpi → value");
    expect(system).not.toContain(DESCRIBE_OPENING);
    expect(script.requests[0]?.messages[1]).toEqual({ role: "user", content: byStatus.prompt });
  });

  it("fails on the chart type even when the SQL runs", async () => {
    const donut = { ...good, type: "donut", mapping: { label: "label", value: "value" } };
    const script = scriptedModel([reply(null, [previewCall(donut)]), reply("Done.")]);
    const result = await runDashboardTask(byStatus, "agent", deps(script.model).value);
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual([
      { kind: "type", message: "chart type donut does not fit; accepted: bar" },
    ]);
  });

  it("fails when the final widget does not run, graded by the grader's own preview", async () => {
    const dated = {
      ...good,
      sql: "SELECT status AS label, COUNT(*) AS value FROM crm_tasks WHERE created_at >= :date_from GROUP BY status",
    };
    // Previewed without the dashboard's filters, so :date_from is unknown.
    const script = scriptedModel([reply(null, [previewCall(dated, false)]), reply("Done.")]);
    const result = await runDashboardTask(byStatus, "agent", deps(script.model).value);
    expect(result.failures).toEqual([
      { kind: "sql", message: "the widget does not run: unknown parameter :date_from" },
    ]);
    expect(result.notes).toEqual(["the model's last widget.preview failed"]);
    expect(result.preview).toEqual({ ok: false, error: "unknown parameter :date_from" });
  });

  it("fails with no widget when the model only talks", async () => {
    const script = scriptedModel([reply("You could use a bar chart.")]);
    const result = await runDashboardTask(byStatus, "agent", deps(script.model).value);
    expect(result.failures).toEqual([
      { kind: "no-widget", message: "the model produced no widget" },
    ]);
    expect(result.candidate).toBeNull();
    expect(result.preview).toBeNull();
  });

  it("deletes dashboards the model saved", async () => {
    const script = scriptedModel([
      reply(null, [previewCall(good)]),
      reply(null, [
        toolCall("call_operation", {
          name: "dashboard.create",
          input: { title: "Tasks", filters, widgets: [good] },
          reason: "The user asked for a chart",
        }),
      ]),
      reply("Saved."),
    ]);
    const { value, crm } = deps(script.model);
    const result = await runDashboardTask(byStatus, "agent", value);
    expect(result.passed).toBe(true);
    expect(crm.dashboards.size).toBe(0);
    expect(result.notes).toEqual([]);
  });

  it("stops the run on a fatal model error", async () => {
    const model = {
      async createCompletion(): Promise<never> {
        throw new Error("401 bad token");
      },
    };
    const { value } = deps(model);
    value.isFatal = () => true;
    await expect(runDashboardTask(byStatus, "agent", value)).rejects.toThrow("401 bad token");
    value.isFatal = () => false;
    const result = await runDashboardTask(byStatus, "agent", value);
    expect(result.failures).toEqual([{ kind: "error", message: "401 bad token" }]);
  });
});

describe("describe mode (the in-app box)", () => {
  it("sends describePrompt's messages with no tools and grades the JSON answer", async () => {
    const script = scriptedModel([
      reply(`Here you go:\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\``),
    ]);
    const { value, sessions, names } = deps(script.model);
    const result = await runDashboardTask(byStatus, "describe", value);

    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.turns).toBe(1);
    expect(result.candidate).toMatchObject({
      source: "describe",
      modelPreviewOk: true,
      filters: {},
    });
    expect(result.candidate?.dashboardFilters).toEqual(filters);
    expect(names[1]).toBe("Describe box eval (tasks-by-status)");
    expect(script.requests).toHaveLength(1);
    expect(script.requests[0]?.tools).toBeUndefined();
    expect(script.requests[0]?.messages).toEqual(core.describePrompt(byStatus.prompt, filters));
    // The box's own preview on the app connection, then the grader's.
    expect(sessions[1]?.calls).toHaveLength(1);
    expect(sessions[0]?.calls).toHaveLength(1);
  });

  it("sends one failure back with the error, as widget.describe does", async () => {
    const broken = {
      ...good,
      sql: "SELECT status AS label, COUNT(*) AS value FROM tasks GROUP BY status",
    };
    const script = scriptedModel([reply(JSON.stringify(broken)), reply(JSON.stringify(good))]);
    const result = await runDashboardTask(byStatus, "describe", deps(script.model).value);
    expect(result.passed).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.toolCalls).toEqual(["widget.preview ✗", "widget.preview"]);
    expect(script.requests[1]?.messages.slice(-2)).toEqual([
      { role: "assistant", content: JSON.stringify(broken) },
      {
        role: "user",
        content:
          "That widget failed: no such table: tasks. Reply with the corrected JSON object only.",
      },
    ]);
  });

  it("fails with no widget when neither answer is JSON", async () => {
    const script = scriptedModel([reply("A bar chart."), reply("Still a bar chart.")]);
    const result = await runDashboardTask(byStatus, "describe", deps(script.model).value);
    expect(result.failures).toEqual([
      { kind: "no-widget", message: "the model produced no widget" },
    ]);
    expect(result.notes).toEqual(["the in-app box would show: The answer was not a JSON object"]);
  });

  it("normalises the answer like widget.describe (id, mapping, options)", () => {
    expect(parseAnswer(core, '{"id": "Bad Id", "type": "kpi", "sql": "SELECT 1"}')).toEqual({
      widget: { id: "widget", type: "kpi", sql: "SELECT 1", mapping: {}, options: {} },
    });
    expect(parseAnswer(core, "no json")).toEqual({ error: "The answer was not a JSON object" });
  });
});

describe("reference widgets", () => {
  for (const mode of ["agent", "describe"] as Mode[]) {
    it(`every prompt's reference answer passes the grader (${mode})`, async () => {
      for (const task of tasks) {
        const result = await runDashboardTask(
          task,
          mode,
          deps(referenceModel(task, mode, filters)).value,
        );
        expect(result.failures, `${mode} ${task.id}`).toEqual([]);
        expect(result.candidate?.widget.type).toBe(task.reference.type);
      }
    });
  }
});

describe("helpers", () => {
  it("builds the agent guide from describePrompt with the dashboard's filters", () => {
    const guide = buildingGuide(core, filters);
    expect(guide).toContain(JSON.stringify(filters));
    expect(guide).toContain(":date_from");
    expect(guide).toContain("crm_tasks -- Task records");
  });

  it("reads widget.preview's availability from describe_operations", () => {
    expect(
      previewAllowed(JSON.stringify({ operations: [{ name: "widget.preview", allowed: true }] })),
    ).toBe(true);
    expect(
      previewAllowed(JSON.stringify({ operations: [{ name: "widget.preview", allowed: false }] })),
    ).toBe(false);
    expect(previewAllowed(JSON.stringify({ operations: [] }))).toBe(false);
    expect(previewAllowed("not json")).toBe(false);
  });
});
