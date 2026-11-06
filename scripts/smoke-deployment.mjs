#!/usr/bin/env node
// Read-only smoke test of a live deployment. It sends GET requests only and needs no credentials,
// so it is safe against production:
//
//   /api/health     status ok, database migrated, ros-runner reachable
//   /sign-in        the sign-in page renders
//   static assets   the page's scripts and stylesheets are served
//
// Usage: node scripts/smoke-deployment.mjs <url>
// Exits 1 if any check fails. Behind Cloudflare Access, /sign-in redirects to Access, which is
// reported as a pass with a note, and the asset checks are skipped.
import { fileURLToPath } from "node:url";

const TIMEOUT_MS = 15_000;

const get = (url) =>
  fetch(url, {
    redirect: "manual",
    headers: { "user-agent": "ros-smoke-deployment" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

async function checkHealth(origin) {
  const response = await get(`${origin}/api/health`);
  const text = await response.text();
  let health;
  try {
    health = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${response.status}, not JSON: ${text.slice(0, 120)}`);
  }
  const problems = [];
  if (health.status !== "ok") problems.push(`status is ${health.status}`);
  if (!health.database?.ok) {
    problems.push(`database: ${health.database?.error ?? JSON.stringify(health.database)}`);
  }
  if (!health.runner?.ok) problems.push(`runner: ${health.runner?.error ?? "not reachable"}`);
  if (problems.length) throw new Error(problems.join("; "));
  const { version, commit, database, runner } = health;
  return `version ${version} (${String(commit).slice(0, 8)}), schema ${database.schemaVersion}, runner ${runner.latencyMs} ms`;
}

async function checkSignIn(origin) {
  const response = await get(`${origin}/sign-in`);
  const location = response.headers.get("location") ?? "";
  if (response.status >= 300 && response.status < 400 && location.includes("cloudflareaccess")) {
    return { note: "redirects to Cloudflare Access", assets: [] };
  }
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("text/html")) throw new Error(`content-type ${type}`);
  const html = await response.text();
  const assets = [
    ...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1])),
  ];
  if (!assets.length) throw new Error("the page links no /assets/ scripts or stylesheets");
  return { note: `${html.length} bytes, ${assets.length} assets linked`, assets };
}

async function checkAsset(origin, path) {
  const response = await get(`${origin}${path}`);
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  const type = response.headers.get("content-type") ?? "";
  const expected = path.endsWith(".css") ? "text/css" : "javascript";
  if (!type.includes(expected)) throw new Error(`content-type ${type}`);
  const body = await response.arrayBuffer();
  if (body.byteLength === 0) throw new Error("empty");
}

/** Runs every check against `url`. Returns the number of failures. */
export async function smoke(url, log = console.log) {
  const origin = new URL(url).origin;
  let failures = 0;
  const step = async (name, check) => {
    try {
      const detail = await check();
      log(`ok    ${name}${detail ? `: ${detail}` : ""}`);
    } catch (error) {
      failures++;
      log(`FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  log(`Smoke test of ${origin}`);
  await step("/api/health", () => checkHealth(origin));
  let assets = [];
  await step("/sign-in", async () => {
    const page = await checkSignIn(origin);
    assets = page.assets;
    return page.note;
  });
  // Every asset would be many requests for nothing: a stylesheet and a few scripts are enough.
  const sample = [
    ...assets.filter((a) => a.endsWith(".css")).slice(0, 1),
    ...assets.filter((a) => a.endsWith(".js")).slice(0, 3),
  ];
  for (const asset of sample) await step(asset, () => checkAsset(origin, asset));
  log(failures ? `${failures} check(s) failed` : "All checks passed");
  return failures;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.argv[2];
  if (!url || !/^https?:\/\//.test(url)) {
    console.error("Usage: node scripts/smoke-deployment.mjs <url>");
    process.exit(2);
  }
  process.exit((await smoke(url)) ? 1 : 0);
}
