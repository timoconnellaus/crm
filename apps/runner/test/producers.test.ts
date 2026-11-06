// Saved A2UI producers on their stable worker (ADR 0043, ADR 0346): one id per version, reused for
// every viewer; no model and no network; read operations only; and two people's concurrent runs
// on one warm worker never mix.
import { env } from "cloudflare:workers";
import { prepareCard, producerRef } from "@relationship-os/agent-a2ui";
import {
  type ActingUser,
  type CodeCaller,
  FIRST_PARTY_PRODUCERS,
  invokeByName,
  type ProducerRun,
} from "@relationship-os/core";
import { beforeAll, describe, expect, it } from "vitest";
import { buildProducer, producerWorkerId } from "../src/extensions/producers.ts";
import { extensionHost } from "../src/index.ts";
import { call, context, createAdmin, unique } from "./helpers.ts";

/** A Worker Loader that records every get (with its id) and load. */
function countingLoader() {
  const gets: string[] = [];
  let loads = 0;
  let built = 0;
  const loader = {
    get(id: string | null, code: () => WorkerLoaderWorkerCode | Promise<WorkerLoaderWorkerCode>) {
      gets.push(String(id));
      return env.LOADER.get(id, () => {
        built += 1;
        return code();
      });
    },
    load(code: WorkerLoaderWorkerCode) {
      loads += 1;
      return env.LOADER.load(code);
    },
  };
  return {
    gets,
    loads: () => loads,
    built: () => built,
    loader: loader as unknown as WorkerLoader,
  };
}

let admin: ActingUser;

const caller = (user: ActingUser): CodeCaller => ({
  actor: "human",
  user,
  origin: { surface: "ui" },
});

function run(source: string, overrides: Partial<ProducerRun> = {}): ProducerRun {
  return {
    ref: `test.${unique("p")}@1`,
    source,
    input: {},
    now: new Date().toISOString(),
    timezone: "UTC",
    caller: caller(admin),
    ...overrides,
  };
}

const first = (name: string) => {
  const producer = FIRST_PARTY_PRODUCERS.find((p) => p.name === name);
  if (!producer) throw new Error(`no ${name}`);
  return producer;
};

beforeAll(async () => {
  admin = await createAdmin();
});

describe("a producer's worker", () => {
  it("has one stable id per version and runs on LOADER.get, never load()", async () => {
    const counting = countingLoader();
    const host = extensionHost(env, { loader: counting.loader });
    const input = run("export default async () => ({ a2ui: 1, root: { type: 'divider' } });");
    const a = await host.runProducer(input);
    const b = await host.runProducer(input);
    expect(a.ok && b.ok).toBe(true);
    expect(a.workerId).toBe(await producerWorkerId(input.ref, input.source));
    expect(a.workerId).toMatch(/^a2ui:test\.p[a-z0-9]+@1:[0-9a-f]{32}$/);
    expect(new Set(counting.gets)).toEqual(new Set([a.workerId]));
    expect(b.workerId).toBe(a.workerId);
    expect(counting.loads()).toBe(0);
    // The isolate is reused: the worker was built once for the two runs.
    expect(counting.built()).toBe(1);
  });

  it("gets a new id when the version or source changes", async () => {
    const source = "export default () => null;";
    const id = await producerWorkerId("a.b@1", source);
    expect(await producerWorkerId("a.b@1", source)).toBe(id);
    expect(await producerWorkerId("a.b@2", source)).not.toBe(id);
    expect(await producerWorkerId("a.b@1", `${source} `)).not.toBe(id);
  });

  it("gets what it needs as arguments, not ambient state", async () => {
    const host = extensionHost(env);
    const result = await host.runProducer(
      run(
        `export default async (input, ctx) => ({ input, now: ctx.now, timezone: ctx.timezone, env: typeof process });`,
        { input: { days: 3 }, now: "2026-11-06T00:00:00.000Z", timezone: "Australia/Sydney" },
      ),
    );
    expect(result.value).toMatchObject({
      input: { days: 3 },
      now: "2026-11-06T00:00:00.000Z",
      timezone: "Australia/Sydney",
    });
  });

  it("has no network", async () => {
    const result = await extensionHost(env).runProducer(
      run(`export default async () => { await fetch("https://example.com"); return 1; };`),
    );
    expect(result.ok).toBe(false);
  });

  it("imports nothing", async () => {
    for (const source of [
      `import { crm } from "codemode:crm"; export default () => crm;`,
      `export default async () => (await import("./x.js")).y;`,
      `const x = require("x"); export default () => x;`,
    ]) {
      expect(buildProducer(source).ok, source).toBe(false);
      const out = await extensionHost(env).runProducer(run(source));
      expect(out.ok, source).toBe(false);
      expect(out.error?.code, source).toBe("build");
    }
  });

  it("may mention the word import in its strings", () => {
    expect(buildProducer("export default () => `import done`;").ok).toBe(true);
  });

  it("reports a script that throws, or never finishes", async () => {
    const thrown = await extensionHost(env).runProducer(
      run(`export default async () => { throw new Error("boom"); };`),
    );
    expect(thrown).toMatchObject({ ok: false, error: { code: "script_error", message: "boom" } });
    const slow = await extensionHost(env, { codeTimeoutMs: 50 }).runProducer(
      run(`export default () => new Promise((resolve) => setTimeout(resolve, 5000));`),
    );
    expect(slow).toMatchObject({ ok: false, error: { code: "timeout" } });
  });
});

