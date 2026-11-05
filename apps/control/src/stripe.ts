// Stripe, behind a small port (ADR 0214): the live client calls api.stripe.com with fetch; the fake
// (testing/fake-stripe.ts) keeps everything in memory and sends signed webhooks to our own
// endpoint, so the webhook path is exercised exactly as in production.
//
// Billing model: one Stripe customer per account. Team and Business are subscriptions with two
// prices: the flat monthly plan price and a metered "AI overage" price fed by a Billing Meter
// (event `STRIPE_METER_EVENT`, value in cents). Free accounts buy AI credit with one-off Checkout
// payments. Plan changes and cancellations happen in the Stripe customer portal.
import { safeEqual } from "./util.ts";

export interface CheckoutSession {
  id: string;
  url: string;
}

export interface StripeApi {
  createCustomer(input: {
    email: string;
    name: string;
    accountId: string;
  }): Promise<{ id: string }>;
  createSubscriptionCheckout(input: {
    customer: string;
    planPrice: string;
    overagePrice: string | null;
    trialDays: number;
    successUrl: string;
    cancelUrl: string;
    metadata: Record<string, string>;
  }): Promise<CheckoutSession>;
  createCreditCheckout(input: {
    customer: string;
    amountCents: number;
    successUrl: string;
    cancelUrl: string;
    metadata: Record<string, string>;
  }): Promise<CheckoutSession>;
  createPortalSession(input: { customer: string; returnUrl: string }): Promise<{ url: string }>;
  /** One Billing Meter event. `identifier` makes retries idempotent (24 h+ window). */
  meterEvent(input: {
    eventName: string;
    customer: string;
    value: number;
    identifier: string;
    timestamp: number;
  }): Promise<void>;
  cancelSubscription(id: string): Promise<void>;
}

/** application/x-www-form-urlencoded with Stripe's bracket notation for nested objects. */
export function stripeForm(input: Record<string, unknown>): string {
  const params = new URLSearchParams();
  const add = (key: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        add(`${key}[${i}]`, v);
      });
    } else if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) add(`${key}[${k}]`, v);
    } else {
      params.append(key, String(value));
    }
  };
  for (const [k, v] of Object.entries(input)) add(k, v);
  return params.toString();
}

export class LiveStripe implements StripeApi {
  constructor(
    private readonly secretKey: string,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  private async call<T>(path: string, body: Record<string, unknown>, idempotencyKey?: string) {
    const response = await this.fetchImpl(`https://api.stripe.com${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: stripeForm(body),
    });
    const json = (await response.json()) as T & { error?: { message?: string } };
    if (!response.ok) {
      throw new Error(`Stripe ${path} failed (${response.status}): ${json.error?.message ?? ""}`);
    }
    return json;
  }

  async createCustomer(input: { email: string; name: string; accountId: string }) {
    return this.call<{ id: string }>(
      "/v1/customers",
      { email: input.email, name: input.name, metadata: { account_id: input.accountId } },
      `customer-${input.accountId}`,
    );
  }

  async createSubscriptionCheckout(input: Parameters<StripeApi["createSubscriptionCheckout"]>[0]) {
    const lineItems: Record<string, unknown>[] = [{ price: input.planPrice, quantity: 1 }];
    // Metered prices take no quantity.
    if (input.overagePrice) lineItems.push({ price: input.overagePrice });
    return this.call<CheckoutSession>("/v1/checkout/sessions", {
      mode: "subscription",
      customer: input.customer,
      line_items: lineItems,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      metadata: input.metadata,
      subscription_data: {
        metadata: input.metadata,
        ...(input.trialDays > 0 ? { trial_period_days: input.trialDays } : {}),
      },
    });
  }

  async createCreditCheckout(input: Parameters<StripeApi["createCreditCheckout"]>[0]) {
    return this.call<CheckoutSession>("/v1/checkout/sessions", {
      mode: "payment",
      customer: input.customer,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: input.amountCents,
            product_data: { name: "Relationship OS AI credit" },
          },
        },
      ],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      metadata: input.metadata,
    });
  }

  async createPortalSession(input: { customer: string; returnUrl: string }) {
    return this.call<{ url: string }>("/v1/billing_portal/sessions", {
      customer: input.customer,
      return_url: input.returnUrl,
    });
  }

  async meterEvent(input: Parameters<StripeApi["meterEvent"]>[0]) {
    await this.call("/v1/billing/meter_events", {
      event_name: input.eventName,
      identifier: input.identifier,
      timestamp: input.timestamp,
      payload: { stripe_customer_id: input.customer, value: input.value },
    });
  }

  async cancelSubscription(id: string) {
    const response = await this.fetchImpl(`https://api.stripe.com/v1/subscriptions/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${this.secretKey}` },
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Stripe cancel subscription failed (${response.status})`);
    }
  }
}

// ---- Webhooks -----------------------------------------------------------------------------------

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The `Stripe-Signature` header for a payload (the fake Stripe signs with this). */
export async function signStripePayload(payload: string, secret: string, at: number) {
  return `t=${at},v1=${await hmacHex(secret, `${at}.${payload}`)}`;
}

/**
 * Verifies `Stripe-Signature` (`t=…,v1=…`): HMAC-SHA256 of `${t}.${rawBody}` with the endpoint
 * secret, compared in constant time against every v1 value (several during a secret roll), and a
 * timestamp no more than `toleranceSeconds` old. Other schemes (v0) are ignored.
 */
export async function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string,
  nowSeconds: number,
  toleranceSeconds = 300,
): Promise<boolean> {
  if (!header || !secret) return false;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2);
    if (key === "t") timestamp = Number(value);
    else if (key === "v1" && value) signatures.push(value);
  }
  if (timestamp === null || !Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  const expected = await hmacHex(secret, `${timestamp}.${payload}`);
  return signatures.some((s) => safeEqual(s, expected));
}

/** The parts of Stripe events this control plane reads. */
export interface StripeEvent {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
}
