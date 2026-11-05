// Hosted deployments (ADR 0210): the same engine installs and updates a deployment whose Workers
// are user Workers in a Workers for Platforms dispatch namespace, with per-tenant names.
import { describe, expect, it } from "vitest";
import {
  CloudflareClient,
  type DeploymentState,
  installRelease,
  openBundle,
  runUpdate,
} from "../src/index.ts";
import { buildFixtureRelease, FakeCloudflare } from "../src/testing/index.ts";
import { nodeSqliteEngine } from "../src/testing/node-sqlite.ts";

const ACCOUNT = "acc0000000000000000000000000test";
const NS = "ros-customers";

function tenantState(tenant: string, version: string): DeploymentState {
  return {
    version,
    accountId: ACCOUNT,
    hostname: `${tenant}.relationshiposcrm.com`,
    hostnameMode: "dispatch",
    dispatchNamespace: NS,
    tags: [`tenant-${tenant}`],
    identityProvider: "better-auth",
    channel: "stable",
    gatekeepers: [],
    workerNames: { "ros-app": `${tenant}-ros-app`, "ros-runner": `${tenant}-ros-runner` },
    resourceNames: {
      ros: `ros-${tenant}`,
      "ros-blobs": `ros-blobs-${tenant}`,
      "ros-app-oauth-kv": `ros-app-oauth-kv-${tenant}`,
    },
    vars: {},
    resources: {},
  };
}

async function setup() {
  const cf = new FakeCloudflare({ token: "t", accountId: ACCOUNT, sql: nodeSqliteEngine });
  cf.namespaces.set(NS, new Map());
  const api = new CloudflareClient({
    token: "t",
    apiBase: "https://cf.test/client/v4",
    fetch: cf.fetch,
  });
  return { cf, api };
}

describe("installing into a dispatch namespace", () => {
  it("creates per-tenant resources and tagged user Workers, with no account scripts or crons", async () => {
    const { cf, api } = await setup();
    const bundle = await openBundle((await buildFixtureRelease({ version: "1.0.0" })).bundle);
    for (const tenant of ["acme", "globex"]) {
      await installRelease({
        api,
        bundle,
        state: tenantState(tenant, "1.0.0"),
        secrets: { "ros-app": { BETTER_AUTH_SECRET: "s".repeat(64) } },
      });
    }
    expect(cf.scripts.size).toBe(0);
    const ns = cf.namespaces.get(NS);
    expect([...(ns?.keys() ?? [])].sort()).toEqual([
      "acme-ros-app",
      "acme-ros-runner",
      "globex-ros-app",
      "globex-ros-runner",
    ]);
    const app = cf.userWorker(NS, "acme-ros-app");
    expect(app?.tags).toEqual(["tenant-acme"]);
    expect(app?.secrets.get("BETTER_AUTH_SECRET")).toHaveLength(64);
    // Each tenant has its own database; nothing is shared.
    const dbs = [...cf.d1.values()].map((d) => d.name).sort();
    expect(dbs).toEqual(["ros-acme", "ros-globex"]);
    const bindings = app?.metadata.bindings as { name: string; service?: string; id?: string }[];
    expect(bindings.find((b) => b.name === "RUNNER")?.service).toBe("acme-ros-runner");
    // No version, schedule or workers.dev calls were made for user Workers.
    expect(cf.calls.some((c) => /\/(versions|schedules|subdomain)$/.test(c.path))).toBe(false);
  });

  it("updates a namespaced tenant and rolls back a failed smoke check", async () => {
    const { cf, api } = await setup();
    const v1 = await openBundle((await buildFixtureRelease({ version: "1.0.0" })).bundle);
    const v2 = await openBundle((await buildFixtureRelease({ version: "1.1.0" })).bundle);
    const installed = await installRelease({
      api,
      bundle: v1,
      state: tenantState("acme", "1.0.0"),
      secrets: { "ros-app": { BETTER_AUTH_SECRET: "s".repeat(64) } },
    });
    const version = () =>
      (
        (cf.userWorker(NS, "acme-ros-app")?.metadata.bindings ?? []) as {
          name: string;
          text?: string;
        }[]
      ).find((b) => b.name === "ROS_RELEASE_VERSION")?.text;

    const failed = await runUpdate({
      api,
      state: installed.state,
      databaseId: installed.databaseId,
      target: v2,
      previous: async () => v1,
      migrations: {
        applied: async () => [],
        apply: async () => {},
      },
      smoke: async () => {
        throw new Error("unhealthy");
      },
    });
    expect(failed.status).toBe("rolled_back");
    expect(version()).toBe("1.0.0");

    const ok = await runUpdate({
      api,
      state: installed.state,
      databaseId: installed.databaseId,
      target: v2,
      previous: async () => v1,
      migrations: { applied: async () => [], apply: async () => {} },
      smoke: async () => {},
    });
    expect(ok.status).toBe("succeeded");
    expect(version()).toBe("1.1.0");
  });
});
