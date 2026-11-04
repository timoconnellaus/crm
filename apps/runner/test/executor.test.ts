// The executor (ADR 0043): stable loader ids for repeat code, load() only for Code Mode, no run
// state left in a reused worker, deadlines, the build/check cache by content hash, and Code Mode's
// write permission, per-user concurrency and rate limit.
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type ExtensionHost,
  type InvocationContext,
  invokeByName,
  memoryRateLimit,
  PERMISSIONS,
  withCodeModeRateLimit,
} from "@crm/core";
import { beforeAll, describe, expect, it } from "vitest";
import { Executor } from "../src/executor/executor.ts";
import { checkerWorkerId, manifestWorkerId, toolWorkerId } from "../src/executor/worker-code.ts";
import { extensionHost } from "../src/index.ts";
import { context, createAdmin, extensionRow, install, source, unique } from "./helpers.ts";

/** A Worker Loader that records every get (with its id) and load. */
function countingLoader() {
  const gets: string[] = [];
  let loads = 0;
  const loader = {
    get(id: string | null, code: () => WorkerLoaderWorkerCode | Promise<WorkerLoaderWorkerCode>) {
      gets.push(String(id));
      return env.LOADER.get(id, code);
    },
    load(code: WorkerLoaderWorkerCode) {
      loads += 1;
      return env.LOADER.load(code);
    },
  };
  return {
    loader: loader as WorkerLoader,
    gets,
    loads: () => loads,
    reset() {
      gets.length = 0;
      loads = 0;
    },
  };
}

let admin: ActingUser;
beforeAll(async () => {
  admin = await createAdmin();
});

const newExtId = (prefix: string) => unique(prefix).slice(0, 24);

function callWith(host: ExtensionHost, user: ActingUser, name: string, input: unknown) {
  return invokeByName(name, input, context(user, { extensionHost: host }));
}

describe("stable loader ids", () => {
  it("are deterministic: same extension + commit + modules, same id; any change, a new one", async () => {
    const base = { extensionId: "proj", commit: "a".repeat(40), modules: ["crm", "log"] };
    const id = await toolWorkerId(base);
    expect(await toolWorkerId({ ...base, modules: ["log", "crm", "crm"] })).toBe(id);
    expect(await toolWorkerId({ ...base, commit: "b".repeat(40) })).not.toBe(id);
    expect(await toolWorkerId({ ...base, modules: ["crm"] })).not.toBe(id);
    expect(await toolWorkerId({ ...base, extensionId: "other" })).not.toBe(id);
    expect(id).toMatch(/^ext:proj:aaaaaaaaaaaa:[0-9a-f]{32}$/);
    const manifest = await manifestWorkerId({ extensionId: "proj", sourceHash: "abc" });
    expect(await manifestWorkerId({ extensionId: "proj", sourceHash: "abc" })).toBe(manifest);
    expect(await manifestWorkerId({ extensionId: "proj", sourceHash: "abd" })).not.toBe(manifest);
    expect(checkerWorkerId()).toMatch(/^tsc@\d+\.\d+\.\d+\+[0-9a-f]{16}$/);
  });

  it("tool runs use LOADER.get with the same id every run, never load()", async () => {
    const id = newExtId("sid");
    await install(
      admin,
      id,
      source(
        id,
        `tools: { ping: defineTool({ description: "Returns pong for the loader id test.", input: z.object({}), output: z.string(), handler: async () => "pong" }) },`,
      ),
    );
    const commit = (await extensionRow(id)).commit_oid;
    const counting = countingLoader();
    const host = extensionHost(env, { loader: counting.loader });
    for (let i = 0; i < 3; i++) {
      expect(await callWith(host, admin, `x.${id}.ping`, {})).toBe("pong");
    }
    const expected = await toolWorkerId({ extensionId: id, commit, modules: [] });
    expect(counting.gets).toEqual([expected, expected, expected]);
    expect(counting.loads()).toBe(0);
    console.log(`loader ids per tool run: 1 get(${expected}), 0 load()`);
  });

  it("Code Mode uses load() (throwaway code), not get()", async () => {
    const counting = countingLoader();
    const host = extensionHost(env, { loader: counting.loader });
    const result = await invokeByName(
      "code.run",
      { code: "export default 6 * 7;" },
      mcpContext(admin, host),
    );
    expect(result).toMatchObject({ ok: true, value: 42 });
    expect(counting.loads()).toBe(1);
    expect(counting.gets).toEqual([]);
  });
});

