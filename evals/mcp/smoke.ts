#!/usr/bin/env node
// Smoke-tests the harness against a running deployment without calling Claude: sign-in, OAuth,
// MCP, tool conversion, every task's fixture setup, and each outcome check run against the
// untouched fixture (most should fail, since nobody did the task). Useful after changing the
// server or the tasks; needs no API key.
//
//   node evals/mcp/smoke.ts --base-url http://localhost:5173
import { parseArgs } from "node:util";
import type { AgentRun } from "./lib/agent.ts";
import { toAnthropicTools } from "./lib/convert.ts";
import {
  type CheckContext,
  type Fixture,
  makeSuffix,
  setupContext,
  todayUtc,
} from "./lib/harness.ts";
import { openMcpSession, parseResult } from "./lib/mcp.ts";
import { authorize, signIn } from "./lib/oauth.ts";
import { tasks } from "./tasks.ts";

const { values } = parseArgs({
  options: { "base-url": { type: "string", default: "http://localhost:5173" } },
});
const baseUrl = values["base-url"] as string;
const cookie = await signIn(baseUrl, {
  email: process.env.MCP_EVAL_EMAIL ?? "mcp-eval@example.com",
  password: process.env.MCP_EVAL_PASSWORD ?? "mcp-eval-correct-horse",
  name: "MCP Eval",
});
const open = async (name: string) =>
  openMcpSession(baseUrl, await authorize(baseUrl, cookie, name), name);

const probe = await open("MCP eval smoke");
const tools = toAnthropicTools(await probe.listTools());
console.log(`${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);
const unions = tools.filter((t) => "anyOf" in t.input_schema || "oneOf" in t.input_schema);
if (unions.length) throw new Error(`top-level unions left in ${unions.map((t) => t.name)}`);
console.log(`instructions: ${probe.instructions?.slice(0, 60)}…`);
await probe.close();

const emptyRun: AgentRun = {
  calls: [],
  replies: [""],
  finalText: "",
  stopReason: "end_turn",
  turns: 0,
  usage: { inputTokens: 0, outputTokens: 0 },
};
let failed = 0;
for (const task of tasks) {
  const admin = await open(`MCP eval smoke setup (${task.id})`);
  const agent = await open(`MCP eval smoke agent (${task.id})`);
  try {
    const words = Array.from({ length: 5 }, () => makeSuffix());
    const today = todayUtc();
    const fixture: Fixture = {
      suffix: words[0] as string,
      slug: (words[0] as string).toLowerCase(),
      today,
    };
    Object.assign(fixture, await task.setup?.(setupContext(admin, words, today)));
    const json = async (session: typeof admin, tool: string, args: Record<string, unknown>) => {
      const r = await session.callTool(tool, args);
      return { isError: r.isError, data: parseResult(r.text) };
    };
    const ctx: CheckContext = {
      fixture,
      run: emptyRun,
      async sql<T>(query: string, params: unknown[] = []) {
        const { isError, data } = await json(admin, "query_sql", { sql: query, params });
        if (isError) throw new Error(JSON.stringify(data));
        return (data as { rows: T[] }).rows;
      },
      agentCall: (tool, args) => json(agent, tool, args),
      adminCall: (tool, args) => json(admin, tool, args),
    };
    const outcome = task.check ? await task.check(ctx) : [];
    await task.cleanup?.(ctx);
    console.log(
      `ok   ${task.id}: setup done; untouched outcome → ${outcome.join("; ") || "(check passes)"}`,
    );
    console.log(`     prompt: ${task.prompts(fixture).join(" / ")}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${task.id}: ${(error as Error).message}`);
  } finally {
    await admin.close();
    await agent.close();
  }
}
process.exit(failed ? 1 : 0);
