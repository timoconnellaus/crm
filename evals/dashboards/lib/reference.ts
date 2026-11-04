// A stand-in model that answers each prompt with the task's reference widget, in either mode:
// agent mode previews it with call_operation(widget.preview) and then replies; describe mode
// answers with the widget as fenced JSON, as the in-app box asks. The smoke script runs the whole
// harness with it against a deployment (no model credentials needed), and the tests use it to
// check that every reference widget passes the grader.

import type { ModelClient } from "@crm/evals-mcp/lib/model.ts";
import { reply, toolCall } from "@crm/evals-mcp/test/fakes.ts";
import type { DashboardTask } from "../prompts.ts";
import type { DashboardFilter } from "./core.ts";
import type { Mode } from "./harness.ts";

export function referenceModel(
  task: DashboardTask,
  mode: Mode,
  filters: DashboardFilter[],
): ModelClient {
  const script =
    mode === "agent"
      ? [
          reply(null, [
            toolCall("call_operation", {
              name: "widget.preview",
              input: { widget: task.reference, dashboardFilters: filters },
            }),
          ]),
          reply(`Here is "${task.reference.title}" as a ${task.reference.type} widget.`),
        ]
      : [reply(`\`\`\`json\n${JSON.stringify(task.reference, null, 2)}\n\`\`\``)];
  return {
    async createCompletion() {
      const next = script.shift();
      if (!next) throw new Error(`the reference model for ${task.id} has nothing more to say`);
      return next;
    },
  };
}
