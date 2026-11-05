// Hosted AI (ADR 0213 amendment, ADR 0210 amendment, ADR 0250) against the fakes: a hosted
// deployment gets no AI Gateway or gateway token of its own, only the shared Platform AI gateway
// (created and kept safe to share: no cache, logs on, authenticated), its tenant id and the
// platform token; and its signed call sets the customer's own keys as secrets on its own Workers.
import { env } from "cloudflare:workers";
import { AI_SECRET_PATH, signDeploymentRequest } from "@relationship-os/release";
import { describe, expect, it } from "vitest";
import { instanceState } from "../src/db.ts";
import { changeLifecycle } from "../src/instances.ts";
import {
  ensurePlatformGateway,
  FAKE_PLATFORM_AI_TOKEN,
  tenantChannelKey,
} from "../src/platform-ai.ts";
import { Browser, instanceFor, ORIGIN, services, signUp } from "./helpers.ts";

const KEY = "sk-own-key-NEVER-STORED-4e5f6a";

async function freeTenant(slug: string) {
  await signUp({ email: `owner@${slug}.test`, slug, plan: "free" });
  const instance = await instanceFor(slug);
  return instance?.id as string;
}

async function call(
  tenant: string,
  body: unknown,
  options: { key?: string; signedTenant?: string } = {},
) {
  const s = services();
  const text = JSON.stringify(body);
  const headers = await signDeploymentRequest({
    key: options.key ?? (await tenantChannelKey(s, tenant)),
    tenant: options.signedTenant ?? tenant,
    method: "POST",
    path: AI_SECRET_PATH,
    body: text,
  });
  return new Browser().request(`${ORIGIN}${AI_SECRET_PATH}`, {
    method: "POST",
    body: text,
    headers: { ...headers, "content-type": "application/json" },
  });
}

describe("hosted provisioning", () => {
  it("wires the shared Platform AI gateway, not a gateway or token of its own", async () => {
    const s = services();
    const tokensBefore = s.fake.cloudflare.tokens.size;
    const tenant = await freeTenant("platformco");
    const instance = await instanceFor("platformco");
    const state = instanceState(instance as never);
    expect(state?.aiGateway).toBe(false);
    expect(state?.aiGatewayTokenId).toBeUndefined();
    expect(s.fake.cloudflare.gateways.has(`${tenant}-ros`)).toBe(false);
    expect(s.fake.cloudflare.tokens.size).toBe(tokensBefore);
    expect(s.fake.cloudflare.gateways.get("ros-platform")).toMatchObject({
      cache_ttl: 0,
      collect_logs: true,
      authentication: true,
    });

    for (const worker of ["ros-app", "ros-runner"]) {
      const live = s.fake.cloudflare.userWorker("ros-customers", `${tenant}-${worker}`);
      const vars = Object.fromEntries(
        ((live?.metadata.bindings ?? []) as { type: string; name: string; text?: string }[])
          .filter((b) => b.type === "plain_text")
          .map((b) => [b.name, b.text]),
      );
      expect(vars).toMatchObject({
        AI_PLATFORM_GATEWAY_ID: "ros-platform",
        AI_PLATFORM_ACCOUNT_ID: s.accountId,
        ROS_TENANT_ID: tenant,
      });
      expect(vars.AI_GATEWAY_ID ?? "").toBe("");
      expect(live?.secrets.get("AI_PLATFORM_TOKEN")).toBe(FAKE_PLATFORM_AI_TOKEN);
      expect(live?.secrets.has("AI_GATEWAY_TOKEN")).toBe(false);
    }
    const app = s.fake.cloudflare.userWorker("ros-customers", `${tenant}-ros-app`);
    expect(app?.secrets.get("ROS_CONTROL_KEY")).toBe(await tenantChannelKey(s, tenant));
  });

  it("puts back a shared-gateway setting that would leak between tenants", async () => {
    const s = services();
    await ensurePlatformGateway(s);
    await s.cf.updateAiGateway(s.accountId, "ros-platform", {
      collect_logs: false,
      cache_ttl: 3600,
      authentication: true,
    });
    expect(await ensurePlatformGateway(s)).toEqual(["cache_ttl", "collect_logs"]);
    expect(s.fake.cloudflare.gateways.get("ros-platform")).toMatchObject({
      cache_ttl: 0,
      collect_logs: true,
    });
    expect(await ensurePlatformGateway(s)).toEqual([]);
  });
});

