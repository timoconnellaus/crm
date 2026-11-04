// The deploy engine and the update procedure against the fake Cloudflare API: switching
// Workers together, a failing migration restoring the bookmark, a failed smoke check redeploying
// the previous release, and preflight.
import { describe, expect, it } from "vitest";
import {
  CloudflareClient,
  d1ApiMigrations,
  type DeploymentState,
  deployWorkers,
  applyBundleMigrations,
  neededResources,
  openBundle,
  preflight,
  provisionResources,
  readDeploymentState,
  runUpdate,
  writeDeploymentState,
} from "../src/index.ts";
import { buildFixtureRelease, FakeCloudflare } from "../src/testing/index.ts";
import { nodeSqliteEngine } from "../src/testing/node-sqlite.ts";

const ACCOUNT = "acc0000000000000000000000000test";

async function setup(version = "1.0.0") {
  const cf = new FakeCloudflare({ token: "t", accountId: ACCOUNT, sql: nodeSqliteEngine });
  const api = new CloudflareClient({ token: "t", apiBase: "https://cf.test/client/v4", fetch: cf.fetch });
  const bundle = await openBundle((await buildFixtureRelease({ version })).bundle);
  const resources = await provisionResources(api, ACCOUNT, neededResources(bundle.manifest, []));
  const databaseId = resources["D1_ID(crm)"] as string;
  await applyBundleMigrations(bundle, d1ApiMigrations(api, ACCOUNT, databaseId));
  const state: DeploymentState = {
    version,
    accountId: ACCOUNT,
    hostname: "crm-app.example.workers.dev",
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
    secrets: { "crm-app": { BETTER_AUTH_SECRET: "x".repeat(64) } },
  });
  return { cf, api, bundle, state, databaseId };
}

const rows = async (api: CloudflareClient, db: string, sql: string) =>
  (await api.queryD1(ACCOUNT, db, sql))[0]?.results ?? [];

describe("deploy engine", () => {
  it("installs every required Worker, keeps secrets and enables workers.dev for the app", async () => {
    const { cf } = await setup();
    expect([...cf.scripts.keys()].sort()).toEqual(["crm-app", "crm-runner"]);
    expect(cf.scripts.get("crm-app")?.secrets.get("BETTER_AUTH_SECRET")).toHaveLength(64);
    expect(cf.scripts.get("crm-app")?.workersDev).toBe(true);
    expect(cf.scripts.get("crm-runner")?.workersDev).toBe(false);
    expect(cf.scripts.get("crm-runner")?.migrationTag).toBe("v1");
    expect(cf.liveBinding("crm-app", "CRM_ACCOUNT_ID")?.text).toBe(ACCOUNT);
    expect(cf.liveBinding("crm-runner", "APP_ORIGIN")?.text).toBe(
      "https://crm-app.example.workers.dev",
    );
  });

  it("upgrades: migrations, then all Workers switch to the new versions", async () => {
    const { cf, api, state, databaseId, bundle } = await setup();
    await api.queryD1(ACCOUNT, databaseId, "INSERT INTO core_person (id, name) VALUES ('p1', 'Ada')");
    const target = await openBundle(
      (
        await buildFixtureRelease({
          version: "1.1.0",
          migrations: [["0161_more.sql", "ALTER TABLE core_person ADD COLUMN note TEXT;"]],
          runnerMigrations: [{ tag: "v2", new_sqlite_classes: ["Other"] }],
        })
      ).bundle,
    );
    const steps: string[] = [];
    const outcome = await runUpdate({
      api,
      state,
      databaseId,
      target,
      previous: async () => bundle,
      migrations: d1ApiMigrations(api, ACCOUNT, databaseId),
      smoke: async () => {},
      onStep: (s) => {
        steps.push(s);
      },
    });
    expect(outcome.status).toBe("succeeded");
    expect(outcome.migrations).toEqual(["0161_more.sql"]);
    expect(steps).toEqual(["pause", "bookmark", "migrate", "switch", "smoke", "resume", "done"]);
    expect(cf.liveBinding("crm-app", "CRM_RELEASE_VERSION")?.text).toBe("1.1.0");
    expect(cf.scripts.get("crm-runner")?.migrationTag).toBe("v2");
    expect((await readDeploymentState(api, ACCOUNT, databaseId))?.version).toBe("1.1.0");
    expect(await rows(api, databaseId, "SELECT name FROM core_person")).toEqual([{ name: "Ada" }]);
  });

  it("a failing migration restores the bookmark and leaves the Workers alone", async () => {
    const { cf, api, state, databaseId, bundle } = await setup();
    await api.queryD1(ACCOUNT, databaseId, "INSERT INTO core_person (id, name) VALUES ('p1', 'Ada')");
    const live = cf.scripts.get("crm-app")?.current;
    const target = await openBundle(
      (
        await buildFixtureRelease({
          version: "1.1.0",
          migrations: [
            ["0161_ok.sql", "DELETE FROM core_person;"],
            ["0162_bad.sql", "ALTER TABLE no_such_table ADD COLUMN x TEXT;"],
          ],
        })
      ).bundle,
    );
    const outcome = await runUpdate({
      api,
      state,
      databaseId,
      target,
      previous: async () => bundle,
      migrations: d1ApiMigrations(api, ACCOUNT, databaseId),
      smoke: async () => {},
    });
    expect(outcome.status).toBe("rolled_back");
    expect(outcome.error).toMatch(/no_such_table/);
    expect(cf.scripts.get("crm-app")?.current).toBe(live);
    expect(await rows(api, databaseId, "SELECT name FROM core_person")).toEqual([{ name: "Ada" }]);
    expect(
      (await rows(api, databaseId, "SELECT name FROM core_migrations")).map((r) => r.name),
    ).not.toContain("0161_ok.sql");
  });

  it("a failed smoke check redeploys the previous release and restores data", async () => {
    const { cf, api, state, databaseId, bundle } = await setup();
    const target = await openBundle(
      (
        await buildFixtureRelease({
          version: "1.1.0",
          migrations: [["0161_wipe.sql", "DELETE FROM core_person;"]],
        })
      ).bundle,
    );
    await api.queryD1(ACCOUNT, databaseId, "INSERT INTO core_person (id, name) VALUES ('p1', 'Ada')");
    const outcome = await runUpdate({
      api,
      state,
      databaseId,
      target,
      previous: async () => bundle,
      migrations: d1ApiMigrations(api, ACCOUNT, databaseId),
      smoke: async () => {
        throw new Error("health says no");
      },
    });
    expect(outcome.status).toBe("rolled_back");
    expect(cf.liveBinding("crm-app", "CRM_RELEASE_VERSION")?.text).toBe("1.0.0");
    expect(await rows(api, databaseId, "SELECT name FROM core_person")).toEqual([{ name: "Ada" }]);
    expect((await readDeploymentState(api, ACCOUNT, databaseId))?.version).toBe("1.0.0");
  });
});

