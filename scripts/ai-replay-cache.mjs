#!/usr/bin/env node
// Reruns the cache-lifetime learner and the compaction planner (ADR 0341) over an `ai.cacheReport`
// export and prints predicted against actual cost. Changed parameters can be tried offline.
//
// Usage: pnpm ai:replay-cache <export.json> [--hit-bar 0.85] [--half-life-days 7] [--json] ...
//        pnpm ai:replay-cache --help
//
// The export shape is defined in packages/agent-core/src/compaction/export.ts. Node runs the
// TypeScript sources directly (type stripping), so there is no build step.
import { readFileSync } from "node:fs";
import {
  formatReplayReport,
  parseReplayArgs,
  replayCacheReport,
} from "../packages/agent-core/src/compaction/replay.ts";

let args;
try {
  args = parseReplayArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const raw = JSON.parse(readFileSync(args.file, "utf8"));
const report = replayCacheReport(raw, args.overrides);
console.log(args.json ? JSON.stringify(report, null, 2) : formatReplayReport(report));
