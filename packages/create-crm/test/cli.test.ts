// The CLI end to end against a fake Cloudflare API and a fake GitHub served over real HTTP: install,
// idempotent re-run, a tampered bundle refused, upgrade, preflight blocking an incompatible
// extension, a failing migration rolled back, rollback and status. Output never contains a secret.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { modelRolesVar } from "@crm/core/ai-roles";
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

  it("--ai off installs without Workers AI and Vectorize, and re-runs keep it off", async () => {
    await world.github.publish(await buildFixtureRelease({ version: "1.0.0" }));
    const first = await cli("--yes", "--ai", "off", "--ai-gateway", "crm-gw");
    expect(first.code, first.output).toBe(0);
    expect(first.output).toContain("In-app AI is off");
    expect(world.cf.vectorize.size).toBe(0);
    expect(world.cf.liveBinding("crm-runner", "AI")).toBeUndefined();
    expect(world.cf.liveBinding("crm-runner", "VECTORIZE")).toBeUndefined();
    const state = JSON.parse(String((await sql("SELECT value FROM core_install"))[0]?.value));
    expect(state.ai).toBe(false);
    // The chosen gateway is remembered, but with AI off none is created or wired.
    expect(state.aiGateway).toBe("crm-gw");
    expect(world.cf.gateways.size).toBe(0);
    expect(state.vars["crm-app"]?.AI_GATEWAY_ID).toBeUndefined();

    const again = await cli("--yes");
    expect(again.code, again.output).toBe(0);
    expect(world.cf.vectorize.size).toBe(0);
    const status = await cli("status");
    expect(status.output).toContain("AI: off");

    // Turned back on: the index is created and both bindings come back.
    world.env = { ...world.env, CRM_AI: "on", CRM_AI_ADMIN_TOKEN: "ai-admin-token-secret-1" };
    const on = await cli("--yes");
    expect(on.code, on.output).toBe(0);
    expect(world.cf.vectorize.has("crm-records")).toBe(true);
    expect(world.cf.liveBinding("crm-runner", "AI")).toEqual({ type: "ai", name: "AI" });
    expect(world.cf.scripts.get("crm-app")?.secrets.get("CLOUDFLARE_API_TOKEN")).toBe(
      "ai-admin-token-secret-1",
    );
    expect(on.output).not.toContain("ai-admin-token-secret-1");
    // ...and so is the gateway chosen at install.
    expect(world.cf.gateways.has("crm-gw")).toBe(true);
    expect(world.cf.liveBinding("crm-app", "AI_GATEWAY_ID")?.text).toBe("crm-gw");
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

const denyAiGateway = (_method: string, path: string) =>
  /\/ai-gateway\//.test(path)
    ? new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 10000, message: "Authentication error" }],
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      )
    : undefined;

