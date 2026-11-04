#!/usr/bin/env node
// Seeds the local D1 database (the one `pnpm dev` and the e2e tests use) with deterministic demo
// data from src/seed.ts. Run after migrations (`pnpm dev` applies them):
//
//   pnpm db:seed                                     # 10k records: 6k people, 2k orgs, 1k + 1k, 400 deals
//   pnpm db:seed -- --people 500 --organisations 100 --activities 200 --tasks 50 --deals 100
//   pnpm db:seed -- --remote                         # the deployed database (careful)
//
// Deals (with stage history) go into the shipped Deals extension's tables, which exist once the
// app has installed it: start the app once (`pnpm dev`, open any page), then seed. Seeding again
// is harmless (every insert is INSERT OR IGNORE). Deals are owned round-robin by the users who
// have signed up.
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
    deals: { type: "string" },
    seed: { type: "string" },
    remote: { type: "boolean", default: false },
  },
});
const num = (value: string | undefined) => (value === undefined ? undefined : Number(value));
const appDir = join(dirname(fileURLToPath(import.meta.url)), "../../../apps/app");
const target = values.remote ? "--remote" : "--local";

function wrangler(args: string[], capture = false): string {
  return execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "DB", target, ...args], {
    cwd: appDir,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    env: { ...process.env, CI: "true" },
    encoding: "utf8",
  });
}

function query<T>(sql: string): T[] {
  const out = JSON.parse(wrangler(["--json", "--command", sql], true)) as { results: T[] }[];
  return out[0]?.results ?? [];
}

function run(statements: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "crm-seed-"));
  const file = join(dir, "seed.sql");
  writeFileSync(file, `${statements.join(";\n")};\n`);
  try {
    wrangler(["--file", file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const dealsInstalled =
  query<{ name: string }>("SELECT name FROM sqlite_master WHERE name = 'x_deals_deal'").length > 0;
const owners = dealsInstalled
  ? query<{ id: string }>("SELECT id FROM core_user WHERE kind = 'human' ORDER BY created_at").map(
      (u) => u.id,
    )
  : [];

const { statements, dealStatements, counts } = generateSeed({
  people: num(values.people),
  organisations: num(values.organisations),
  activities: num(values.activities),
  tasks: num(values.tasks),
  deals: num(values.deals) ?? 400,
  owners,
  seed: num(values.seed),
});

run(statements);
if (dealStatements.length && dealsInstalled) {
  run(dealStatements);
} else if (dealStatements.length) {
  counts.deals = 0;
  console.warn(
    "skipped deals: the Deals extension is not installed yet. Start the app once (pnpm dev, open " +
      "any page) and run pnpm db:seed again.",
  );
}
console.log(`seeded ${JSON.stringify(counts)}`);
