// Throughput of concurrent tool runs (cost audit F2, ADR 0043). Each run waits on I/O (a
// codemode:crm call plus a timer), as real tools do. Run one at a time they take N × one run; run
// in parallel from the stateless entrypoint they overlap, so N runs take about as long as a few.
import { beforeAll, describe, expect, it } from "vitest";
import { createAdmin, extensionRow, host, install, source, unique } from "./helpers.ts";

const N = 20;
const WAIT_MS = 50;

let admin: Awaited<ReturnType<typeof createAdmin>>;
let id: string;
let commit: string;

beforeAll(async () => {
  admin = await createAdmin();
  id = unique("tp").slice(0, 24);
  await install(
    admin,
    id,
    source(
      id,
      `tools: {
    slow: defineTool({
      description: "Waits on I/O like a real tool: one operation call and a timer.",
      input: z.object({ n: z.number() }),
      output: z.unknown(),
      handler: async (input, ctx) => {
        await ctx.crm.call("person.list", { limit: 1 });
        const wait = (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => void }).setTimeout;
        await new Promise<void>((resolve) => wait(resolve, ${WAIT_MS}));
        return input.n;
      },
    }),
  },
  permissions: { read: ["person"], modules: ["crm"] },`,
    ),
  );
  commit = (await extensionRow(id)).commit_oid;
});

const runOne = (n: number) =>
  host.runTool({
    id,
    commit,
    tool: "slow",
    input: { n },
    caller: { actor: "human", userId: admin.id },
  });

describe("tool run throughput", () => {
  it(`runs ${N} concurrent tool runs without queueing them one by one`, async () => {
    // Warm: the build, the Dynamic Worker and the compiler are not what this measures.
    expect(await runOne(-1)).toMatchObject({ ok: true, value: -1 });
    const single = Date.now();
    await runOne(0);
    const singleMs = Date.now() - single;
    const started = Date.now();
    const results = await Promise.all(Array.from({ length: N }, (_, n) => runOne(n)));
    const ms = Date.now() - started;
    expect(results.map((r) => (r.ok ? r.value : r.error))).toEqual(
      Array.from({ length: N }, (_, n) => n),
    );
    const perSecond = (N / ms) * 1000;
    console.log(
      `throughput: ${N} concurrent tool runs in ${ms} ms (${perSecond.toFixed(1)}/s); one run ${singleMs} ms`,
    );
    // Serialised, N runs take at least N × WAIT_MS.
    expect(ms).toBeLessThan(N * WAIT_MS);
  });
});
