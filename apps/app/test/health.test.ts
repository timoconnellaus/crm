import { env } from "cloudflare:workers";
import { CORE_SCHEMA_VERSION } from "@crm/db";
import { describe, expect, it } from "vitest";
import { getHealth, healthResponse } from "../src/server/health.ts";

describe("GET /api/health", () => {
  it("reports version, commit, migration level and a successful runner ping", async () => {
    const response = await healthResponse(env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      status: "ok",
      version: "0.0.0-test",
      commit: "test",
      identityProvider: "better-auth",
      database: {
        ok: true,
        latest: env.TEST_MIGRATIONS.at(-1)?.name,
        schemaVersion: CORE_SCHEMA_VERSION,
        upToDate: true,
      },
      runner: { ok: true, worker: "crm-runner" },
    });
  });

  it("is degraded when the database is behind", async () => {
    await env.DB.prepare("UPDATE core_meta SET value = '0' WHERE key = 'schema_version'").run();
    const response = await healthResponse(env);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { database: unknown };
    expect(body.database).toMatchObject({ ok: false, schemaVersion: 0 });
  });

  it("is degraded when the runner cannot be reached", async () => {
    const broken = {
      ...env,
      RUNNER: { fetch: () => Promise.reject(new Error("no runner")) } as unknown as Fetcher,
    };
    const health = await getHealth(broken);
    expect(health.status).toBe("degraded");
    expect(health.runner.ok).toBe(false);
  });
});