describe("what a producer may do", () => {
  it("reads as the viewer", async () => {
    const result = await extensionHost(env).runProducer(
      run(`export default async (_, { crm }) => crm.call("task.listMine", {});`),
    );
    expect(result.ok).toBe(true);
    expect((result.value as { counts: unknown }).counts).toBeDefined();
  });

  it("cannot write, delete or send, even as an admin", async () => {
    const person = await call<{ id: string }>(admin, "person.create", { givenName: "Keep" });
    for (const [operation, input] of [
      ["task.create", { title: "No" }],
      ["person.delete", { id: person.id }],
      ["code.run", { code: "export default 1" }],
      ["a2ui.produce", { producer: "tasks.overdueCard" }],
      ["x.deals.stageMetrics", { pipelineId: "x" }],
    ] as const) {
      const result = await extensionHost(env).runProducer(
        run(
          `export default async (input, { crm }) => crm.call(${JSON.stringify(operation)}, input);`,
          { input },
        ),
      );
      expect(result.ok, operation).toBe(false);
      expect(result.error?.code, operation).toBe("forbidden");
    }
    const after = await call<{ deletedAt: string | null }>(admin, "person.get", { id: person.id });
    expect(after.deletedAt).toBeNull();
  });

  it("stops at the call limit", async () => {
    const result = await extensionHost(env).runProducer(
      run(`export default async (_, { crm }) => {
        for (let i = 0; i < 200; i++) await crm.call("task.listMine", {});
      };`),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "limit" } });
  });

  it("keeps two viewers apart on one warm worker, however they overlap", async () => {
    const other = await createAdmin();
    const title = unique("Only mine ");
    await call(admin, "task.create", { title, assigneeId: admin.id, dueAt: "2020-01-06" });
    const source = `export default async (input, { crm }) => {
      await new Promise((resolve) => setTimeout(resolve, input.wait));
      const mine = await crm.call("task.listMine", {});
      return mine.buckets.overdue.map((task) => task.title);
    };`;
    const ref = `test.${unique("two")}@1`;
    const host = extensionHost(env);
    const [a, b] = await Promise.all([
      host.runProducer(run(source, { ref, input: { wait: 30 } })),
      host.runProducer(run(source, { ref, input: { wait: 1 }, caller: caller(other) })),
    ]);
    expect(a.workerId).toBe(b.workerId);
    expect(a.value).toContain(title);
    expect(b.value).not.toContain(title);
  });
});

describe("the first-party producers", () => {
  it("draw the viewer's overdue tasks, with no model", async () => {
    const title = unique("Chase NDA ");
    const person = await call<{ id: string }>(admin, "person.create", { givenName: "Ada" });
    await call(admin, "task.create", {
      title,
      assigneeId: admin.id,
      dueAt: "2020-01-06",
      links: [{ object: "person", id: person.id }],
    });
    const producer = first("tasks.overdueCard");
    const result = await extensionHost(env).runProducer(
      run(producer.source, { ref: producerRef(producer), input: { limit: 20 } }),
    );
    expect(result.error).toBeUndefined();
    const part = prepareCard(result.value, { source: "producer" });
    expect(part.problems).toBeUndefined();
    expect(part.document?.root.type).toBe("taskList");
    expect(part.fallback).toContain(title);
    expect(part.fallback).toContain("overdue");
    expect(part.fallback).toContain("Ada");
  });

  it("say so when nothing is overdue", async () => {
    const producer = first("tasks.overdueCard");
    const fresh = await createAdmin();
    const result = await extensionHost(env).runProducer(
      run(producer.source, {
        ref: producerRef(producer),
        input: { limit: 20 },
        caller: caller(fresh),
      }),
    );
    const part = prepareCard(result.value, { source: "producer" });
    expect(part.document?.root.type).toBe("emptyState");
    expect(part.fallback).toContain("Nothing overdue");
  });

  it("run through a2ui.produce with the real host", async () => {
    const out = (await invokeByName(
      "a2ui.produce",
      { producer: "tasks.overdueCard" },
      context(admin),
    )) as { part: { document: unknown; source: string; producer: string } };
    expect(out.part).toMatchObject({ source: "producer", producer: "tasks.overdueCard@1" });
    expect(out.part.document).not.toBeNull();
  });

  it("find deals with no activity for N days", async () => {
    const producer = first("pipeline.staleDealsCard");
    const deals = await call<{ columns: string[] }>(admin, "query.sql", {
      sql: "SELECT id FROM crm_x_deals_deal LIMIT 1",
    }).catch(() => null);
    const result = await extensionHost(env).runProducer(
      run(producer.source, {
        ref: producerRef(producer),
        input: { days: 14, limit: 20 },
      }),
    );
    if (!deals) {
      // No Deals extension installed in this database: the query fails and the card says so.
      expect(result.ok).toBe(false);
      return;
    }
    expect(result.error).toBeUndefined();
    const part = prepareCard(result.value, { source: "producer" });
    expect(part.problems).toBeUndefined();
    expect(["dealList", "emptyState"]).toContain(part.document?.root.type);
  });
});