describe("a deployment setting its own AI secrets", () => {
  it("sets the customer's key on the tenant's AI Workers, never storing it", async () => {
    const s = services();
    const tenant = await freeTenant("ownkeyco");
    const response = await call(tenant, { name: "AI_KEY_OPENAI", value: KEY });
    expect(response.status).toBe(200);
    const out = await response.json();
    expect(out).toEqual({ ok: true, targets: [`${tenant}-ros-app`, `${tenant}-ros-runner`] });
    for (const worker of ["ros-app", "ros-runner"]) {
      const live = s.fake.cloudflare.userWorker("ros-customers", `${tenant}-${worker}`);
      expect(live?.secrets.get("AI_KEY_OPENAI")).toBe(KEY);
    }
    // Nowhere in the control plane's database: audit has the name only.
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
    ).all<{ name: string }>();
    for (const { name } of tables.results) {
      const rows = await env.DB.prepare(`SELECT * FROM "${name}"`).all();
      expect(JSON.stringify(rows.results)).not.toContain("NEVER-STORED");
    }
    const audit = await env.DB.prepare(
      "SELECT detail FROM cp_audit WHERE instance_id = ? AND action = 'ai.secret_set'",
    )
      .bind(tenant)
      .first<{ detail: string }>();
    expect(JSON.parse(audit?.detail ?? "{}")).toMatchObject({ name: "AI_KEY_OPENAI" });

    // Removing it.
    expect((await call(tenant, { name: "AI_KEY_OPENAI" })).status).toBe(200);
    const app = s.fake.cloudflare.userWorker("ros-customers", `${tenant}-ros-app`);
    expect(app?.secrets.has("AI_KEY_OPENAI")).toBe(false);
  });

  it("sets the customer's own TypeSafe key for the judge (ADR 0232, ADR 0234)", async () => {
    const s = services();
    const tenant = await freeTenant("judgekeyco");
    const response = await call(tenant, { name: "TYPESAFE_API_KEY", value: KEY });
    expect(response.status).toBe(200);
    for (const worker of ["ros-app", "ros-runner"]) {
      const live = s.fake.cloudflare.userWorker("ros-customers", `${tenant}-${worker}`);
      expect(live?.secrets.get("TYPESAFE_API_KEY")).toBe(KEY);
    }
    expect((await call(tenant, { name: "TYPESAFE_API_KEY" })).status).toBe(200);
  });

  it("refuses anything but AI secrets, bad signatures and another tenant's key", async () => {
    const s = services();
    const tenant = await freeTenant("guardedco");
    const other = await freeTenant("otherco");
    // Never an auth secret, the platform token or the channel key.
    for (const name of ["BETTER_AUTH_SECRET", "AI_PLATFORM_TOKEN", "ROS_CONTROL_KEY"]) {
      expect((await call(tenant, { name, value: "x".repeat(20) })).status).toBe(403);
    }
    // Signed with another tenant's key, for this tenant: refused, nothing set.
    const otherKey = await tenantChannelKey(s, other);
    const forged = await call(tenant, { name: "AI_KEY_OPENAI", value: KEY }, { key: otherKey });
    expect(forged.status).toBe(401);
    // Unsigned.
    const unsigned = await new Browser().request(`${ORIGIN}${AI_SECRET_PATH}`, {
      method: "POST",
      body: JSON.stringify({ name: "AI_KEY_OPENAI", value: KEY }),
    });
    expect(unsigned.status).toBe(401);
    const app = s.fake.cloudflare.userWorker("ros-customers", `${tenant}-ros-app`);
    expect(app?.secrets.has("AI_KEY_OPENAI")).toBe(false);
    expect(app?.secrets.has("BETTER_AUTH_SECRET")).toBe(true);
    expect(app?.secrets.get("BETTER_AUTH_SECRET")).not.toBe("x".repeat(20));
  });

  it("is refused for a suspended workspace", async () => {
    const s = services();
    const tenant = await freeTenant("suspendedco");
    await changeLifecycle(s, tenant, "suspend", { kind: "staff", id: "test" }, "billing");
    expect((await call(tenant, { name: "AI_KEY_OPENAI", value: KEY })).status).toBe(409);
  });
});
