// The self-updater's runtime in workerd (ADR 0164) against a fake GitHub and a fake Cloudflare
// API: it refuses a tampered bundle (AC2), lists releases per channel (AC7), and runs a verified
// update through the same procedure as `ros upgrade`.
import { env } from "cloudflare:workers";
import {
  applyBundleMigrations,
  CloudflareClient,
  type DeploymentState,
  d1ApiMigrations,
  deployWorkers,
  neededResources,
  openBundle,
  provisionResources,
  type RunRecord,
  writeDeploymentState,
} from "@relationship-os/release";
import {
  buildFixtureRelease,
  FakeCloudflare,
  FakeGitHub,
  type SqlEngine,
} from "@relationship-os/release/testing";
import { describe, expect, it } from "vitest";
import { updaterRuntimeFor } from "../src/server/updater.ts";

const ACCOUNT = "acc000000000000000000000000000up";
const TOKEN = "update-token-for-tests";

/** A SqlEngine over a real D1 binding; bookmarks replay a log of writes (fixture SQL only). */
function d1Engine(db: D1Database): SqlEngine {
  const log: { sql: string; params: unknown[] }[] = [];
  const run = async (sql: string, params: unknown[]) => {
    const single = !sql.trim().replace(/;\s*$/, "").includes(";");
    if (single)
      return (
        await db
          .prepare(sql)
          .bind(...params)
          .all()
      ).results as Record<string, unknown>[];
    await db.exec(sql.replace(/\n/g, " ").replace(/;\s*/g, ";\n"));
    return [];
  };
  return {
    async query(sql, params) {
      const rows = await run(sql, params);
      if (!/^\s*select/i.test(sql)) log.push({ sql, params });
      return rows;
    },
    async bookmark() {
      return `bm-${log.length}`;
    },
    async restore(bookmark) {
      const at = Number(bookmark.slice(3));
      const tables = await db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
        )
        .all<{ name: string }>();
      for (const t of tables.results) await db.prepare(`DROP TABLE "${t.name}"`).run();
      const keep = log.splice(0, at);
      log.length = 0;
      for (const entry of keep) {
        await run(entry.sql, entry.params);
        log.push(entry);
      }
    },
  };
}

async function world() {
  const cf = new FakeCloudflare({
    token: TOKEN,
    accountId: ACCOUNT,
    sql: () => d1Engine(env.UPDATER_FAKE_D1),
  });
  const github = new FakeGitHub();
  const api = new CloudflareClient({
    token: TOKEN,
    apiBase: "https://cf.test/client/v4",
    fetch: cf.fetch,
  });
  const runtime = (version = "1.0.0") =>
    updaterRuntimeFor(
      {
        DB: env.DB,
        ROS_RELEASE_VERSION: version,
        ROS_ACCOUNT_ID: ACCOUNT,
        ROS_UPDATE_TOKEN: TOKEN,
      },
      {
        githubApi: github.api,
        githubFetch: github.fetch,
        cloudflareApi: "https://cf.test/client/v4",
        cloudflareFetch: cf.fetch,
        smoke: async () => {},
      },
    );
  return { cf, github, api, runtime };
}

function runRecord(from: string, to: string): RunRecord {
  return {
    id: `upd_${to}`,
    kind: "update",
    from_version: from,
    to_version: to,
    status: "running",
    step: null,
    bookmark: null,
    bundle_digest: null,
    preflight: null,
    error: null,
    started_by: null,
    surface: "ui",
    started_at: new Date().toISOString(),
    finished_at: null,
  };
}

const noAutomations = { pause: async () => {}, resume: async () => {} };

