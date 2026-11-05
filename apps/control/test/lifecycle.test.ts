// Stage 10 AC4 and AC5: export and delete are audited; support grants need customer approval and
// expire; idle Free deployments are paused (no crons) and woken on the next visit; the admin
// console is staff-only.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { resetDispatchCaches, runTenantSchedules } from "../src/dispatch/handler.ts";
import { pauseIdle } from "../src/instances.ts";
import { dailySweep } from "../src/lifecycle.ts";
import { readRoute, readSchedule } from "../src/routing.ts";
import {
  generateSupportKeyPair,
  openSupportSession,
  requestGrant,
  revokeGrant,
} from "../src/support.ts";
import { fromBase64url } from "../src/util.ts";
import {
  Browser,
  instanceFor,
  services,
  signInLink,
  signUp,
  tenantFetch,
  tenantQuery,
} from "./helpers.ts";

const STAFF = "staff@relationshiposcrm.com";

async function auditActions(accountId: string) {
  const { results } = await env.DB.prepare(
    "SELECT action FROM cp_audit WHERE account_id = ? ORDER BY at",
  )
    .bind(accountId)
    .all<{ action: string }>();
  return results.map((r) => r.action);
}

describe("support grants", () => {
  it("need the customer's approval in their workspace, are time-limited and audited", async () => {
    const keys = await generateSupportKeyPair();
    const s = services({ SUPPORT_SIGNING_KEY: keys.privateKey });
    await signUp({ email: "o@help.test", slug: "helpco", plan: "free" });
    const instance = await instanceFor("helpco");
    const grant = await requestGrant(s, {
      instanceId: instance?.id as string,
      staffEmail: STAFF,
      reason: "Ticket 42: import fails",
      role: "viewer",
      minutes: 60,
    });
    // The request is in the customer's own database, waiting for them.
    const [row] = await tenantQuery<{ status: string; reason: string }>(
      s,
      "helpco",
      "SELECT status, reason FROM core_support_grants WHERE id = ?",
      [grant],
    );
    expect(row).toEqual({ status: "requested", reason: "Ticket 42: import fails" });
    await expect(openSupportSession(s, grant, STAFF)).rejects.toThrow(/not approved/);

    // The customer's admin approves it in Settings → Support access (support.grant.approve).
    const expires = new Date(Date.now() + 60 * 60_000).toISOString();
    await tenantQuery(
      s,
      "helpco",
      "UPDATE core_support_grants SET status = 'approved', expires_at = ? WHERE id = ?",
      [expires, grant],
    );
    await expect(
      openSupportSession(s, grant, "someone-else@relationshiposcrm.com"),
    ).rejects.toThrow(/another member/);
    const url = new URL(await openSupportSession(s, grant, STAFF));
    expect(url.origin).toBe("https://helpco.relationshiposcrm.com");
    expect(url.pathname).toBe("/support/enter");

    // The token is an EdDSA JWT for this hostname and grant, valid 10 minutes, our signature.
    const token = url.searchParams.get("token") as string;
    const [header, body, signature] = token.split(".") as [string, string, string];
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(body)));
    expect(claims).toMatchObject({
      iss: "relationshiposcrm-control",
      aud: "helpco.relationshiposcrm.com",
      sub: grant,
      email: STAFF,
    });
    expect(claims.exp - claims.iat).toBe(600);
    const key = await crypto.subtle.importKey(
      "raw",
      fromBase64url(keys.publicKey),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    expect(
      await crypto.subtle.verify(
        { name: "Ed25519" },
        key,
        fromBase64url(signature),
        new TextEncoder().encode(`${header}.${body}`),
      ),
    ).toBe(true);

    // Expired: no more sessions.
    await tenantQuery(s, "helpco", "UPDATE core_support_grants SET expires_at = ? WHERE id = ?", [
      new Date(Date.now() - 1000).toISOString(),
      grant,
    ]);
    await expect(openSupportSession(s, grant, STAFF)).rejects.toThrow(/expired/);

    // Staff can withdraw a grant; it's revoked in the customer's database too.
    const second = await requestGrant(s, {
      instanceId: instance?.id as string,
      staffEmail: STAFF,
      reason: "Follow-up",
      role: "viewer",
      minutes: 30,
    });
    await revokeGrant(s, second, STAFF);
    const [revoked] = await tenantQuery<{ status: string }>(
      s,
      "helpco",
      "SELECT status FROM core_support_grants WHERE id = ?",
      [second],
    );
    expect(revoked?.status).toBe("revoked");

    expect(await auditActions(instance?.account_id as string)).toEqual(
      expect.arrayContaining([
        "support.grant.requested",
        "support.session.opened",
        "support.grant.revoked",
      ]),
    );
  });

  it("the deployment receives our public key", async () => {
    const keys = await generateSupportKeyPair();
    const s = services({ SUPPORT_PUBLIC_KEY: keys.publicKey });
    const { start } = await signUp({ email: "o@keyed.test", slug: "keyed", plan: "free" });
    expect(start.status).toBe(303);
    // Provisioned by the request's own services (no key there); provision again with the key.
    const instance = await instanceFor("keyed");
    await env.DB.prepare("UPDATE cp_instances SET status = 'failed' WHERE id = ?")
      .bind(instance?.id)
      .run();
    const { provisionInstance } = await import("../src/instances.ts");
    await provisionInstance(s, instance?.id as string);
    const app = s.fake.cloudflare.userWorker("ros-customers", `${instance?.id}-ros-app`);
    const bindings = app?.metadata.bindings as { name: string; text?: string }[];
    expect(bindings.find((b) => b.name === "ROS_SUPPORT_PUBLIC_KEY")?.text).toBe(keys.publicKey);
  });
});

