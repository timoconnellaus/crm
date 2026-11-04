#!/usr/bin/env node
// Seeds the local D1 database (the one `pnpm dev` and the e2e tests use) with deterministic demo
// data from src/seed.ts. Run after migrations (`pnpm dev` applies them):
//
//   pnpm --filter @crm/db seed                       # 10k records: 6k people, 2k orgs, 1k + 1k
//   pnpm --filter @crm/db seed -- --people 500 --organisations 100 --activities 200 --tasks 50
//   pnpm --filter @crm/db seed -- --remote           # the deployed database (careful)
//
// Runs with Node's built-in TypeScript type stripping (Node >= 24).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { generateSeed } from "../src/seed.ts";

const { values } = parseArgs({
  options: {
    people: { type: "string" },
    organisations: { type: "string" },
    activities: { type: "string" },
    tasks: { type: "string" },
    seed: { type: "string" },
    remote: { type: "boolean", default: false },
  },
});
const num = (value: string | undefined) => (value === undefined ? undefined : Number(value));

const { statements, counts } = generateSeed({
  people: num(values.people),
  organisations: num(values.organisations),
  activities: num(values.activities),
  tasks: num(values.tasks),
  seed: num(values.seed),
});

const dir = mkdtempSync(join(tmpdir(), "crm-seed-"));
const file = join(dir, "seed.sql");
writeFileSync(file, `${statements.join(";\n")};\n`);
const appDir = join(dirname(fileURLToPath(import.meta.url)), "../../../apps/app");
try {
  execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "DB",
      values.remote ? "--remote" : "--local",
      "--file",
      file,
    ],
    { cwd: appDir, stdio: "inherit", env: { ...process.env, CI: "true" } },
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`seeded ${JSON.stringify(counts)}`);
