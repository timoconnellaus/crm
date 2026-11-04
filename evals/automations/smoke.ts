#!/usr/bin/env node
// Smoke-tests the automations eval against a running deployment without a model: sign-in, OAuth
// with the admin scope, the extension_* tools, the automation.* operations, and for each case its
// reference answer (lib/reference.ts) written to the workspace and checked by the server. With
// --propose it also proposes them (they then wait in the Approvals inbox). Needs no credentials.
//
//   node evals/automations/smoke.ts --base-url http://localhost:5173 [--only weekly-digest] [--propose]
import { parseArgs } from "node:util";
import { makeSuffix } from "@crm/evals-mcp/lib/harness.ts";
import { openMcpSession, parseResult } from "@crm/evals-mcp/lib/mcp.ts";
import { authorize, signIn } from "@crm/evals-mcp/lib/oauth.ts";
import { CrmClient } from "./lib/crm.ts";
import { AUTHORING_TOOLS } from "./lib/harness.ts";
import { referenceSource } from "./lib/reference.ts";
import { cases, extensionIdFor } from "./prompts.ts";
import { SCOPES } from "./runner.ts";

const { values } = parseArgs({
  options: {
    "base-url": { type: "string", default: "http://localhost:5173" },
    only: { type: "string" },
    propose: { type: "boolean", default: false },
  },
});
const baseUrl = values["base-url"] as string;
const cookie = await signIn(baseUrl, {
  email: process.env.EVAL_ADMIN_EMAIL ?? process.env.MCP_EVAL_EMAIL ?? "mcp-eval@example.com",
  password:
    process.env.EVAL_ADMIN_PASSWORD ?? process.env.MCP_EVAL_PASSWORD ?? "mcp-eval-correct-horse",
  name: "MCP Eval",
});
const session = await openMcpSession(
  baseUrl,
  await authorize(baseUrl, cookie, "Automations eval smoke", SCOPES),
  "Automations eval smoke",
);
const names = new Set((await session.listTools()).map((t) => t.name));
const missing = AUTHORING_TOOLS.filter((n) => !names.has(n));
if (missing.length) {
  console.log(`FAIL: no ${missing.join(", ")} (is the eval user an admin?)`);
  process.exit(1);
}
try {
  const list = await new CrmClient(session).call<{ items?: unknown[] }>("automation.list", {});
  console.log(`ok   automation.list: ${list.items?.length ?? 0} automation(s)`);
} catch (error) {
  console.log(`FAIL automation.list: ${(error as Error).message}`);
  process.exit(1);
}

const only = values.only?.split(",").map((s) => s.trim());
const slug = makeSuffix().toLowerCase();
const reason = "Automations eval smoke test";
let failed = 0;
for (const c of cases.filter((x) => !only || only.includes(x.id))) {
  const id = extensionIdFor(c, slug);
  try {
    const written = await session.callTool("extension_write", {
      id,
      files: { "index.ts": referenceSource(c, id) },
      replace: true,
      reason,
    });
    if (written.isError) throw new Error(`extension_write: ${written.text}`);
    const answer = await session.callTool("extension_check", { id });
    const check = parseResult(answer.text) as { ok?: boolean; issues?: { message: string }[] };
    if (answer.isError || !check?.ok) {
      throw new Error(
        `extension_check: ${check?.issues?.map((i) => i.message).join("; ") ?? answer.text.slice(0, 500)}`,
      );
    }
    if (values.propose) {
      const proposed = await session.callTool("extension_propose", { id, reason });
      const status = (parseResult(proposed.text) as { status?: string } | null)?.status;
      if (status !== "pending_approval") throw new Error(`extension_propose: ${proposed.text}`);
    }
    console.log(`ok   ${c.id} (${id}): check ok${values.propose ? ", proposed" : ""}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${c.id} (${id}): ${(error as Error).message}`);
  }
}
await session.close();
process.exit(failed ? 1 : 0);