describe("preflight", () => {
  it("blocks an update that would break an active runtime extension, and says why", async () => {
    const current = (await buildFixtureRelease({ version: "1.0.0" })).manifest;
    const target = (
      await buildFixtureRelease({ version: "2.0.0", contract: { version: 2, supported: [2] } })
    ).manifest;
    const result = preflight({
      currentVersion: "1.0.0",
      current,
      target,
      appliedMigrations: current.migrations.map((m) => m.name),
      extensions: [
        { id: "deals", source: "shipped", status: "active", contractVersion: 1 },
        { id: "scoring", source: "runtime", status: "active", contractVersion: 1 },
      ],
      installedGatekeepers: [],
    });
    expect(result.ok).toBe(false);
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0]?.code).toBe("extension_incompatible");
    expect(result.blockers[0]?.message).toMatch(/"scoring".*contract 1.*contracts 2/);
  });

  it("lists migrations, gatekeeper changes and new secrets", async () => {
    const current = (await buildFixtureRelease({ version: "1.0.0" })).manifest;
    const target = (
      await buildFixtureRelease({
        version: "1.1.0",
        migrations: [["0161_x.sql", "SELECT 1;"]],
        gatekeeperRevision: 2,
        appSecrets: [{ name: "NEW_KEY", required: true, source: "user" }],
      })
    ).manifest;
    const result = preflight({
      currentVersion: "1.0.0",
      current,
      target,
      appliedMigrations: current.migrations.map((m) => m.name),
      extensions: [],
      installedGatekeepers: ["crm-gatekeeper-test"],
      secretsSet: { "crm-app": ["BETTER_AUTH_SECRET"], "crm-gatekeeper-test": ["CLIENT_SECRET"] },
    });
    expect(result.migrations).toEqual(["0161_x.sql"]);
    expect(result.gatekeepers.changed).toEqual(["crm-gatekeeper-test"]);
    expect(result.secrets).toContainEqual({
      worker: "crm-app",
      name: "NEW_KEY",
      required: true,
      set: false,
    });
    expect(result.blockers.map((b) => b.code)).toEqual(["missing_secret"]);
  });

  it("refuses a downgrade and a database newer than the release", async () => {
    const current = (await buildFixtureRelease({ version: "1.1.0" })).manifest;
    const target = (await buildFixtureRelease({ version: "1.0.0" })).manifest;
    const result = preflight({
      currentVersion: "1.1.0",
      current,
      target,
      appliedMigrations: [...current.migrations.map((m) => m.name), "0170_future.sql"],
      extensions: [],
      installedGatekeepers: [],
    });
    expect(result.blockers.map((b) => b.code).sort()).toEqual(["database_newer", "not_newer"]);
  });
});