describe("a reused worker keeps no run state", () => {
  it("two runs on one warm worker do not stack patches, logs or context", async () => {
    const id = newExtId("leak");
    await install(
      admin,
      id,
      source(
        id,
        `permissions: { modules: ["log"] },
  tools: {
    probe: defineTool({
      description: "Reports module state and whether globals are the runtime's own.",
      input: z.object({ tag: z.string() }),
      output: z.unknown(),
      handler: async ({ tag }, ctx) => {
        runs += 1;
        ctx.log.info("run " + tag);
        const now = snapshot();
        // Each global is still the very object it was before any run: nothing re-wrapped them.
        return { runs, same: Object.keys(original).filter((k) => original[k] === now[k]).sort() };
      },
    }),
  },`,
        "1.0.0",
        `let runs = 0;
const g = globalThis as unknown as Record<string, unknown>;
const snapshot = (): Record<string, unknown> => ({
  dateNow: Date.now,
  date: g.Date,
  random: Math.random,
  setTimeout: g.setTimeout,
  setInterval: g.setInterval,
  fetch: g.fetch,
  log: (g.console as { log: unknown }).log,
  process: g.process,
});
const original = snapshot();`,
      ),
    );
    const host = extensionHost(env);
    const first = (await callWith(host, admin, `x.${id}.probe`, { tag: "one" })) as Record<
      string,
      unknown
    >;
    const second = (await callWith(host, admin, `x.${id}.probe`, { tag: "two" })) as Record<
      string,
      unknown
    >;
    const same = [
      "date",
      "dateNow",
      "fetch",
      "log",
      "process",
      "random",
      "setInterval",
      "setTimeout",
    ];
    expect(first).toEqual({ runs: 1, same });
    // The same isolate (module state carried over: same extension version, same principal), and
    // still nothing patched.
    expect(second).toEqual({ runs: 2, same });
    const runs = await env.DB.prepare(
      "SELECT logs FROM core_extension_runs WHERE extension_id = ? AND kind = 'tool' ORDER BY started_at, id",
    )
      .bind(id)
      .all<{ logs: string }>();
    expect(
      runs.results.map((r) => JSON.parse(r.logs).map((l: { message: string }) => l.message)),
    ).toEqual([["run one"], ["run two"]]);
  });

  it("concurrent runs on one worker each keep their own logs", async () => {
    const id = newExtId("conc");
    await install(
      admin,
      id,
      source(
        id,
        `permissions: { modules: ["log"] },
  tools: {
    slow: defineTool({
      description: "Logs its tag, waits, logs it again.",
      input: z.object({ tag: z.string() }),
      output: z.string(),
      handler: async ({ tag }, ctx) => {
        ctx.log.info("start " + tag);
        const wait = (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => void }).setTimeout;
        await new Promise<void>((resolve) => wait(resolve, 30));
        ctx.log.info("end " + tag);
        return tag;
      },
    }),
  },`,
      ),
    );
    const host = extensionHost(env);
    const tags = ["a", "b", "c", "d"];
    expect(
      await Promise.all(tags.map((tag) => callWith(host, admin, `x.${id}.slow`, { tag }))),
    ).toEqual(tags);
    const runs = await env.DB.prepare(
      "SELECT logs FROM core_extension_runs WHERE extension_id = ? AND kind = 'tool'",
    )
      .bind(id)
      .all<{ logs: string }>();
    const logs = runs.results
      .map((r) => JSON.parse(r.logs).map((l: { message: string }) => l.message))
      .sort((a: string[], b: string[]) => a[0]?.localeCompare(b[0] ?? "") ?? 0);
    expect(logs).toEqual(tags.map((t) => [`start ${t}`, `end ${t}`]));
  });
});

describe("deadlines", () => {
  it("times a run out, and the host refuses its calls afterwards", async () => {
    const id = newExtId("late");
    await install(
      admin,
      id,
      source(
        id,
        `permissions: { modules: ["storage"] },
  tools: {
    late: defineTool({
      description: "Waits past the deadline, then tries to write storage.",
      input: z.object({}),
      output: z.unknown(),
      handler: async (_input, ctx) => {
        const wait = (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => void }).setTimeout;
        await new Promise<void>((resolve) => wait(resolve, 400));
        await ctx.storage.set("late", true);
        return "done";
      },
    }),
  },`,
      ),
    );
    const host = extensionHost(env, { toolTimeoutMs: 150 });
    await expect(callWith(host, admin, `x.${id}.late`, {})).rejects.toMatchObject({
      details: expect.objectContaining({ code: "timeout" }),
    });
    await scheduler.wait(600);
    const late = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_extension_kv WHERE extension_id = ? AND key = 'late'",
    )
      .bind(id)
      .first<{ n: number }>();
    expect(late?.n).toBe(0);
    const run = await env.DB.prepare(
      "SELECT outcome FROM core_extension_runs WHERE extension_id = ? AND kind = 'tool'",
    )
      .bind(id)
      .first<{ outcome: string }>();
    expect(run?.outcome).toBe("timeout");
  });
});

