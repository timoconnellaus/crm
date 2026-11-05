// Billing state (ADR 0214): Stripe is the source of truth for paid plans; its webhooks move an
// account's plan and status, and through them the deployment's entitlements and lifecycle.
//
//   trialing, active      running; plan entitlements applied
//   past_due              still running (Stripe retries the card); the owner is emailed
//   unpaid, paused,
//   incomplete_expired    suspended (traffic stopped, data kept)
//   canceled              suspended; deleted after DELETE_GRACE_DAYS unless the owner resubscribes
//                         or continues on Free; export stays available meanwhile
import { audit } from "./audit.ts";
import {
  type AccountRow,
  accountById,
  accountByStripeCustomer,
  instanceForAccount,
  updateAccount,
  userById,
} from "./db.ts";
import { intVar } from "./env.ts";
import { changeLifecycle, syncEntitlements } from "./instances.ts";
import { CREDIT_PACKS_CENTS, PLANS, type PlanId } from "./plans.ts";
import type { Services } from "./services.ts";
import type { StripeEvent } from "./stripe.ts";
import { addDays } from "./util.ts";

export function planForPrice(s: Services, priceId: string | undefined): PlanId | null {
  if (!priceId) return null;
  if (priceId === s.prices.team) return "team";
  if (priceId === s.prices.business) return "business";
  return null;
}

async function ensureCustomer(s: Services, account: AccountRow): Promise<string> {
  if (account.stripe_customer_id) return account.stripe_customer_id;
  const owner = await userById(s.db, account.owner_user_id);
  const { id } = await s.stripe.createCustomer({
    email: owner?.email ?? "",
    name: account.name,
    accountId: account.id,
  });
  await updateAccount(s.db, account.id, { stripe_customer_id: id });
  return id;
}

/** Stripe Checkout for a paid plan (with a trial the first time). Returns the URL to send them to. */
export async function subscriptionCheckout(
  s: Services,
  account: AccountRow,
  plan: "team" | "business",
): Promise<string> {
  const customer = await ensureCustomer(s, account);
  const price = plan === "team" ? s.prices.team : s.prices.business;
  if (!price) throw new Error(`no Stripe price configured for ${plan}`);
  const firstTime = !account.stripe_subscription_id && account.billing_status === "none";
  const session = await s.stripe.createSubscriptionCheckout({
    customer,
    planPrice: price,
    overagePrice: s.prices.aiOverage,
    trialDays: firstTime ? intVar(s.env.TRIAL_DAYS, 14) : 0,
    successUrl: `${s.origin}/account?checkout=done`,
    cancelUrl: `${s.origin}/account?checkout=cancelled`,
    metadata: { kind: "subscription", account_id: account.id, plan },
  });
  return session.url;
}

export async function creditCheckout(
  s: Services,
  account: AccountRow,
  amountCents: number,
): Promise<string> {
  if (!(CREDIT_PACKS_CENTS as readonly number[]).includes(amountCents)) {
    throw new Error("unknown credit pack");
  }
  const customer = await ensureCustomer(s, account);
  const session = await s.stripe.createCreditCheckout({
    customer,
    amountCents,
    successUrl: `${s.origin}/account?credit=done`,
    cancelUrl: `${s.origin}/account`,
    metadata: { kind: "ai_credit", account_id: account.id },
  });
  return session.url;
}

export async function portalUrl(s: Services, account: AccountRow): Promise<string> {
  const customer = await ensureCustomer(s, account);
  return (await s.stripe.createPortalSession({ customer, returnUrl: `${s.origin}/account` })).url;
}

async function ownerEmail(s: Services, account: AccountRow) {
  return (await userById(s.db, account.owner_user_id))?.email ?? null;
}

async function notify(s: Services, account: AccountRow, subject: string, text: string) {
  const to = await ownerEmail(s, account);
  if (to) await s.mail.send({ to, subject, text });
}

/** Handles one verified webhook event. Returns false for a duplicate. */
export async function handleStripeEvent(s: Services, event: StripeEvent): Promise<boolean> {
  const fresh = await s.db
    .prepare(
      "INSERT INTO cp_stripe_events (id, type, received_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING",
    )
    .bind(event.id, event.type, s.now().toISOString())
    .run();
  if (!fresh.meta.changes) return false;
  const object = event.data.object;
  const customer = typeof object.customer === "string" ? object.customer : null;
  const metaAccount = (object.metadata as Record<string, string> | undefined)?.account_id;
  const account =
    (customer ? await accountByStripeCustomer(s.db, customer) : null) ??
    (metaAccount ? await accountById(s.db, metaAccount) : null);
  if (!account) return true;
  const log = (action: string, detail: Record<string, unknown>) =>
    audit(
      s.db,
      { actorKind: "stripe", actor: event.id, action, accountId: account.id, detail },
      s.now(),
    );

  switch (event.type) {
    case "checkout.session.completed": {
      const metadata = (object.metadata ?? {}) as Record<string, string>;
      if (metadata.kind === "ai_credit" && object.payment_status === "paid") {
        const micros = Number(object.amount_total ?? 0) * 10_000;
        await s.db
          .prepare("UPDATE cp_accounts SET ai_credit_micros = ai_credit_micros + ? WHERE id = ?")
          .bind(micros, account.id)
          .run();
        await log("billing.credit_added", { micros });
        const updated = (await accountById(s.db, account.id)) as AccountRow;
        const instance = await instanceForAccount(s.db, account.id);
        if (instance) await syncEntitlements(s, updated, instance);
        return true;
      }
      if (metadata.kind === "subscription" && typeof object.subscription === "string") {
        await updateAccount(s.db, account.id, { stripe_subscription_id: object.subscription });
        await log("billing.checkout_completed", { subscription: object.subscription });
        const instance = await instanceForAccount(s.db, account.id);
        if (instance && (instance.status === "pending" || instance.status === "failed")) {
          await s.enqueue({ kind: "provision", instanceId: instance.id });
        }
      }
      return true;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      if (event.created < account.billing_event_at) {
        await log("billing.event_out_of_order", { type: event.type });
        return true;
      }
      await applySubscription(s, account, object, event);
      return true;
    }
    case "invoice.payment_failed":
      await log("billing.payment_failed", {});
      await notify(
        s,
        account,
        "Your Relationship OS payment failed",
        `We couldn't take your payment. Your workspace keeps running while Stripe retries; update your card at ${s.origin}/account.`,
      );
      return true;
    case "invoice.paid":
      await log("billing.invoice_paid", { amount: object.amount_paid ?? null });
      return true;
    default:
      return true;
  }
}

