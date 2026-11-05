// Installs from before the rename to Relationship OS (ADR 0190): an install made by a `crm`
// release (Workers crm-*, database crm, resources crm-*, AI Gateway crm) is updated to a renamed
// release in place. Nothing new is created, nothing is renamed, and a rollback redeploys the old
// release onto the same Workers.
import { describe, expect, it } from "vitest";
import {
  adoptLegacyNames,
  applyBundleMigrations,
  CloudflareClient,
  type DeploymentState,
  d1ApiMigrations,
  deployWorkers,
  isLegacyState,
  locateDeployment,
  neededResources,
  openBundle,
  parseManifest,
  provisionAiGateway,
  provisionResources,
  readDeploymentState,
  runUpdate,
  sameRepository,
  verifyBundleBytes,
  writeDeploymentState,
} from "../src/index.ts";
import { buildFixtureRelease, FakeCloudflare } from "../src/testing/index.ts";
import { nodeSqliteEngine } from "../src/testing/node-sqlite.ts";

const ACCOUNT = "acc00000000000000000000000legacy";

/** What a pre-rename `create-crm` left behind: the old names everywhere, the gatekeeper on. */
async function legacyInstall() {
  const cf = new FakeCloudflare({ token: "t", accountId: ACCOUNT, sql: nodeSqliteEngine });
  const api = new CloudflareClient({
    token: "t",
    apiBase: "https://cf.test/client/v4",
    fetch: cf.fetch,
  });
  const fixture = await buildFixtureRelease({ version: "1.0.0", legacy: true });
  const bundle = await openBundle(fixture.bundle);
  const gatekeepers = ["crm-gatekeeper-test"];
  const resources = await provisionResources(
    api,
    ACCOUNT,
    neededResources(bundle.manifest, gatekeepers),
  );
  const databaseId = resources["D1_ID(crm)"] as string;
  await applyBundleMigrations(bundle, d1ApiMigrations(api, ACCOUNT, databaseId));
  const base: DeploymentState = {
    version: "1.0.0",
    accountId: ACCOUNT,
    hostname: "crm-app.example.workers.dev",
    hostnameMode: "workers.dev",
    identityProvider: "better-auth",
    channel: "stable",
    gatekeepers,
    workerNames: {},
    vars: { "crm-app": { IDENTITY_PROVIDER: "cloudflare-access" } },
    resources,
  };
  const gateway = await provisionAiGateway({ api, manifest: bundle.manifest, state: base });
  const state: DeploymentState = { ...base, vars: gateway.vars, ...gateway.state };
  await writeDeploymentState(api, databaseId, state);
  await deployWorkers({
    api,
    bundle,
    state,
    secrets: { "crm-app": { BETTER_AUTH_SECRET: "x".repeat(64), ...gateway.secrets["crm-app"] } },
  });
  return { cf, api, bundle, fixture, state, databaseId };
}

const renamed = async (version = "1.1.0") =>
  openBundle((await buildFixtureRelease({ version })).bundle);

/** Every name the fake account holds, across Workers and resources. */
function accountNames(cf: FakeCloudflare) {
  return [
    ...cf.scripts.keys(),
    ...[...cf.d1.values()].map((d) => d.name),
    ...cf.r2,
    ...[...cf.queues.values()].map((q) => q.name),
    ...cf.vectorize.keys(),
    ...cf.gateways.keys(),
  ].sort();
}