describe("export and delete", () => {
  it("exports via Cloudflare-hosted links and a scoped read token, then deletes after the grace period", async () => {
    const s = services();
    const { browser } = await signUp({ email: "o@leaving.test", slug: "leaving", plan: "free" });
    const instance = await instanceFor("leaving");
    const tenant = instance?.id as string;

    await browser.post("/account/export");
    const exp = await env.DB.prepare("SELECT * FROM cp_exports WHERE instance_id = ?")
      .bind(tenant)
      .first<{ status: string; d1_url: string; r2_bucket: string; r2_token_id: string }>();
    expect(exp?.status).toBe("ready");
    expect(exp?.d1_url).toMatch(/^https:\/\/d1-exports\.example\//);
    const token = s.fake.cloudflare.tokens.get(exp?.r2_token_id as string);
    expect(token?.permissionGroups).toEqual(["pg-r2-read"]);
    expect(Object.keys(token?.resources ?? {})).toEqual([
      `com.cloudflare.edge.r2.bucket.${s.accountId}_default_${exp?.r2_bucket}`,
    ]);
    expect(token?.expiresOn).toBeTruthy();
    const mail = await env.DB.prepare(
      "SELECT body FROM cp_dev_mail WHERE to_address = 'o@leaving.test' AND subject LIKE '%export%'",
    ).first<{ body: string }>();
    expect(mail?.body).toContain(exp?.d1_url);

    // Deleting: suspended now, destroyed once the grace period is over.
    const refused = await browser.post("/account/delete", { confirm: "wrong" });
    expect(refused.status).toBe(400);
    await browser.post("/account/delete", { confirm: "leaving" });
    expect((await instanceFor("leaving"))?.status).toBe("suspended");
    resetDispatchCaches();
    expect((await tenantFetch(s, "https://leaving.relationshiposcrm.com/")).status).toBe(402);

    await env.DB.prepare("UPDATE cp_accounts SET delete_after = ? WHERE id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), instance?.account_id)
      .run();
    await dailySweep(s);
    expect((await instanceFor("leaving"))?.status).toBe("deleted");
    const ns = s.fake.cloudflare.namespaces.get("ros-customers");
    expect([...(ns?.keys() ?? [])].some((n) => n.startsWith(tenant))).toBe(false);
    expect([...s.fake.cloudflare.d1.values()].some((d) => d.name === `ros-${tenant}`)).toBe(false);
    expect([...s.fake.cloudflare.r2].some((b) => b.endsWith(tenant))).toBe(false);
    expect(s.fake.cloudflare.gateways.has(`${tenant}-ros`)).toBe(false);
    expect(await readRoute(env.ROUTES, "leaving.relationshiposcrm.com")).toBeNull();
    const owner = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM cp_users WHERE email = 'o@leaving.test'",
    ).first<{ n: number }>();
    expect(owner?.n).toBe(0);
    expect(await auditActions(instance?.account_id as string)).toEqual(
      expect.arrayContaining([
        "export.requested",
        "export.ready",
        "account.deletion_requested",
        "account.deleted",
      ]),
    );
  });
});

describe("idle Free deployments cost nothing", () => {
  it("are paused after 60 days without sign-ins (no crons) and woken by the next visit", async () => {
    const s = services();
    await signUp({ email: "o@idle.test", slug: "idleco", plan: "free" });
    await signUp({ email: "o@busy.test", slug: "busyco", plan: "free" });
    const idle = await instanceFor("idleco");
    const busy = await instanceFor("busyco");
    const old = new Date(Date.now() - 61 * 86_400_000).toISOString();
    await env.DB.prepare(
      "UPDATE cp_instances SET last_activity_at = ?, created_at = ? WHERE id = ?",
    )
      .bind(old, old, idle?.id)
      .run();
    // busyco's users signed in yesterday (its own core_session).
    await tenantQuery(
      s,
      "busyco",
      "INSERT INTO core_session (id, user_id, created_at, updated_at) VALUES ('s1', 'u1', ?, ?)",
      [
        new Date(Date.now() - 86_400_000).toISOString(),
        new Date(Date.now() - 86_400_000).toISOString(),
      ],
    );
    await env.DB.prepare(
      "UPDATE cp_instances SET last_activity_at = ?, created_at = ? WHERE id = ?",
    )
      .bind(old, old, busy?.id)
      .run();

    const paused = await pauseIdle(s);
    expect(paused).toContain(idle?.id);
    expect(paused).not.toContain(busy?.id);
    expect((await readRoute(env.ROUTES, "idleco.relationshiposcrm.com"))?.status).toBe("paused");
    const schedule = await readSchedule(env.ROUTES);
    expect(schedule.some((e) => e.tenant === idle?.id)).toBe(false);
    expect(schedule.some((e) => e.tenant === busy?.id)).toBe(true);

    // The minute cron runs running tenants only: none of idleco's.
    s.fake.scheduled.length = 0;
    await runTenantSchedules(
      { routes: env.ROUTES, dispatcher: s.fake.dispatcher },
      new Date("2026-11-05T03:17:00Z"),
    );
    expect(s.fake.scheduled.some((c) => c.script.startsWith(idle?.id as string))).toBe(false);
    expect(s.fake.scheduled).toContainEqual({ script: `${busy?.id}-ros-app`, cron: "17 3 * * *" });

    // A visit to a paused workspace is served, and wakes it (once).
    resetDispatchCaches();
    const { dispatchRequest } = await import("../src/dispatch/handler.ts");
    const { wakeTenant } = await import("../src/app.ts");
    const waits: Promise<unknown>[] = [];
    const response = await dispatchRequest(new Request("https://idleco.relationshiposcrm.com/"), {
      routes: env.ROUTES,
      dispatcher: s.fake.dispatcher,
      saasDomain: "relationshiposcrm.com",
      controlOrigin: "https://app.relationshiposcrm.com",
      limits: { cpuMs: 1000, subRequests: 10 },
      wake: async (tenant) => {
        await wakeTenant(s, tenant);
      },
      waitUntil: (p) => waits.push(p),
    });
    expect(response.status).toBe(200);
    await Promise.all(waits);
    expect((await instanceFor("idleco"))?.status).toBe("active");
    expect((await readSchedule(env.ROUTES)).some((e) => e.tenant === idle?.id)).toBe(true);
  });
});

describe("admin console", () => {
  it("is for staff only", async () => {
    const { browser } = await signUp({ email: "o@nosy.test", slug: "nosyco", plan: "free" });
    expect((await browser.get("/admin")).status).toBe(404);

    const staff = new Browser();
    await staff.post("/signin", { email: STAFF });
    await staff.get(await signInLink(STAFF));
    const home = await staff.get("/admin");
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("nosyco");
    const instance = await instanceFor("nosyco");
    const detail = await (await staff.get(`/admin/instances/${instance?.id}`)).text();
    expect(detail).toContain("Request access");
    // Staff see infrastructure, never the customer's records.
    expect(detail).not.toContain("core_person");
  });
});