async function applySubscription(
  s: Services,
  account: AccountRow,
  sub: Record<string, unknown>,
  event: StripeEvent,
) {
  const status = event.type === "customer.subscription.deleted" ? "canceled" : String(sub.status);
  const items = (sub.items as { data?: { price?: { id?: string } }[] } | undefined)?.data ?? [];
  const plan =
    items.map((i) => planForPrice(s, i.price?.id)).find((p): p is PlanId => p !== null) ??
    account.plan;
  const now = s.now();
  const changes: Partial<AccountRow> = {
    billing_status: status,
    billing_event_at: event.created,
    stripe_subscription_id: typeof sub.id === "string" ? sub.id : account.stripe_subscription_id,
  };
  if (status !== "canceled") changes.plan = plan;
  if (status === "trialing" && !account.trial_ends_at) {
    changes.trial_ends_at = addDays(now, intVar(s.env.TRIAL_DAYS, 14)).toISOString();
  }
  if (status === "canceled") {
    changes.status = "cancelled";
    changes.cancelled_at = now.toISOString();
    changes.delete_after = addDays(now, intVar(s.env.DELETE_GRACE_DAYS, 30)).toISOString();
  } else if (account.status === "cancelled") {
    // Resubscribed during the grace period.
    changes.status = "active";
    changes.cancelled_at = null;
    changes.delete_after = null;
  }
  await updateAccount(s.db, account.id, changes);
  await audit(
    s.db,
    {
      actorKind: "stripe",
      actor: event.id,
      action: "billing.subscription",
      accountId: account.id,
      detail: { status, plan, from: account.billing_status },
    },
    now,
  );
  const updated = (await accountById(s.db, account.id)) as AccountRow;
  const instance = await instanceForAccount(s.db, account.id);
  if (!instance) return;
  const actor = { kind: "stripe" as const, id: event.id };
  if (status === "active" || status === "trialing" || status === "past_due") {
    if (instance.status === "suspended") await changeLifecycle(s, instance.id, "resume", actor);
    await syncEntitlements(s, updated, (await instanceForAccount(s.db, account.id)) ?? instance);
    if (status === "past_due") {
      await notify(
        s,
        updated,
        "Action needed: your Relationship OS payment is past due",
        `Your workspace is still running. Update your payment method at ${s.origin}/account to keep it that way.`,
      );
    }
    return;
  }
  // unpaid, paused, incomplete_expired, canceled: stop traffic, keep data.
  await changeLifecycle(
    s,
    instance.id,
    "suspend",
    actor,
    status === "canceled" ? "cancelled" : "billing",
  );
  if (status === "canceled") {
    const grace = intVar(s.env.DELETE_GRACE_DAYS, 30);
    await notify(
      s,
      updated,
      "Your Relationship OS subscription has ended",
      `Your workspace is suspended and will be deleted in ${grace} days.\n\nBefore then you can export your data, resubscribe, or continue on the Free plan at ${s.origin}/account.`,
    );
  }
}

/** After a cancellation (or any time), an owner can move to Free: the deployment resumes. */
export async function continueOnFree(s: Services, account: AccountRow, actor: string) {
  if (account.stripe_subscription_id && account.billing_status !== "canceled") {
    throw new Error("cancel the paid subscription in billing first");
  }
  await updateAccount(s.db, account.id, {
    plan: "free",
    billing_status: "none",
    status: "active",
    cancelled_at: null,
    delete_after: null,
  });
  await audit(
    s.db,
    { actorKind: "customer", actor, action: "billing.continue_on_free", accountId: account.id },
    s.now(),
  );
  const updated = (await accountById(s.db, account.id)) as AccountRow;
  const instance = await instanceForAccount(s.db, account.id);
  if (!instance) return;
  if (instance.status === "suspended") {
    await changeLifecycle(s, instance.id, "resume", { kind: "customer", id: actor });
  }
  await syncEntitlements(s, updated, (await instanceForAccount(s.db, account.id)) ?? instance);
}

export const PLAN_LABEL = (plan: PlanId) => PLANS[plan].name;
