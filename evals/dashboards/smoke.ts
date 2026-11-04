#!/usr/bin/env node
// Smoke-tests the dashboards eval against a running deployment without a model: sign-in, OAuth,
// MCP, widget.preview through call_operation, and the whole harness in both modes driven by a
// stand-in model that answers each prompt with its reference widget (lib/reference.ts). Every
// prompt should pass: a failure means the reference SQL, the grader or the server is wrong.
// Needs no model credentials, but @crm/core needs Node's type transforms:
//
//   node --experimental-transform-types evals/dashboards/smoke.ts --base-url http://localhost:5173 [--mode agent|describe|both] [--only id,id]
import { parseArgs } from "node:util";
import { parseOnly } from "@crm/evals-mcp/lib/cli.ts";
import { openMcpSession } from "@crm/evals-mcp/lib/mcp.ts";
import { authorize, signIn } from "@crm/evals-mcp/lib/oauth.ts";
import { loadCore } from "./lib/core.ts";
import {
  dashboardFilters,
  MODES,
  type Mode,
  previewAllowed,
  runDashboardTask,
} from "./lib/harness.ts";
import { referenceModel } from "./lib/reference.ts";
import { tasks } from "./prompts.ts";

const { values } = parseArgs({
  options: {
    "base-url": { type: "string", default: "http://localhost:5173" },
    mode: { type: "string", default: "both" },
    only: { type: "string" },
  },
});
const baseUrl = values["base-url"] as string;
const modes: Mode[] = values.mode === "both" ? MODES : [values.mode as Mode];
if (!modes.every((m) => MODES.includes(m)))
  throw new Error("--mode must be agent, describe or both");
const only = parseOnly(
  values.only,
  tasks.map((t) => t.id),
);
const core = await loadCore();
const cookie = await signIn(baseUrl, {
  email: process.env.MCP_EVAL_EMAIL ?? "mcp-eval@example.com",
  password: process.env.MCP_EVAL_PASSWORD ?? "mcp-eval-correct-horse",
  name: "MCP Eval",
});
const openSession = async (name: string) =>
  openMcpSession(baseUrl, await authorize(baseUrl, cookie, name), name);

const probe = await openSession("Dashboards eval smoke");
const described = await probe.callTool("describe_operations", {
  names: ["widget.preview"],
  includeSchemas: false,
});
await probe.close();
if (!previewAllowed(described.text)) {
  console.log(`FAIL: widget.preview is not callable over MCP: ${described.text.slice(0, 300)}`);
  process.exit(1);
}
console.log("ok   widget.preview is callable through call_operation");

const filters = dashboardFilters(core);
let failed = 0;
for (const mode of modes) {
  for (const task of tasks.filter((t) => !only || only.includes(t.id))) {
    const result = await runDashboardTask(task, mode, {
      openSession,
      core,
      model: referenceModel(task, mode, filters),
      modelId: "reference",
      maxTurns: 4,
    });
    if (result.passed) {
      const rows = result.preview?.ok ? result.preview.rowCount : "?";
      console.log(`ok   ${mode} ${task.id}: ${result.candidate?.widget.type}, ${rows} row(s)`);
    } else {
      failed += 1;
      console.log(
        `FAIL ${mode} ${task.id}: ${result.failures.map((f) => `${f.kind}: ${f.message}`).join("; ")}`,
      );
    }
  }
}
process.exit(failed ? 1 : 0);
