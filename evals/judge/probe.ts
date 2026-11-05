#!/usr/bin/env node
// The judge's route probe (ADR 0230, stage 11 AC 2): one call through exactly the route the Workers
// use (`judgeRoute`), recorded as a report in evals/judge/reports/probe-<time>.md. Never prints a
// key: only whether each header was sent.
//
//   pnpm --filter @relationship-os/evals-judge probe              # direct, with TYPESAFE_API_KEY
//   CLOUDFLARE_ACCOUNT_ID=… AI_GATEWAY_ID=… AI_GATEWAY_TOKEN=… pnpm … probe
//                                                                 # through custom-typesafe
//   … JUDGE_BYOK=true pnpm … probe                                # BYOK: no Authorization sent
//
// What the gateway path must show (ADR 0230's open checks): the call reaches TypeSafe at
// /v1/systemone with the body unchanged (the answer names the question asked), BYOK under
// custom-typesafe replaces our Authorization header (a 200 with JUDGE_BYOK=true and no key sent),
// and the gateway's logs show the call with its cf-aig-metadata and token usage (look in the
// dashboard: AI Gateway → the gateway → Logs, filtered by metadata judge = judge.test).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JEV_MODEL, jevJudge, judgeRoute, noul } from "@relationship-os/core/judge";
import { loadEvalEnvFile } from "@relationship-os/evals-mcp/lib/env-file.ts";

export async function probe(env: Record<string, string | undefined>): Promise<string[]> {
  const route = judgeRoute(env);
  if (!route.ready) return [`Not ready: ${route.why}`];
  const headers = route.headers("judge.test");
  let status: number | null = null;
  let responseHeaders: Record<string, string> = {};
  const judge = jevJudge({
    route,
    timeoutMs: 15_000,
    log: () => {},
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      status = response.status;
      responseHeaders = Object.fromEntries(
        [...response.headers.entries()].filter(([k]) =>
          /^(cf-aig-|x-typesafe-request-id|content-type)/.test(k),
        ),
      );
      return response;
    },
  });
  const started = Date.now();
  const out = await judge.ask({
    placement: "judge.test",
    state: { word: "hello" },
    questions: { greeting: noul("Is `word` a greeting?") },
  });
  const sent = (name: string) => (name in headers ? "sent" : "not sent");
  return [
    `- When: ${new Date().toISOString()}`,
    `- Route: ${route.viaGateway ? "AI Gateway custom provider custom-typesafe" : "direct"} (${route.url.replace(/\/v1\/[0-9a-f]{32}\//, "/v1/<account>/")})`,
    `- Key: ${route.keySource === "byok" ? "BYOK in the gateway" : "TYPESAFE_API_KEY"}; Authorization ${sent("authorization")}, cf-aig-authorization ${sent("cf-aig-authorization")}, cf-aig-metadata ${headers["cf-aig-metadata"] ?? "not sent"}`,
    `- HTTP ${status ?? "no response"} in ${Date.now() - started} ms; response headers ${JSON.stringify(responseHeaders)}`,
    out.status === "answered"
      ? `- Answered by ${out.model} (pinned ${JEV_MODEL}): greeting ${out.answers.greeting.noul}, ${out.inputTokens} input tokens`
      : `- No answer: ${out.status === "fault" ? `fault ${out.httpStatus}` : out.reason} ${out.status === "unavailable" ? (out.detail ?? "") : out.detail}`,
  ];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  loadEvalEnvFile(process.env);
  probe(process.env).then((lines) => {
    const text = ["# Judge route probe", "", ...lines, ""].join("\n");
    console.log(text);
    const dir = join(dirname(fileURLToPath(import.meta.url)), "reports");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `probe-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
    writeFileSync(file, text);
    console.log(`Report: ${file}`);
  });
}
