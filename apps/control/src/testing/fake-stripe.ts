// A fake Stripe for PLATFORM_MODE=fake (dev, tests, e2e). It keeps customers, checkout sessions,
// subscriptions and meter events in memory, and turns what a customer does on its pages (pay at
// checkout, cancel or change plan in the portal, a failed renewal) into Stripe-shaped events that
// it signs with the webhook secret and posts to our own /api/stripe/webhook. So the fake exercises
// the real webhook path: signature check, dedup, out-of-order handling.
import { type CheckoutSession, type StripeApi, signStripePayload } from "../stripe.ts";

interface FakeSession {
  id: string;
  mode: "subscription" | "payment";
  customer: string;
  metadata: Record<string, string>;
  planPrice?: string;
  trialDays?: number;
  amountCents?: number;
  completed: boolean;
}

interface FakeSubscription {
  id: string;
  customer: string;
  status: string;
  planPrice: string;
  metadata: Record<string, string>;
}

export interface MeterEventRecord {
  eventName: string;
  customer: string;
  value: number;
  identifier: string;
  timestamp: number;
}

export class FakeStripe implements StripeApi {
  readonly customers = new Map<string, { email: string; name: string; accountId: string }>();
  readonly sessions = new Map<string, FakeSession>();
  readonly subscriptions = new Map<string, FakeSubscription>();
  /** Meter events by identifier: a repeated identifier is ignored, as Stripe does. */
  readonly meterEvents = new Map<string, MeterEventRecord>();
  private counter = 0;

  constructor(private readonly origin: () => string) {}

  private id(prefix: string) {
    this.counter += 1;
    return `${prefix}_fake${this.counter.toString().padStart(6, "0")}`;
  }

  async createCustomer(input: { email: string; name: string; accountId: string }) {
    const existing = [...this.customers].find(([, c]) => c.accountId === input.accountId);
    if (existing) return { id: existing[0] };
    const id = this.id("cus");
    this.customers.set(id, input);
    return { id };
  }

  async createSubscriptionCheckout(
    input: Parameters<StripeApi["createSubscriptionCheckout"]>[0],
  ): Promise<CheckoutSession> {
    const id = this.id("cs");
    this.sessions.set(id, {
      id,
      mode: "subscription",
      customer: input.customer,
      metadata: input.metadata,
      planPrice: input.planPrice,
      trialDays: input.trialDays,
      completed: false,
    });
    return { id, url: `${this.origin()}/dev/stripe/checkout/${id}` };
  }

  async createCreditCheckout(
    input: Parameters<StripeApi["createCreditCheckout"]>[0],
  ): Promise<CheckoutSession> {
    const id = this.id("cs");
    this.sessions.set(id, {
      id,
      mode: "payment",
      customer: input.customer,
      metadata: input.metadata,
      amountCents: input.amountCents,
      completed: false,
    });
    return { id, url: `${this.origin()}/dev/stripe/checkout/${id}` };
  }

  async createPortalSession(input: { customer: string; returnUrl: string }) {
    return {
      url: `${this.origin()}/dev/stripe/portal?customer=${encodeURIComponent(input.customer)}&return=${encodeURIComponent(input.returnUrl)}`,
    };
  }

  async meterEvent(input: MeterEventRecord) {
    if (!this.customers.has(input.customer)) throw new Error("No such customer");
    if (!this.meterEvents.has(input.identifier)) this.meterEvents.set(input.identifier, input);
  }

  async cancelSubscription(id: string) {
    const sub = this.subscriptions.get(id);
    if (sub) sub.status = "canceled";
  }

  subscriptionFor(customer: string) {
    return [...this.subscriptions.values()].find((s) => s.customer === customer);
  }

  // ---- What a customer does on the fake pages, as Stripe events --------------------------------

  private event(type: string, object: Record<string, unknown>) {
    return { id: this.id("evt"), type, created: Math.floor(Date.now() / 1000), data: { object } };
  }

  private subscriptionObject(sub: FakeSubscription) {
    return {
      id: sub.id,
      object: "subscription",
      customer: sub.customer,
      status: sub.status,
      metadata: sub.metadata,
      items: { data: [{ price: { id: sub.planPrice } }] },
    };
  }

  /** Completing a checkout: the events Stripe would send. */
  completeCheckout(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("No such checkout session");
    if (session.completed) return [];
    session.completed = true;
    if (session.mode === "payment") {
      return [
        this.event("checkout.session.completed", {
          id: session.id,
          object: "checkout.session",
          mode: "payment",
          customer: session.customer,
          payment_status: "paid",
          amount_total: session.amountCents,
          metadata: session.metadata,
        }),
      ];
    }
    const sub: FakeSubscription = {
      id: this.id("sub"),
      customer: session.customer,
      status: (session.trialDays ?? 0) > 0 ? "trialing" : "active",
      planPrice: session.planPrice ?? "",
      metadata: session.metadata,
    };
    this.subscriptions.set(sub.id, sub);
    return [
      this.event("customer.subscription.created", this.subscriptionObject(sub)),
      this.event("checkout.session.completed", {
        id: session.id,
        object: "checkout.session",
        mode: "subscription",
        customer: session.customer,
        subscription: sub.id,
        metadata: session.metadata,
      }),
    ];
  }

  /** A subscription changing state (portal cancel, plan change, failed renewal, recovery). */
  changeSubscription(customer: string, change: { status?: string; planPrice?: string }) {
    const sub = this.subscriptionFor(customer);
    if (!sub) throw new Error("No subscription");
    if (change.status) sub.status = change.status;
    if (change.planPrice) sub.planPrice = change.planPrice;
    const type =
      sub.status === "canceled" ? "customer.subscription.deleted" : "customer.subscription.updated";
    const events = [this.event(type, this.subscriptionObject(sub))];
    if (change.status === "past_due") {
      events.unshift(
        this.event("invoice.payment_failed", {
          object: "invoice",
          customer,
          subscription: sub.id,
        }),
      );
    }
    return events;
  }

  /** Signs and posts events to the webhook, like Stripe's delivery. */
  async deliver(
    events: { id: string; type: string; created: number; data: unknown }[],
    secret: string,
    post: (body: string, signature: string) => Promise<Response>,
  ) {
    for (const event of events) {
      const body = JSON.stringify(event);
      const signature = await signStripePayload(body, secret, Math.floor(Date.now() / 1000));
      const response = await post(body, signature);
      if (!response.ok) throw new Error(`webhook refused ${event.type}: ${response.status}`);
    }
  }
}

/** The webhook secret the fake signs with (fake mode only; live mode reads the real secret). */
export const FAKE_WEBHOOK_SECRET = "whsec_fake_for_local_and_tests_only";