describe("create-crm install: AI Gateway", () => {
  it("creates the gateway, the custom provider and the gateway token, and wires them", async () => {
    await world.github.publish(await buildFixtureRelease({ version: "1.0.0" }));
    const { code, output } = await cli("--yes");
    expect(code, output).toBe(0);
    expect(world.cf.gateways.get("crm")).toMatchObject({
      id: "crm",
      collect_logs: true,
      authentication: true,
    });
    expect([...world.cf.customProviders.values()]).toEqual([
      expect.objectContaining({
        slug: "example-llm",
        base_url: "https://llm.example.com",
        enable: true,
      }),
    ]);
    for (const worker of ["crm-app", "crm-runner"]) {
      expect(world.cf.liveBinding(worker, "AI_GATEWAY_ID")?.text).toBe("crm");
    }
    // One account token with AI Gateway Run only, stored on both Workers, never printed.
    expect(world.cf.tokens.size).toBe(1);
    const [tokenId, token] = [...world.cf.tokens][0] as [
      string,
      { value: string; permissionGroups: string[] },
    ];
    expect(token.permissionGroups).toEqual(["pg-aig-run"]);
    expect(world.cf.scripts.get("crm-app")?.secrets.get("AI_GATEWAY_TOKEN")).toBe(token.value);
    expect(world.cf.scripts.get("crm-runner")?.secrets.get("AI_GATEWAY_TOKEN")).toBe(token.value);
    expect(output).not.toContain(token.value);
    expect(output).toContain("AI Gateway crm: created");
    const state = JSON.parse(String((await sql("SELECT value FROM core_install"))[0]?.value));
    expect(state).toMatchObject({
      aiGateway: "crm",
      aiGatewayCreated: true,
      aiGatewayTokenId: tokenId,
    });
  });

  it("re-runs reuse everything: no second gateway, provider or token", async () => {
    await world.github.publish(await buildFixtureRelease({ version: "1.0.0" }));
    expect((await cli("--yes")).code).toBe(0);
    const token = world.cf.scripts.get("crm-app")?.secrets.get("AI_GATEWAY_TOKEN");
    const before = world.cf.calls.length;
    const { code, output } = await cli("--yes");
    expect(code, output).toBe(0);
    expect(output).toContain("AI Gateway crm: exists");
    expect(output).toContain("custom provider custom-example-llm: exists");
    expect(output).toContain("AI_GATEWAY_TOKEN: set");
    const writes = world.cf.calls
      .slice(before)
      .filter(
        (c) => c.method !== "GET" && /\/(ai-gateway|tokens|secrets_store)(\/|$)/.test(c.path),
      );
    expect(writes).toEqual([]);
    expect(world.cf.tokens.size).toBe(1);
    expect(world.cf.customProviders.size).toBe(1);
    expect(world.cf.scripts.get("crm-app")?.secrets.get("AI_GATEWAY_TOKEN")).toBe(token);
  });

  it("reuses a gateway that already exists, turning on logging and authentication", async () => {
    world.cf.gateways.set("crm", {
      id: "crm",
      collect_logs: false,
      authentication: false,
      cache_ttl: 60,
    });
    await world.github.publish(await buildFixtureRelease({ version: "1.0.0" }));
    const { code, output } = await cli("--yes");
    expect(code, output).toBe(0);
    expect(output).toContain("turned on collect_logs and authentication");
    expect(world.cf.gateways.get("crm")).toMatchObject({
      collect_logs: true,
      authentication: true,
      cache_ttl: 60,
    });
    const state = JSON.parse(String((await sql("SELECT value FROM core_install"))[0]?.value));
    expect(state.aiGatewayCreated).toBeUndefined();
  });

  it("--provider-key stores the key as BYOK in the gateway and never prints it", async () => {
    const KEY = "example-key-0123456789abcdef";
    await world.github.publish(await buildFixtureRelease({ version: "1.0.0" }));
    const { code, output } = await cli("--yes", "--provider-key", `example-llm=${KEY}`);
    expect(code, output).toBe(0);
    expect(world.cf.providerConfigs.get("crm")).toEqual([
      expect.objectContaining({
        provider_slug: "custom-example-llm",
        alias: "default",
        secret: KEY,
      }),
    ]);
    // The gateway was pointed at a Secrets Store to hold it.
    expect(world.cf.gateways.get("crm")?.store_id).toBeTruthy();
    expect(output).toContain("provider key custom-example-llm: stored in AI Gateway crm (BYOK)");
    expect(output).not.toContain(KEY);
    // Not a Workers secret.
    for (const script of world.cf.scripts.values()) {
      expect([...script.secrets.values()]).not.toContain(KEY);
    }
    // A custom provider is not a model registry provider: AI_GATEWAY_BYOK is left alone.
    expect(world.cf.liveBinding("crm-app", "AI_GATEWAY_BYOK")?.text).toBe("");

    // Re-run with a new key: replaced, not duplicated.
    const again = await cli("--yes", "--provider-key", "example-llm=second-key-abcdef0123456");
    expect(again.code, again.output).toBe(0);
    expect(world.cf.providerConfigs.get("crm")?.map((c) => c.secret)).toEqual([
      "second-key-abcdef0123456",
    ]);
    expect(again.output).not.toContain("second-key-abcdef0123456");
  });

  it("--model-roles deepseek-flash with a deepseek key: per deployment, kept by upgrades (ADR 0192)", async () => {
    const KEY = "sk-deepseek-0123456789abcdef";
    await world.github.publish(await buildFixtureRelease({ version: "1.0.0" }));
    const { code, output } = await cli(
      "--yes",
      "--model-roles",
      "deepseek-flash",
      "--provider-key",
      `deepseek=${KEY}`,
    );
    expect(code, output).toBe(0);
    expect(output).not.toContain(KEY);
    expect(output).toContain(
      "Model roles (AI_MODEL_ROLES on crm-app and crm-runner): deepseek-flash",
    );
    // DeepSeek is built in to AI Gateway: its key is stored under the `deepseek` slug.
    expect(world.cf.providerConfigs.get("crm")).toEqual([
      expect.objectContaining({ provider_slug: "deepseek", secret: KEY }),
    ]);
    const preset = modelRolesVar("deepseek-flash");
    for (const worker of ["crm-app", "crm-runner"]) {
      expect(world.cf.liveBinding(worker, "AI_MODEL_ROLES")?.text).toBe(preset);
      expect(world.cf.liveBinding(worker, "AI_GATEWAY_BYOK")?.text).toBe("deepseek");
    }
    const state = JSON.parse(String((await sql("SELECT value FROM core_install"))[0]?.value));
    expect(state.vars["crm-runner"]).toMatchObject({ AI_MODEL_ROLES: preset });

    // A plain re-run and an upgrade keep the choice.
    expect((await cli("--yes")).code).toBe(0);
    await world.github.publish(await buildFixtureRelease({ version: "1.1.0" }));
    const upgraded = await cli("upgrade", "--yes");
    expect(upgraded.code, upgraded.output).toBe(0);
    for (const worker of ["crm-app", "crm-runner"]) {
      expect(world.cf.liveBinding(worker, "AI_MODEL_ROLES")?.text).toBe(preset);
      expect(world.cf.liveBinding(worker, "AI_GATEWAY_BYOK")?.text).toBe("deepseek");
    }

    // `default` goes back to the shipped (Workers AI) roles.
    const reset = await cli("--yes", "--model-roles", "default", "--version", "1.1.0");
    expect(reset.code, reset.output).toBe(0);
    expect(world.cf.liveBinding("crm-app", "AI_MODEL_ROLES")?.text).toBe("");
  });

  it("--model-roles refuses an unknown preset or a model the role cannot use", async () => {
    await world.github.publish(await buildFixtureRelease({ version: "1.0.0" }));
    const unknown = await cli("--yes", "--model-roles", "deepseek-pro");
    expect(unknown.code).not.toBe(0);
    expect(unknown.output).toContain('no preset or file "deepseek-pro"');
    const bad = await cli(
      "--yes",
      "--model-roles",
      '{"embed":{"provider":"deepseek","model":"deepseek-flash"}}',
    );
    expect(bad.code).not.toBe(0);
    expect(bad.output).toContain("not an embedding model");
    expect(world.cf.scripts.size).toBe(0);
  });

  it("without AI Gateway permissions, installs anyway and says so", async () => {
    world.cf.failOn = denyAiGateway;
    await world.github.publish(await buildFixtureRelease({ version: "1.0.0" }));
    const { code, output } = await cli("--yes");
    expect(code, output).toBe(0);
    expect(output).toContain("needs AI Gateway Edit");
    expect(world.cf.liveBinding("crm-app", "AI_GATEWAY_ID")?.text).toBe("");
    expect(world.cf.tokens.size).toBe(0);
  });

  it("--ai-gateway off installs without a gateway; uninstall removes what install created", async () => {
    await world.github.publish(await buildFixtureRelease({ version: "1.0.0" }));
    const off = await cli("--yes", "--ai-gateway", "off");
    expect(off.code, off.output).toBe(0);
    expect(world.cf.gateways.size).toBe(0);
    expect(world.cf.liveBinding("crm-app", "AI_GATEWAY_ID")?.text).toBe("");

    const on = await cli("--yes", "--ai-gateway", "crm");
    expect(on.code, on.output).toBe(0);
    expect(world.cf.gateways.has("crm")).toBe(true);
    const gone = await cli("uninstall", "--yes");
    expect(gone.code, gone.output).toBe(0);
    expect(world.cf.gateways.size).toBe(0);
    expect(world.cf.tokens.size).toBe(0);
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

  it("an upgrade from a release without AI Gateway creates the gateway", async () => {
    await world.github.publish(await buildFixtureRelease({ version: "1.0.0", aiGateway: false }));
    expect((await cli("--yes")).code).toBe(0);
    expect(world.cf.gateways.size).toBe(0);
    await world.github.publish(await buildFixtureRelease({ version: "1.1.0" }));
    const { code, output } = await cli("upgrade", "--yes");
    expect(code, output).toBe(0);
    expect(world.cf.gateways.get("crm")).toMatchObject({
      authentication: true,
      collect_logs: true,
    });
    expect(world.cf.liveBinding("crm-runner", "AI_GATEWAY_ID")?.text).toBe("crm");
    expect(world.cf.scripts.get("crm-runner")?.secrets.has("AI_GATEWAY_TOKEN")).toBe(true);
    const state = JSON.parse(String((await sql("SELECT value FROM core_install"))[0]?.value));
    expect(state).toMatchObject({ version: "1.1.0", aiGateway: "crm", aiGatewayCreated: true });
    for (const token of world.cf.tokens.values()) expect(output).not.toContain(token.value);
  });

  it("an upgrade whose token cannot manage AI Gateway still succeeds", async () => {
    await installed();
    await world.github.publish(await buildFixtureRelease({ version: "1.1.0" }));
    world.cf.failOn = denyAiGateway;
    const { code, output } = await cli("upgrade", "--yes");
    expect(code, output).toBe(0);
    expect(output).toContain("needs AI Gateway Edit");
    expect(world.cf.liveBinding("crm-app", "CRM_RELEASE_VERSION")?.text).toBe("1.1.0");
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
