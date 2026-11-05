// Stage 10 AC1: sign-up → trial → provision → a working deployment at <org>.relationshiposcrm.com,
// against the fake Workers for Platforms, Cloudflare API and Stripe.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { readRoute, readSchedule } from "../src/routing.ts";
import { instanceFor, services, signUp, tenantFetch, tenantQuery } from "./helpers.ts";

describe("sign-up to a working deployment", () => {
  it("a paid plan: email confirmed, Stripe trial checkout, provisioned into the namespace", async () => {
    const s = services();
    const { browser, start } = await signUp({
      email: "owner@acme.test",
      slug: "acme",
      plan: "team",
      name: "Acme",
    });
    // Paid plans go to Stripe Checkout before anything is provisioned.
    const checkout = start.headers.get("location") as string;
    expect(checkout).toMatch(/\/dev\/stripe\/checkout\/cs_/);
    expect((await instanceFor("acme"))?.status).toBe("pending");

    const paid = await browser.post(new URL(checkout).pathname);
    expect(paid.headers.get("location")).toBe("/account?checkout=done");

    const instance = await instanceFor("acme");
    expect(instance?.status).toBe("active");
    expect(instance?.version).toBe("1.0.0");
    const account = await env.DB.prepare("SELECT * FROM cp_accounts WHERE id = ?")
      .bind(instance?.account_id)
      .first<{ plan: string; billing_status: string; trial_ends_at: string | null }>();
    expect(account?.plan).toBe("team");
    expect(account?.billing_status).toBe("trialing");
    expect(account?.trial_ends_at).toBeTruthy();

    // User Workers in the dispatch namespace, tagged; per-tenant resources; nothing shared.
    const tenant = instance?.id as string;
    const ns = s.fake.cloudflare.namespaces.get("ros-customers");
    expect([...(ns?.keys() ?? [])].filter((n) => n.startsWith(tenant)).sort()).toEqual([
      `${tenant}-ros-app`,
      `${tenant}-ros-runner`,
    ]);
    expect(s.fake.cloudflare.userWorker("ros-customers", `${tenant}-ros-app`)?.tags).toEqual([
      `tenant-${tenant}`,
    ]);
    expect([...s.fake.cloudflare.d1.values()].some((d) => d.name === `ros-${tenant}`)).toBe(true);
    // No AI Gateway of its own (ADR 0210 amendment): Platform AI goes through the shared one.
    expect(s.fake.cloudflare.gateways.has(`${tenant}-ros`)).toBe(false);
    expect(s.fake.cloudflare.gateways.get("ros-platform")).toMatchObject({ cache_ttl: 0 });

    // Routed by verified hostname, and its crons are in the dispatch Worker's schedule.
    expect(await readRoute(env.ROUTES, "acme.relationshiposcrm.com")).toEqual({
      tenant,
      script: `${tenant}-ros-app`,
      status: "active",
    });
    const schedule = await readSchedule(env.ROUTES);
    expect(schedule.find((e) => e.tenant === tenant)?.scripts).toEqual({
      [`${tenant}-ros-app`]: ["17 3 * * *"],
    });

    // The deployment answers at its hostname, through the dispatch Worker.
    const health = await tenantFetch(s, "https://acme.relationshiposcrm.com/api/health");
    expect(await health.json()).toMatchObject({ status: "ok", version: "1.0.0" });
    const home = await tenantFetch(s, "https://acme.relationshiposcrm.com/");
    expect(await home.text()).toBe("ros 1.0.0");

    // The plan's entitlements are in the customer's own database.
    const [row] = await tenantQuery<{ value: string }>(
      s,
      "acme",
      "SELECT value FROM core_entitlements WHERE key = 'plan'",
    );
    expect(JSON.parse(row?.value ?? "{}")).toMatchObject({
      plan: "team",
      maxUsers: 10,
      maxRecords: null,
      platformAi: true,
    });

    // The owner was told where it is, and the account page shows it.
    const mail = await env.DB.prepare(
      "SELECT body FROM cp_dev_mail WHERE to_address = 'owner@acme.test' AND subject LIKE '%ready%'",
    ).first<{ body: string }>();
    expect(mail?.body).toContain("https://acme.relationshiposcrm.com/setup");
    const page = await (await browser.get("/account")).text();
    expect(page).toContain("Running");
    expect(page).toContain("acme.relationshiposcrm.com");
  });

  it("the Free plan provisions right after the email is confirmed, with Free limits", async () => {
    const s = services();
    const { start } = await signUp({ email: "solo@free.test", slug: "solo", plan: "free" });
    expect(start.headers.get("location")).toContain("/account?flash=");
    expect((await instanceFor("solo"))?.status).toBe("active");
    const [row] = await tenantQuery<{ value: string }>(
      s,
      "solo",
      "SELECT value FROM core_entitlements WHERE key = 'plan'",
    );
    expect(JSON.parse(row?.value ?? "{}")).toMatchObject({
      plan: "free",
      maxUsers: 1,
      maxRecords: 1000,
      platformAi: false,
    });
  });

  it("refuses taken, reserved and malformed addresses, and cross-site forms", async () => {
    await signUp({ email: "first@taken.test", slug: "taken", plan: "free" });
    const { Browser } = await import("./helpers.ts");
    const b = new Browser();
    for (const slug of ["taken", "app", "a", "Bad_Slug"]) {
      const response = await b.post("/signup", {
        email: "second@taken.test",
        name: "Second",
        slug,
        plan: "free",
      });
      expect(response.status).toBe(400);
    }
    const crossSite = await b.request("/signup", {
      method: "POST",
      body: new URLSearchParams({ email: "x@y.test", name: "x", slug: "xsite", plan: "free" }),
      headers: {
        origin: "https://evil.example",
        "content-type": "application/x-www-form-urlencoded",
      },
    });
    expect(crossSite.status).toBe(403);
  });

  it("dispatches only verified hostnames", async () => {
    const s = services();
    const unknown = await tenantFetch(s, "https://nobody.relationshiposcrm.com/");
    expect(unknown.status).toBe(404);
    // A Host naming a tenant's runner script directly reaches nothing.
    const instance = await instanceFor("solo");
    const sneaky = await tenantFetch(
      s,
      `https://${instance?.id}-ros-runner.relationshiposcrm.com/`,
    );
    expect(sneaky.status).toBe(404);
  });
});
