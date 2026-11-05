// Stage 10 AC2: billing state changes suspend and resume deployments; AI usage is metered from
// AI Gateway into Stripe (fakes), with BYOK free and Free-plan credit debited.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { resetDispatchCaches } from "../src/dispatch/handler.ts";
import { meterDay } from "../src/metering.ts";
import { readRoute } from "../src/routing.ts";
import { signStripePayload } from "../src/stripe.ts";
import { FAKE_WEBHOOK_SECRET } from "../src/testing/fake-stripe.ts";
import {
  Browser,
  instanceFor,
  ORIGIN,
  services,
  signUp,
  tenantFetch,
  tenantQuery,
} from "./helpers.ts";

async function paidCustomer(slug: string, plan = "team") {
  const { browser, start } = await signUp({ email: `owner@${slug}.test`, slug, plan });
  await browser.post(new URL(start.headers.get("location") as string).pathname);
  const instance = await instanceFor(slug);
  const account = await env.DB.prepare("SELECT * FROM cp_accounts WHERE id = ?")
    .bind(instance?.account_id)
    .first<{ id: string; stripe_customer_id: string }>();
  return { browser, instance, account: account as { id: string; stripe_customer_id: string } };
}

async function portal(browser: Browser, customer: string, change: string) {
  return browser.post(`/dev/stripe/portal?customer=${customer}`, { change });
}

describe("billing state drives the deployment", () => {
  it("suspends on unpaid and resumes on payment; past_due keeps running", async () => {
    const s = services();
    const { browser, instance, account } = await paidCustomer("billco");
    const host = "https://billco.relationshiposcrm.com/api/health";

    await portal(browser, account.stripe_customer_id, "past_due");
    expect((await instanceFor("billco"))?.status).toBe("active");
    const warned = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM cp_dev_mail WHERE to_address = 'owner@billco.test' AND subject LIKE '%payment%'",
    ).first<{ n: number }>();
    expect(warned?.n).toBeGreaterThan(0);

    await portal(browser, account.stripe_customer_id, "unpaid");
    expect((await instanceFor("billco"))?.status).toBe("suspended");
    expect((await readRoute(env.ROUTES, "billco.relationshiposcrm.com"))?.status).toBe("suspended");
    expect((await tenantFetch(s, host)).status).toBe(402);

    await portal(browser, account.stripe_customer_id, "recover");
    expect((await instanceFor("billco"))?.status).toBe("active");
    // The dispatch Worker caches a route for 30 s per isolate; a new isolate sees the change.
    resetDispatchCaches();
    expect((await tenantFetch(s, host)).status).toBe(200);
    expect(instance?.id).toBeTruthy();
  });

  it("plan changes reach the deployment's entitlements", async () => {
    const s = services();
    const { browser, account } = await paidCustomer("upco");
    await portal(browser, account.stripe_customer_id, "business");
    const [row] = await tenantQuery<{ value: string }>(
      s,
      "upco",
      "SELECT value FROM core_entitlements WHERE key = 'plan'",
    );
    expect(JSON.parse(row?.value ?? "{}")).toMatchObject({ plan: "business", maxUsers: null });
  });

  it("cancellation suspends, schedules deletion, and Continue on Free restores it", async () => {
    const s = services();
    const { browser, account } = await paidCustomer("cancelco");
    await portal(browser, account.stripe_customer_id, "cancel");
    const cancelled = await env.DB.prepare("SELECT * FROM cp_accounts WHERE id = ?")
      .bind(account.id)
      .first<{ status: string; delete_after: string | null }>();
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.delete_after).toBeTruthy();
    expect((await instanceFor("cancelco"))?.status).toBe("suspended");

    await browser.post("/account/free");
    expect((await instanceFor("cancelco"))?.status).toBe("active");
    const [row] = await tenantQuery<{ value: string }>(
      s,
      "cancelco",
      "SELECT value FROM core_entitlements WHERE key = 'plan'",
    );
    expect(JSON.parse(row?.value ?? "{}")).toMatchObject({ plan: "free", maxUsers: 1 });
  });

  it("refuses unsigned or replayed webhooks, and ignores duplicates and stale events", async () => {
    const forged = await new Browser().request("/api/stripe/webhook", {
      method: "POST",
      body: JSON.stringify({ id: "evt_x", type: "invoice.paid", created: 1, data: { object: {} } }),
      headers: { "stripe-signature": "t=1,v1=00" },
    });
    expect(forged.status).toBe(400);

    const { account } = await paidCustomer("dupco");
    const event = {
      id: "evt_dup_1",
      type: "customer.subscription.updated",
      created: 1, // older than what was applied: ignored
      data: { object: { id: "sub_x", customer: account.stripe_customer_id, status: "unpaid" } },
    };
    const body = JSON.stringify(event);
    const sig = await signStripePayload(body, FAKE_WEBHOOK_SECRET, Math.floor(Date.now() / 1000));
    for (let i = 0; i < 2; i++) {
      const response = await new Browser().request(`${ORIGIN}/api/stripe/webhook`, {
        method: "POST",
        body,
        headers: { "stripe-signature": sig },
      });
      expect(response.status).toBe(200);
    }
    expect((await instanceFor("dupco"))?.status).toBe("active");
    const stale = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM cp_audit WHERE account_id = ? AND action = 'billing.event_out_of_order'",
    )
      .bind(account.id)
      .first<{ n: number }>();
    expect(stale?.n).toBe(1);
  });
});