describe("self-updater runtime", () => {
  it("can update only with a token, an account and a release version", () => {
    expect(updaterRuntimeFor({ DB: env.DB, ROS_RELEASE_VERSION: "" }).canUpdate).toBe(false);
    expect(
      updaterRuntimeFor({ DB: env.DB, ROS_RELEASE_VERSION: "1.0.0", ROS_ACCOUNT_ID: ACCOUNT })
        .canUpdate,
    ).toBe(false);
    expect(
      updaterRuntimeFor({
        DB: env.DB,
        ROS_RELEASE_VERSION: "1.0.0",
        ROS_ACCOUNT_ID: ACCOUNT,
        ROS_UPDATE_TOKEN: TOKEN,
      }).canUpdate,
    ).toBe(true);
  });

  it("lists releases per channel: stable never sees betas", async () => {
    const { github, runtime } = await world();
    await github.publish(await buildFixtureRelease({ version: "1.0.0" }));
    await github.publish(await buildFixtureRelease({ version: "1.1.0-beta.1" }));
    expect((await runtime().listReleases("stable")).map((r) => r.version)).toEqual(["1.0.0"]);
    expect((await runtime().listReleases("beta")).map((r) => r.version)).toEqual([
      "1.1.0-beta.1",
      "1.0.0",
    ]);
  });

  it("refuses a tampered bundle and changes nothing", async () => {
    const { cf, github, runtime } = await world();
    const genuine = await buildFixtureRelease({ version: "1.1.0" });
    const evil = await buildFixtureRelease({ version: "1.1.0", gatekeeperRevision: 13 });
    await github.publish(genuine, { tamper: { bytes: evil.bundle, rewriteSums: true } });
    const records: RunRecord[] = [];
    const outcome = await runtime().apply({
      version: "1.1.0",
      state: {} as DeploymentState,
      run: runRecord("1.0.0", "1.1.0"),
      record: async (r) => {
        records.push(r);
      },
      automations: noAutomations,
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toMatch(/failed verification/);
    expect(records.at(-1)).toMatchObject({ status: "failed", step: "verify" });
    expect(cf.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("verifies and applies an update, switching every Worker", async () => {
    const { cf, github, api, runtime } = await world();
    const v1 = await buildFixtureRelease({ version: "1.0.0" });
    const v2 = await buildFixtureRelease({
      version: "1.1.0",
      migrations: [["0161_more.sql", "CREATE TABLE core_more (id TEXT);"]],
    });
    await github.publish(v1);
    await github.publish(v2);
    // Install 1.0.0 into the fake account.
    const bundle = await openBundle(v1.bundle);
    const resources = await provisionResources(api, ACCOUNT, neededResources(bundle.manifest, []));
    const databaseId = resources["D1_ID(ros)"] as string;
    await applyBundleMigrations(bundle, d1ApiMigrations(api, ACCOUNT, databaseId));
    const state: DeploymentState = {
      version: "1.0.0",
      accountId: ACCOUNT,
      hostname: "ros-app.example.workers.dev",
      hostnameMode: "workers.dev",
      identityProvider: "better-auth",
      channel: "stable",
      gatekeepers: [],
      workerNames: {},
      vars: {},
      resources,
    };
    await writeDeploymentState(api, databaseId, state);
    await deployWorkers({
      api,
      bundle,
      state,
      secrets: { "ros-app": { BETTER_AUTH_SECRET: "s".repeat(64) } },
    });

    const steps: string[] = [];
    const outcome = await runtime().apply({
      version: "1.1.0",
      state,
      run: runRecord("1.0.0", "1.1.0"),
      record: async (r) => {
        if (r.step) steps.push(r.step);
      },
      automations: noAutomations,
    });
    expect(outcome).toMatchObject({ status: "succeeded", migrations: ["0161_more.sql"] });
    expect(steps).toEqual(["pause", "bookmark", "migrate", "switch", "smoke", "resume", "done"]);
    expect(cf.liveBinding("ros-app", "ROS_RELEASE_VERSION")?.text).toBe("1.1.0");
    expect(cf.liveBinding("ros-runner", "DB")).toBeTruthy();
    expect(cf.scripts.get("ros-app")?.secrets.get("BETTER_AUTH_SECRET")).toHaveLength(64);
    // AI is on, so the update set up the AI Gateway the install lacked (ADR 0180).
    expect(cf.gateways.get("ros")).toMatchObject({ authentication: true, collect_logs: true });
    expect([...cf.customProviders.values()].map((p) => p.slug)).toEqual(["example-llm"]);
    expect(cf.liveBinding("ros-app", "AI_GATEWAY_ID")?.text).toBe("ros");
    const token = [...cf.tokens.values()][0]?.value;
    expect(token).toBeTruthy();
    expect(cf.scripts.get("ros-runner")?.secrets.get("AI_GATEWAY_TOKEN")).toBe(token);
    // ADR 0330: the token can call Workers AI, so Workers AI goes over REST, payload logging off.
    expect([...cf.tokens.values()][0]?.permissionGroups).toEqual(["pg-aig-run", "pg-wai-read"]);
    expect(cf.liveBinding("ros-runner", "AI_GATEWAY_REST")?.text).toBe("true");
  });

  it("replaces a gateway token generated before ADR 0330 and turns on Workers AI over REST", async () => {
    const { cf, github, api, runtime } = await world();
    const v1 = await buildFixtureRelease({ version: "1.0.0" });
    const v2 = await buildFixtureRelease({ version: "1.1.0" });
    await github.publish(v1);
    await github.publish(v2);
    const bundle = await openBundle(v1.bundle);
    const resources = await provisionResources(api, ACCOUNT, neededResources(bundle.manifest, []));
    const databaseId = resources["D1_ID(ros)"] as string;
    await applyBundleMigrations(bundle, d1ApiMigrations(api, ACCOUNT, databaseId));
    // An install from before: a generated token with AI Gateway Run only, on both Workers.
    const old = await api.createAccountToken(ACCOUNT, "ros AI Gateway (Relationship OS)", [
      "pg-aig-run",
    ]);
    const state: DeploymentState = {
      version: "1.0.0",
      accountId: ACCOUNT,
      hostname: "ros-app.example.workers.dev",
      hostnameMode: "workers.dev",
      identityProvider: "better-auth",
      channel: "stable",
      gatekeepers: [],
      workerNames: {},
      aiGateway: "ros",
      aiGatewayTokenId: old.id,
      vars: { "ros-app": { AI_GATEWAY_ID: "ros" }, "ros-runner": { AI_GATEWAY_ID: "ros" } },
      resources,
    };
    await writeDeploymentState(api, databaseId, state);
    await deployWorkers({
      api,
      bundle,
      state,
      secrets: {
        "ros-app": { BETTER_AUTH_SECRET: "s".repeat(64), AI_GATEWAY_TOKEN: old.value },
        "ros-runner": { AI_GATEWAY_TOKEN: old.value },
      },
    });
    expect(cf.liveBinding("ros-app", "AI_GATEWAY_REST")?.text).toBe("");

    const outcome = await runtime().apply({
      version: "1.1.0",
      state,
      run: runRecord("1.0.0", "1.1.0"),
      record: async () => {},
      automations: noAutomations,
    });
    expect(outcome).toMatchObject({ status: "succeeded" });
    expect(cf.tokens.has(old.id)).toBe(false);
    const [token] = [...cf.tokens.values()];
    expect(token?.permissionGroups).toEqual(["pg-aig-run", "pg-wai-read"]);
    for (const worker of ["ros-app", "ros-runner"]) {
      expect(cf.scripts.get(worker)?.secrets.get("AI_GATEWAY_TOKEN")).toBe(token?.value);
      expect(cf.liveBinding(worker, "AI_GATEWAY_REST")?.text).toBe("true");
    }
  });
});
