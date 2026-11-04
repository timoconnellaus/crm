#!/usr/bin/env node
// Drives the dev-only spike route on a running `wrangler dev` (default http://127.0.0.1:8787) and
// prints the measurements. Usage: node scripts/spike-bench.mjs [baseUrl] [cold] [warm]
const [base = "http://127.0.0.1:8787", cold = "5", warm = "20"] = process.argv.slice(2);
const started = Date.now();
const response = await fetch(`${base}/dev/spike/bench?cold=${cold}&warm=${warm}`);
if (!response.ok) {
  console.error(`spike bench failed: ${response.status} ${await response.text()}`);
  process.exit(1);
}
const result = await response.json();
result.totalMs = Date.now() - started;
console.log(JSON.stringify(result, null, 2));
