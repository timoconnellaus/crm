// The CLI end to end against a fake Cloudflare API and a fake GitHub served over real HTTP: install,
// idempotent re-run, a tampered bundle refused, upgrade, preflight blocking an incompatible
// extension, a failing migration rolled back, rollback and status. Output never contains a secret.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildFixtureRelease, FakeCloudflare, FakeGitHub } from "@crm/release/testing";
import { nodeSqliteEngine } from "@crm/release/testing/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Redactor } from "../src/io.ts";
import { type Env, runCli } from "../src/main.ts";

const TOKEN = "cf-token-0123456789-secret";
const ACCOUNT = "acc00000000000000000000000000cli";

interface World {
  cf: FakeCloudflare;
  github: FakeGitHub;
  server: Server;
  env: Env;
}

let world: World;

async function startWorld(): Promise<World> {
  const cf = new FakeCloudflare({
    token: TOKEN,
    accountId: ACCOUNT,
    sql: nodeSqliteEngine,
    subdomain: "acme",
  });
  let github!: FakeGitHub;
  const server = createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const url = `${origin}${req.url}`;
    let response: Response;
    if (req.url?.startsWith("/client/v4/")) {
      response = await cf.fetch(
        new Request(url, {
          method: req.method,
          headers: req.headers as Record<string, string>,
          ...(body && req.method !== "GET" ? { body } : {}),
        }),
      );
    } else if (req.url === "/api/health") {
      const version = cf.liveBinding("crm-app", "CRM_RELEASE_VERSION")?.text;
      response = Response.json({ status: "ok", version, migrations: { upToDate: true } });
    } else {
      response = await github.fetch(url);
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  github = new FakeGitHub("timoconnellaus/crm", origin);
  return {
    cf,
    github,
    server,
    env: {
      CRM_CLOUDFLARE_API: `${origin}/client/v4`,
      CRM_GITHUB_API: origin,
      CRM_HEALTH_ORIGIN: origin,
      CLOUDFLARE_API_TOKEN: TOKEN,
    },
  };
}

async function cli(...argv: string[]) {
  const lines: string[] = [];
  const redactor = new Redactor();
  const code = await runCli(argv, {
    io: {
      interactive: false,
      out: (l) => lines.push(redactor.clean(l)),
      err: (l) => lines.push(redactor.clean(l)),
      ask: async () => {
        throw new Error("no prompts in tests");
      },
    },
    redactor,
    env: world.env,
    ghVerifier: null,
    smokeDelayMs: 0,
  });
  return { code, output: lines.join("\n") };
}

async function sql(query: string) {
  const db = [...world.cf.d1.values()].find((d) => d.name === "crm");
  if (!db) throw new Error("no database");
  return db.engine.query(query, []);
}

beforeEach(async () => {
  world = await startWorld();
});
afterEach(() => {
  world.server.close();
});

describe("create-crm install", () => {
  it("installs a verified release and prints the URL", async () => {
    await world.github.publish(await buildFixtureRelease({ version: "1.0.0" }));
    const { code, output } = await cli("--yes", "--update-token", "update-token-abcdef123");
    expect(code, output).toBe(0);
    expect(output).toContain("https://crm-app.acme.workers.dev");
    expect([...world.cf.scripts.keys()].sort()).toEqual(["crm-app", "crm-runner"]);
    // Stage 5 and 7a resources the release declares: queues (with the DLQ wired to the
    // consumer), the Workflow, and the Vectorize index with its metadata index.
    expect([...world.cf.queues.values()].map((q) => q.name).sort()).toEqual([
      "crm-automation-events",
      "crm-automation-events-dlq",
    ]);
    expect(
      [...world.cf.queues.values()].find((q) => q.name === "crm-automation-events")?.consumers[0],
    ).toMatchObject({ script_name: "crm-runner", dead_letter_queue: "crm-automation-events-dlq" });
    expect(world.cf.workflows.has("crm-automation")).toBe(true);
    expect(world.cf.vectorizeMetadata.get("crm-records")).toEqual([
      { propertyName: "object", indexType: "string" },
    ]);
    const app = world.cf.scripts.get("crm-app");
    expect(app?.secrets.get("BETTER_AUTH_URL")).toBe("https://crm-app.acme.workers.dev");
    expect(app?.secrets.get("CRM_UPDATE_TOKEN")).toBe("update-token-abcdef123");
    expect(world.cf.liveBinding("crm-app", "CRM_ACCOUNT_ID")?.text).toBe(ACCOUNT);
    const state = JSON.parse(String((await sql("SELECT value FROM core_install"))[0]?.value));
    expect(state).toMatchObject({
      version: "1.0.0",
      channel: "stable",
      identityProvider: "better-auth",
    });
    // No secret value in the output.
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain("update-token-abcdef123");
    expect(output).not.toContain(app?.secrets.get("BETTER_AUTH_SECRET"));
  });

  it("is idempotent: a re-run creates nothing new and keeps secrets", async () => {
    await world.github.publish(await buildFixtureRelease({ version: "1.0.0" }));
    expect((await cli("--yes")).code).toBe(0);
    const secret = world.cf.scripts.get("crm-app")?.secrets.get("BETTER_AUTH_SECRET");
    const creates = () =>
      world.cf.calls.filter(
        (c) =>
          c.method === "POST" &&
          /\/(d1\/database|r2\/buckets|storage\/kv\/namespaces)$/.test(c.path),
      ).length;
    const before = creates();
    const { code, output } = await cli("--yes");
    expect(code, output).toBe(0);
    expect(output).toContain("re-running it to repair");
    expect(creates()).toBe(before);
    expect(world.cf.scripts.get("crm-app")?.secrets.get("BETTER_AUTH_SECRET")).toBe(secret);
    expect(world.cf.d1.size).toBe(1);
  });

  it("refuses a tampered bundle and deploys nothing", async () => {
    const release = await buildFixtureRelease({ version: "1.0.0" });
    const evil = await buildFixtureRelease({ version: "1.0.0", gatekeeperRevision: 99 });
    await world.github.publish(release, { tamper: { bytes: evil.bundle, rewriteSums: true } });
    const { code, output } = await cli("--yes");
    expect(code).toBe(1);
    expect(output).toMatch(/no build attestation|no valid build attestation/);
    expect(world.cf.scripts.size).toBe(0);
  });

  it("installs gatekeepers with their secrets and binds them to the runner", async () => {
    await world.github.publish(await buildFixtureRelease({ version: "1.0.0" }));
    const missing = await cli("--yes", "--gatekeepers", "test");
    expect(missing.code).toBe(1);
    expect(missing.output).toContain("--secret crm-gatekeeper-test:CLIENT_SECRET");
    const { code, output } = await cli(
      "--yes",
      "--gatekeepers",
      "test",
      "--secret",
      "crm-gatekeeper-test:CLIENT_SECRET=gk-secret-value-1",
    );
    expect(code, output).toBe(0);
    expect(world.cf.scripts.get("crm-gatekeeper-test")?.secrets.get("CLIENT_SECRET")).toBe(
      "gk-secret-value-1",
    );
    expect(world.cf.liveBinding("crm-runner", "GATEKEEPER_TEST")).toMatchObject({
      service: "crm-gatekeeper-test",
      entrypoint: "GatekeeperVendor",
    });
    expect(output).not.toContain("gk-secret-value-1");
  });
});

describe("crm upgrade, rollback and status", () => {
  async function installed() {
    await world.github.publish(await buildFixtureRelease({ version: "1.0.0" }));
    expect((await cli("--yes")).code).toBe(0);
    await sql("INSERT INTO core_person (id, name) VALUES ('per_1', 'Ada')");
  }

  it("upgrades to the newest release on the channel, and records the run", async () => {
    await installed();
    await world.github.publish(
      await buildFixtureRelease({
        version: "1.1.0",
        migrations: [["0161_note.sql", "ALTER TABLE core_person ADD COLUMN note TEXT;"]],
      }),
    );
    await world.github.publish(await buildFixtureRelease({ version: "1.2.0-beta.1" }));
    const { code, output } = await cli("upgrade", "--yes");
    expect(code, output).toBe(0);
    expect(output).toContain("Updated to crm 1.1.0");
    // Automations were paused with the kill switch and resumed after the smoke check.
    expect(output).toContain("pause…");
    expect(
      await sql("SELECT value FROM core_settings WHERE key = 'automations_kill_switch'"),
    ).toEqual([{ value: "false" }]);
    expect(world.cf.liveBinding("crm-app", "CRM_RELEASE_VERSION")?.text).toBe("1.1.0");
    const runs = await sql(
      "SELECT kind, status, from_version, to_version, bookmark FROM core_update_runs",
    );
    expect(runs).toEqual([
      expect.objectContaining({
        kind: "update",
        status: "succeeded",
        from_version: "1.0.0",
        to_version: "1.1.0",
      }),
    ]);
    expect(runs[0]?.bookmark).toBeTruthy();
    expect(await sql("SELECT name, note FROM core_person")).toEqual([{ name: "Ada", note: null }]);
  });

  it("preflight blocks an update that would break a runtime extension", async () => {
    await installed();
    await sql(
      `INSERT INTO core_extensions (id, source, status, manifest) VALUES ('scoring', 'runtime', 'active', '{"contractVersion":1}')`,
    );
    await world.github.publish(
      await buildFixtureRelease({ version: "2.0.0", contract: { version: 2, supported: [2] } }),
    );
    const { code, output } = await cli("upgrade", "--yes");
    expect(code).toBe(1);
    expect(output).toMatch(/blocked: Extension "scoring" is written against extension contract 1/);
    expect(world.cf.liveBinding("crm-app", "CRM_RELEASE_VERSION")?.text).toBe("1.0.0");
  });

  it("a failing migration rolls back with data restored", async () => {
    await installed();
    await world.github.publish(
      await buildFixtureRelease({
        version: "1.1.0",
        migrations: [
          ["0161_wipe.sql", "DELETE FROM core_person;"],
          ["0162_broken.sql", "ALTER TABLE missing ADD COLUMN x TEXT;"],
        ],
      }),
    );
    const { code, output } = await cli("upgrade", "--yes");
    expect(code).toBe(1);
    expect(output).toContain("Rolled back to 1.0.0");
    expect(await sql("SELECT name FROM core_person")).toEqual([{ name: "Ada" }]);
    expect(world.cf.liveBinding("crm-app", "CRM_RELEASE_VERSION")?.text).toBe("1.0.0");
    const runs = await sql("SELECT status FROM core_update_runs");
    expect(runs).toEqual([{ status: "rolled_back" }]);
  });

  it("rollback redeploys the previous release and restores the bookmark", async () => {
    await installed();
    await world.github.publish(
      await buildFixtureRelease({
        version: "1.1.0",
        migrations: [["0161_x.sql", "CREATE TABLE core_x (id TEXT);"]],
      }),
    );
    expect((await cli("upgrade", "--yes")).code).toBe(0);
    await sql("INSERT INTO core_person (id, name) VALUES ('per_2', 'After update')");
    const { code, output } = await cli("rollback", "--yes");
    expect(code, output).toBe(0);
    expect(world.cf.liveBinding("crm-app", "CRM_RELEASE_VERSION")?.text).toBe("1.0.0");
    expect(await sql("SELECT name FROM core_person")).toEqual([{ name: "Ada" }]);
    const runs = await sql("SELECT kind, status FROM core_update_runs ORDER BY started_at");
    expect(runs).toEqual([
      { kind: "update", status: "rolled_back" },
      { kind: "rollback", status: "succeeded" },
    ]);
    const status = await cli("status");
    expect(status.output).toContain("crm 1.0.0 (stable channel)");
    expect(status.output).toContain("available: 1.1.0");
  });

  it("does nothing when already up to date", async () => {
    await installed();
    const { code, output } = await cli("upgrade", "--yes");
    expect(code).toBe(0);
    expect(output).toContain("nothing newer");
  });
});