describe("AI metering", () => {
  it("bills paid-plan spend beyond the allowance at cost + 20% as a Stripe meter event, BYOK free", async () => {
    const s = services();
    const { instance, account } = await paidCustomer("aico");
    const gateway = `${instance?.id}-ros`;
    const day = "2026-11-03";
    // $9 of Workers AI (ours), $50 of DeepSeek on the customer's own key, a cache hit.
    s.fake.cloudflare.addGatewayLog(gateway, {
      created_at: `${day}T09:00:00.000Z`,
      provider: "workers-ai",
      model: "llama",
      cost: 9,
    });
    s.fake.cloudflare.addGatewayLog(gateway, {
      created_at: `${day}T10:00:00.000Z`,
      provider: "deepseek",
      model: "deepseek-flash",
      cost: 50,
    });
    s.fake.cloudflare.addGatewayLog(gateway, {
      created_at: `${day}T11:00:00.000Z`,
      provider: "workers-ai",
      model: "llama",
      cost: 3,
      cached: true,
    });
    await meterDay(s, instance?.id as string, day);
    // Charged: $9 × 1.2 = $10.80; Team includes $10 → 80 cents overage.
    const usage = await env.DB.prepare(
      "SELECT * FROM cp_ai_usage WHERE instance_id = ? AND day = ?",
    )
      .bind(instance?.id, day)
      .first<Record<string, number | string>>();
    expect(usage).toMatchObject({
      requests: 3,
      provider_cost_micros: 62_000_000,
      billable_cost_micros: 9_000_000,
      charged_micros: 10_800_000,
      overage_cents: 80,
    });
    const event = s.fake.stripe.meterEvents.get(`ai-${instance?.id}-${day}`);
    expect(event).toMatchObject({
      eventName: "ai_overage_cents",
      customer: account.stripe_customer_id,
      value: 80,
    });

    // Re-running a day changes nothing; the next day bills only the new spend.
    await meterDay(s, instance?.id as string, day);
    s.fake.cloudflare.addGatewayLog(gateway, {
      created_at: "2026-11-04T09:00:00.000Z",
      provider: "workers-ai",
      model: "llama",
      cost: 1,
    });
    await meterDay(s, instance?.id as string, "2026-11-04");
    expect(s.fake.stripe.meterEvents.get(`ai-${instance?.id}-2026-11-04`)?.value).toBe(120);
  });

  it("debits Free credit in dollars and turns platform AI off when it runs out", async () => {
    const s = services();
    const { browser } = await signUp({
      email: "owner@credit.test",
      slug: "creditco",
      plan: "free",
    });
    // Buy $10 of credit through (fake) Checkout.
    const checkout = await browser.post("/account/credit", { cents: "1000" });
    await browser.post(new URL(checkout.headers.get("location") as string).pathname);
    const instance = await instanceFor("creditco");
    const entitlement = async () =>
      JSON.parse(
        (
          await tenantQuery<{ value: string }>(
            s,
            "creditco",
            "SELECT value FROM core_entitlements WHERE key = 'plan'",
          )
        )[0]?.value ?? "{}",
      );
    expect(await entitlement()).toMatchObject({ platformAi: true });

    s.fake.cloudflare.addGatewayLog(`${instance?.id}-ros`, {
      created_at: "2026-11-03T09:00:00.000Z",
      provider: "workers-ai",
      model: "llama",
      cost: 9,
    });
    await meterDay(s, instance?.id as string, "2026-11-03");
    const account = await env.DB.prepare("SELECT ai_credit_micros FROM cp_accounts WHERE id = ?")
      .bind(instance?.account_id)
      .first<{ ai_credit_micros: number }>();
    expect(account?.ai_credit_micros).toBe(10_000_000 - 10_800_000);
    expect(await entitlement()).toMatchObject({ platformAi: false });
    expect(s.fake.stripe.meterEvents.size).toBeGreaterThanOrEqual(0);
  });
});
