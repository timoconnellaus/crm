// Dev-only spike routes. `GET /dev/spike/bench` runs every scenario from the stage 0 spec and
// returns the measurements as JSON; scripts/spike-bench.mjs drives it and prints a summary.
import type { SpikeWorkspace } from "./workspace.ts";

const TRIVIAL = "export default () => 1;";

const HOST_CALLS = (n: number) => `
import { getPerson } from "codemode:crm";
export default async function () {
  const started = Date.now();
  let person = null;
  for (let i = 0; i < ${n}; i++) person = await getPerson("p1");
  return { calls: ${n}, ms: Date.now() - started, person };
}`;

// A long CPU-bound loop with a body. An empty `for (;;) {}` is deliberately not used: in local
// workerd it wedges the whole runtime and the timeout never fires (see the spike write-up).
const CPU_SPIN =
  "export default () => { let x = 0; for (let i = 0; i < 2e10; i++) x += i; return x; };";
const HANG = "export default () => new Promise(() => {});";
const NETWORK = `export default async () => (await fetch("https://example.com")).status;`;

const GIT_COMMIT = `
import fs from "node:fs/promises";
import { cli } from "codemode:git";
export default async function ({ round }) {
  const dir = "/workspace/ext";
  if (round === 0) {
    await fs.mkdir(dir, { recursive: true });
    await cli({ argv: ["init"], cwd: dir });
  }
  await fs.writeFile(dir + "/automation.js", "export default () => " + JSON.stringify("v" + round) + ";\\n");
  await cli({ argv: ["add", "automation.js"], cwd: dir });
  const commit = await cli({ argv: ["commit", "-m", "automation v" + round], cwd: dir });
  return { exitCode: commit.exitCode, stdout: commit.stdout, stderr: commit.stderr };
}`;

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    n: sorted.length,
    min: round(sorted[0] ?? 0),
    p50: round(pick(0.5)),
    p95: round(pick(0.95)),
    max: round(sorted.at(-1) ?? 0),
  };
}

async function attempt<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (error) {
    return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

function stub(env: Env, name: string): DurableObjectStub<SpikeWorkspace> {
  return env.SPIKE_WORKSPACE.get(env.SPIKE_WORKSPACE.idFromName(name));
}

export async function bench(env: Env, options: { cold: number; warm: number }) {
  const run = crypto.randomUUID();

  // Cold: a Durable Object that has never run anything, so the Workspace, the backend and the
  // Dynamic Worker are all created for this execution.
  const coldOuter: number[] = [];
  const coldInner: number[] = [];
  for (let i = 0; i < options.cold; i++) {
    const started = performance.now();
    const result = await stub(env, `cold-${run}-${i}`).exec(TRIVIAL);
    coldOuter.push(performance.now() - started);
    coldInner.push(result.ms);
  }

  // Warm: the same Durable Object, repeatedly.
  const warmStub = stub(env, `warm-${run}`);
  await warmStub.exec(TRIVIAL);
  const warmOuter: number[] = [];
  const warmInner: number[] = [];
  for (let i = 0; i < options.warm; i++) {
    const started = performance.now();
    const result = await warmStub.exec(TRIVIAL);
    warmOuter.push(performance.now() - started);
    warmInner.push(result.ms);
  }

  // Host module calls: one execution making 1 and 100 calls, timed inside the isolate.
  const hostOne = await attempt(() => warmStub.exec(HOST_CALLS(1)));
  const hostHundred = await attempt(() => warmStub.exec(HOST_CALLS(100)));
  // The default maxCapabilityCalls is 256 per execution.
  const hostOverLimit = await attempt(() => warmStub.exec(HOST_CALLS(300)));

  // Timeouts: a CPU-bound loop and a never-settling promise, both with a 2 s timeout.
  const cpuTimeout = await attempt(() => warmStub.exec(CPU_SPIN, { timeoutMs: 2_000 }));
  const hangTimeout = await attempt(() => warmStub.exec(HANG, { timeoutMs: 2_000 }));
  const afterTimeout = await attempt(() => warmStub.exec(TRIVIAL));

  // No network: globalOutbound is null.
  const network = await attempt(() => warmStub.exec(NETWORK));

  // Git: commit twice from inside the isolate with codemode:git, then read the diff on the host.
  const gitStub = stub(env, `git-${run}`);
  const commit0 = await attempt(() => gitStub.exec(GIT_COMMIT, { input: { round: 0 } }));
  const commit1 = await attempt(() => gitStub.exec(GIT_COMMIT, { input: { round: 1 } }));
  const diff = await attempt(() => gitStub.lastCommitDiff("/workspace/ext"));

  return {
    run,
    cold: { outerMs: stats(coldOuter), innerMs: stats(coldInner) },
    warm: { outerMs: stats(warmOuter), innerMs: stats(warmInner) },
    hostModule: { one: hostOne, hundred: hostHundred, overLimit: hostOverLimit },
    timeout: { cpu: cpuTimeout, hang: hangTimeout, afterTimeout },
    network,
    git: { commit0, commit1, diff },
  };
}

export async function handleSpikeRoute(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/dev/spike/bench") {
    const cold = Number(url.searchParams.get("cold") ?? 5);
    const warm = Number(url.searchParams.get("warm") ?? 20);
    return Response.json(await bench(env, { cold, warm }));
  }
  if (url.pathname === "/dev/spike/exec" && request.method === "POST") {
    const body = (await request.json()) as { source: string; name?: string; timeoutMs?: number };
    const options = body.timeoutMs === undefined ? {} : { timeoutMs: body.timeoutMs };
    return Response.json(await stub(env, body.name ?? "dev").exec(body.source, options));
  }
  return new Response("not found", { status: 404 });
}