describe("a pre-rename install", () => {
  it("is found by its crm database", async () => {
    const { api, databaseId } = await legacyInstall();
    const located = await locateDeployment(api, ACCOUNT);
    expect(located?.databaseId).toBe(databaseId);
    expect(located?.state && isLegacyState(located.state)).toBe(true);
  });

  it("updates to a renamed release in place, keeping every deployed name", async () => {
    const { cf, api, bundle, state, databaseId } = await legacyInstall();
    const before = accountNames(cf);
    expect(before).toEqual(
      [
        "crm",
        "crm",
        "crm-app",
        "crm-automation-events",
        "crm-automation-events-dlq",
        "crm-blobs",
        "crm-gatekeeper-test",
        "crm-records",
        "crm-runner",
      ].sort(),
    );
    const outcome = await runUpdate({
      api,
      state,
      databaseId,
      target: await renamed(),
      previous: async () => bundle,
      migrations: d1ApiMigrations(api, ACCOUNT, databaseId),
      smoke: async () => {},
    });
    expect(outcome.status).toBe("succeeded");
    // Nothing created, nothing renamed: no ros-* Worker, database, bucket, queue, index or gateway.
    expect(accountNames(cf)).toEqual(before);
    expect(cf.liveBinding("crm-app", "ROS_RELEASE_VERSION")?.text).toBe("1.1.0");
    expect(cf.liveBinding("crm-app", "RUNNER")?.service).toBe("crm-runner");
    expect(cf.liveBinding("crm-app", "DB")?.database_id).toBe(databaseId);
    expect(cf.liveBinding("crm-app", "BLOBS")?.bucket_name).toBe("crm-blobs");
    expect(cf.liveBinding("crm-app", "AI_SECRET_SCRIPTS")?.text).toBe("crm-app,crm-runner");
    expect(cf.liveBinding("crm-app", "AI_GATEWAY_ID")?.text).toBe("crm");
    expect(cf.liveBinding("crm-app", "IDENTITY_PROVIDER")?.text).toBe("cloudflare-access");
    expect(cf.scripts.get("crm-app")?.secrets.get("BETTER_AUTH_SECRET")).toHaveLength(64);
    expect(cf.liveBinding("crm-runner", "AUTOMATION_WORKFLOW")?.workflow_name).toBe(
      "crm-automation",
    );
    expect(cf.liveBinding("crm-runner", "AUTOMATION_EVENTS")?.queue_name).toBe(
      "crm-automation-events",
    );
    expect(cf.liveBinding("crm-runner", "VECTORIZE")?.index_name).toBe("crm-records");
    expect(cf.liveBinding("crm-runner", "GATEKEEPER_TEST")?.service).toBe("crm-gatekeeper-test");
    const queue = [...cf.queues.values()].find((q) => q.name === "crm-automation-events");
    expect(queue?.consumers.map((c) => c.script_name)).toEqual(["crm-runner"]);

    // The stored state now speaks the new manifest's names, mapped onto the deployed ones.
    const stored = await readDeploymentState(api, ACCOUNT, databaseId);
    expect(stored).toMatchObject({
      version: "1.1.0",
      gatekeepers: ["ros-gatekeeper-test"],
      aiGateway: "crm",
      workerNames: {
        "ros-app": "crm-app",
        "ros-runner": "crm-runner",
        "ros-gatekeeper-test": "crm-gatekeeper-test",
      },
      resourceNames: {
        ros: "crm",
        "ros-blobs": "crm-blobs",
        "ros-app-oauth-kv": "crm-app-oauth-kv",
        "ros-automation-events": "crm-automation-events",
        "ros-automation-events-dlq": "crm-automation-events-dlq",
        "ros-records": "crm-records",
        "ros-automation": "crm-automation",
      },
    });
    expect(stored?.resources["D1_ID(ros)"]).toBe(databaseId);
    expect(stored && isLegacyState(stored)).toBe(false);

    // The next update starts from the adopted state and still changes nothing in the account.
    const again = await runUpdate({
      api,
      state: stored as DeploymentState,
      databaseId,
      target: await renamed("1.2.0"),
      previous: async () => renamed(),
      migrations: d1ApiMigrations(api, ACCOUNT, databaseId),
      smoke: async () => {},
    });
    expect(again.status).toBe("succeeded");
    expect(accountNames(cf)).toEqual(before);
    expect(cf.liveBinding("crm-app", "ROS_RELEASE_VERSION")?.text).toBe("1.2.0");
  });

  it("rolls back onto the same Workers when the renamed release fails its smoke check", async () => {
    const { cf, api, bundle, state, databaseId } = await legacyInstall();
    const before = accountNames(cf);
    const outcome = await runUpdate({
      api,
      state,
      databaseId,
      target: await renamed(),
      previous: async () => bundle,
      migrations: d1ApiMigrations(api, ACCOUNT, databaseId),
      smoke: async () => {
        throw new Error("unhealthy");
      },
    });
    expect(outcome.status).toBe("rolled_back");
    expect(accountNames(cf)).toEqual(before);
    expect(cf.liveBinding("crm-app", "ROS_RELEASE_VERSION")?.text).toBe("1.0.0");
    expect(cf.liveBinding("crm-app", "IDENTITY_PROVIDER")?.text).toBe("cloudflare-access");
    expect(cf.liveBinding("crm-runner", "GATEKEEPER_TEST")?.service).toBe("crm-gatekeeper-test");
    expect((await readDeploymentState(api, ACCOUNT, databaseId))?.version).toBe("1.0.0");
  });
});

describe("adoptLegacyNames", () => {
  it("leaves a renamed install, and a pre-rename manifest, alone", async () => {
    const { state, bundle } = await legacyInstall();
    const manifest = (await renamed()).manifest;
    const adopted = adoptLegacyNames(state, manifest);
    expect(adoptLegacyNames(adopted, manifest)).toBe(adopted);
    expect(adoptLegacyNames(state, bundle.manifest)).toBe(state);
    const fresh = { ...adopted, workerNames: {}, resourceNames: {} };
    expect(adoptLegacyNames(fresh, manifest)).toBe(fresh);
  });
});

describe("pre-rename releases", () => {
  it("still parse and verify (crm product, crm-<version> assets, the old repository)", async () => {
    const { fixture } = await legacyInstall();
    expect(parseManifest(fixture.manifestText).product).toBe("crm");
    const verified = await verifyBundleBytes({
      bytes: fixture.bundle,
      version: "1.0.0",
      sums: fixture.sums,
      repository: "timoconnellaus/relationship-os",
      skipProvenance: true,
    });
    expect(verified.digest).toBe(fixture.digest);
    expect(
      sameRepository("https://github.com/timoconnellaus/crm", "timoconnellaus/relationship-os"),
    ).toBe(true);
    expect(sameRepository("someone/crm", "timoconnellaus/relationship-os")).toBe(false);
  });
});
