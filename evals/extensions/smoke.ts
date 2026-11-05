#!/usr/bin/env node
// Smoke-tests the extensions eval against a running deployment without a model: sign-in, OAuth
// with the admin scope, the extension_* tools, and for each prompt its reference answer
// (reference/<idBase>.ts) written to the workspace, checked by the server and graded by the
// prompt's expectations. With --propose it also proposes each one (they then wait in the
// Approvals inbox) and checks the harness recognises the proposal. Needs no model credentials.
//
//   node evals/extensions/smoke.ts --base-url http://localhost:5173 [--only projects] [--propose]
import { parseArgs } from "node:util";
import type { RecordedCall } from "@relationship-os/evals-mcp/lib/agent.ts";
import { makeSuffix } from "@relationship-os/evals-mcp/lib/harness.ts";
import { openMcpSession, parseResult } from "@relationship-os/evals-mcp/lib/mcp.ts";
import { authorize, signIn } from "@relationship-os/evals-mcp/lib/oauth.ts";
import { AUTHORING_TOOLS, parseCheck, proposalsOf } from "./lib/harness.ts";
import { referenceSource } from "./lib/reference.ts";
import { extensionIdFor, prompts } from "./prompts.ts";
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
  await authorize(baseUrl, cookie, "Extensions eval smoke", SCOPES),
  "Extensions eval smoke",
);
const names = new Set((await session.listTools()).map((t) => t.name));
const missing = AUTHORING_TOOLS.filter((n) => !names.has(n));
if (missing.length) {
  console.log(`FAIL: no ${missing.join(", ")} (is the eval user an admin?)`);
  process.exit(1);
}

const only = values.only?.split(",").map((s) => s.trim());
const slug = makeSuffix().toLowerCase();
let failed = 0;
for (const prompt of prompts.filter((p) => !only || only.includes(p.id))) {
  const id = extensionIdFor(prompt, slug);
  const reason = "Extensions eval smoke test";
  try {
    const written = await session.callTool("extension_write", {
      id,
      files: { "index.ts": referenceSource(prompt, id) },
      replace: true,
      reason,
    });
    if (written.isError) throw new Error(`extension_write: ${written.text}`);
    const answer = await session.callTool("extension_check", { id });
    const check = parseCheck(parseResult(answer.text));
    if (answer.isError || !check) throw new Error(`extension_check: ${answer.text.slice(0, 500)}`);
    const problems = [
      ...check.issues.map((i) => `${i.stage}/${i.code} at ${i.path}: ${i.message}`),
      ...(check.manifest ? prompt.expect(check.manifest) : ["no manifest"]),
    ];
    if (!check.ok || problems.length) throw new Error(problems.join("; ") || "check not ok");
    if (values.propose) {
      const proposed = await session.callTool("extension_propose", { id, reason });
      const call: RecordedCall = {
        promptIndex: 0,
        turn: 1,
        name: "extension_propose",
        input: { id },
        isError: proposed.isError,
        resultText: proposed.text,
        result: parseResult(proposed.text),
      };
      if (proposalsOf([call]).length !== 1) throw new Error(`extension_propose: ${proposed.text}`);
    }
    console.log(
      `ok   ${prompt.id} (${id}): check ok, expectations hold${values.propose ? ", proposed" : ""}`,
    );
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${prompt.id} (${id}): ${(error as Error).message}`);
  }
}
await session.close();
process.exit(failed ? 1 : 0);