describe("the build and check cache", () => {
  it("is keyed by content hash: check then propose type-check once; the checker is reused", async () => {
    const id = newExtId("cache");
    const files = source(
      id,
      `tools: { one: defineTool({ description: "Returns one, for the build cache test.", input: z.object({}), output: z.number(), handler: async () => 1 }) },`,
    );
    const counting = countingLoader();
    const host = extensionHost(env, { loader: counting.loader });
    const checker = checkerWorkerId();
    const checks = () => counting.gets.filter((g) => g === checker).length;

    const timed = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
      const started = Date.now();
      const value = await fn();
      return [value, Date.now() - started];
    };
    const [first, firstMs] = await timed(() =>
      callWith(host, admin, "extension.check", { id, files }),
    );
    expect(first).toMatchObject({ ok: true });
    expect(checks()).toBe(1);
    const [, againMs] = await timed(() => callWith(host, admin, "extension.check", { id, files }));
    expect(checks()).toBe(1);
    // Write the same files and propose: the commit's source hash matches, so no new build.
    await callWith(host, admin, "extension.write", { id, files });
    const proposed = (await callWith(host, admin, "extension.propose", { id })) as {
      status: string;
    };
    expect(proposed.status).toBe("pending_approval");
    expect(checks()).toBe(1);
    // Check and propose evaluated the same source in the same manifest worker.
    const manifests = counting.gets.filter((g) => g.startsWith("manifest:"));
    expect(new Set(manifests).size).toBe(1);
    // A different source is built and checked again, by the same (warm) checker worker.
    const changed = { "index.ts": `${files["index.ts"]}\n// changed\n` };
    const [, warmMs] = await timed(() =>
      callWith(host, admin, "extension.check", { id, files: changed }),
    );
    expect(checks()).toBe(2);
    console.log(
      `extension.check: first (build + type check) ${firstMs} ms, cached ${againMs} ms, new source on a warm checker ${warmMs} ms`,
    );
  });
});

function mcpContext(
  user: ActingUser,
  host: ExtensionHost,
  grantedPermissions: readonly string[] = PERMISSIONS,
  sessionId = `cap_${unique()}`,
): InvocationContext {
  return context(user, {
    actor: "mcp",
    origin: { surface: "mcp", clientId: "test", clientName: "Test client", sessionId },
    grantedPermissions: grantedPermissions as InvocationContext["grantedPermissions"],
    extensionHost: host,
  });
}

describe("Code Mode limits", () => {
  it("needs records:write, not just read", async () => {
    await expect(
      invokeByName(
        "code.run",
        { code: "export default 1;" },
        mcpContext(admin, extensionHost(env), ["records:read"]),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("runs one script per user at a time", async () => {
    const user = await createAdmin();
    const other = await createAdmin();
    const host = extensionHost(env);
    const slow = `export default async () => {
  await new Promise((resolve) => setTimeout(resolve, 300));
  return "done";
};`;
    const results = await Promise.allSettled([
      invokeByName("code.run", { code: slow }, mcpContext(user, host)),
      invokeByName("code.run", { code: slow }, mcpContext(user, host)),
      // Another user is not affected.
      invokeByName("code.run", { code: slow }, mcpContext(other, host)),
    ]);
    const [a, b, c] = results;
    const mine = [a, b];
    expect(mine.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(mine.find((r) => r.status === "rejected")).toMatchObject({
      reason: expect.objectContaining({ code: "rate_limited" }),
    });
    expect(c).toMatchObject({ status: "fulfilled", value: { ok: true, value: "done" } });
    // Once it finished, the user can run again.
    await expect(
      invokeByName("code.run", { code: "export default 2;" }, mcpContext(user, host)),
    ).resolves.toMatchObject({ ok: true, value: 2 });
  });

  it("is rate limited per user", async () => {
    const user = await createAdmin();
    const other = await createAdmin();
    const limit = memoryRateLimit(2);
    const host = withCodeModeRateLimit(extensionHost(env), limit);
    for (let i = 0; i < 2; i++) {
      await expect(
        invokeByName("code.run", { code: "export default 1;" }, mcpContext(user, host)),
      ).resolves.toMatchObject({ ok: true });
    }
    await expect(
      invokeByName("code.run", { code: "export default 1;" }, mcpContext(user, host)),
    ).rejects.toMatchObject({ code: "rate_limited" });
    await expect(
      invokeByName("code.run", { code: "export default 1;" }, mcpContext(other, host)),
    ).resolves.toMatchObject({ ok: true });
    expect(limit.hits(`code:${user.id}`)).toBe(3);
  });
});

describe("proposal summaries", () => {
  it("are cached by (extension, commit, base), and run outside the workspace DO", async () => {
    let calls = 0;
    const ai = {
      async run() {
        calls += 1;
        return { response: `summary ${calls}` };
      },
    };
    const executor = new Executor({ ...env, AI: ai } as unknown as Env);
    const id = newExtId("sum");
    const input = { id, commit: "c".repeat(40), base: null, prompt: "Describe it" };
    const first = await executor.describeChange(input);
    expect(first).toMatchObject({ text: "summary 1" });
    expect(await executor.describeChange(input)).toEqual(first);
    expect(calls).toBe(1);
    await executor.describeChange({ ...input, base: "b".repeat(40) });
    expect(calls).toBe(2);
  });
});
