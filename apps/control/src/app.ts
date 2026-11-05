// ros-control's HTTP surface: customer pages, the admin console, the Stripe webhook and (fake
// mode only) the fake Stripe and mailbox pages.
import { audit, recentAudit } from "./audit.ts";
import {
  clearSessionCookie,
  createSession,
  currentViewer,
  endSession,
  redeemSignInLink,
  sendSignInLink,
  sessionCookie,
  type Viewer,
} from "./auth.ts";
import {
  continueOnFree,
  creditCheckout,
  handleStripeEvent,
  portalUrl,
  subscriptionCheckout,
} from "./billing.ts";
import {
  type AccountRow,
  accountById,
  accountForOwner,
  ensureUser,
  type InstanceRow,
  instanceById,
  instanceBySlug,
  instanceForAccount,
  updateInstance,
  userById,
} from "./db.ts";
import { intVar, isLive } from "./env.ts";
import { changeLifecycle, type LifecycleChange, publishRoute } from "./instances.ts";
import { cancelDeletion, type ExportRow, requestDeletion, requestExport } from "./lifecycle.ts";
import { monthUsage } from "./metering.ts";
import {
  adminHome,
  adminInstance,
  adminRollout,
  auditTable,
  enterpriseForm,
} from "./pages/admin.ts";
import { accountPage, signInPage, signUpPage } from "./pages/customer.ts";
import { html, page, redirect } from "./pages/layout.ts";
import { PLANS, slugProblem } from "./plans.ts";
import {
  type RolloutRow,
  resumeRollout,
  rollBackRollout,
  startRollout,
  type TargetRow,
} from "./rollout.ts";
import type { Services } from "./services.ts";
import type { StripeEvent } from "./stripe.ts";
import { verifyStripeSignature } from "./stripe.ts";
import {
  grantsFor,
  openSupportSession,
  requestGrant,
  revokeGrant,
  type SupportRole,
} from "./support.ts";
import { newId, newTenantId } from "./util.ts";

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function form(request: Request): Promise<Record<string, string>> {
  const data = await request.formData();
  const out: Record<string, string> = {};
  for (const [k, v] of data.entries()) if (typeof v === "string") out[k] = v.trim();
  return out;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function handle(
  s: Services,
  request: Request,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  try {
    if (path === "/api/stripe/webhook" && method === "POST") return await stripeWebhook(s, request);
    if (path === "/api/health") return Response.json({ ok: true, mode: s.env.PLATFORM_MODE });
    // Forms are same-origin only (SameSite=Lax cookies plus this check).
    if (method === "POST") {
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) throw new HttpError(403, "Cross-site form refused.");
    }
    if (path.startsWith("/dev/")) {
      if (isLive(s.env)) return new Response("Not Found", { status: 404 });
      return await devRoutes(s, request, url);
    }
    const viewer = await currentViewer(s, request);
    const secure = url.protocol === "https:";

    if (path === "/" && method === "GET") {
      if (viewer)
        return redirect(
          viewer.staff && !(await accountForOwner(s.db, viewer.user.id)) ? "/admin" : "/account",
        );
      return page("Sign in", signInPage());
    }
    if (path === "/signin" && method === "POST") {
      const { email = "" } = await form(request);
      if (EMAIL.test(email)) await sendSignInLink(s, email, "/account");
      return page(
        "Check your email",
        signInPage("If that address has an account, a sign-in link is on its way."),
      );
    }
    if (path === "/signup" && method === "GET") {
      return page(
        "Create your workspace",
        signUpPage({ plan: url.searchParams.get("plan") ?? "free", domain: s.env.SAAS_DOMAIN }),
      );
    }
    if (path === "/signup" && method === "POST") return await signUp(s, request);
    if (path === "/auth/callback" && method === "GET") {
      const redeemed = await redeemSignInLink(s, url.searchParams.get("token") ?? "");
      if (!redeemed)
        return page(
          "Link expired",
          signInPage("That link has expired or was already used. Ask for a new one."),
          { status: 400 },
        );
      const id = await createSession(s, redeemed.user.id);
      return redirect(redeemed.next, { "set-cookie": sessionCookie(id, secure) });
    }
    if (path === "/signout" && method === "POST") {
      await endSession(s, request);
      return redirect("/", { "set-cookie": clearSessionCookie() });
    }

    if (!viewer) return redirect("/");
    if (path.startsWith("/admin")) {
      if (!viewer.staff) throw new HttpError(404, "Not found.");
      return await adminRoutes(s, request, url, viewer, ctx);
    }
    if (path.startsWith("/account")) return await accountRoutes(s, request, url, viewer);
    throw new HttpError(404, "Not found.");
  } catch (error) {
    if (error instanceof HttpError) {
      return page("Error", html`<h1>${error.message}</h1><p><a href="/">Back</a></p>`, {
        status: error.status,
      });
    }
    throw error;
  }
}

// ---- Sign-up ------------------------------------------------------------------------------------

async function signUp(s: Services, request: Request): Promise<Response> {
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  const { success } = await s.env.SIGNUP_RATE_LIMIT.limit({ key: ip });
  if (!success) throw new HttpError(429, "Too many sign-ups from here. Try again in a minute.");
  const values = await form(request);
  const email = (values.email ?? "").toLowerCase();
  const name = (values.name ?? "").slice(0, 80);
  const slug = (values.slug ?? "").toLowerCase();
  const plan = values.plan === "team" || values.plan === "business" ? values.plan : "free";
  const again = (error: string) =>
    page("Create your workspace", signUpPage({ plan, error, values, domain: s.env.SAAS_DOMAIN }), {
      status: 400,
    });
  if (!EMAIL.test(email)) return again("Enter a valid email address.");
  if (!name) return again("Enter your organisation's name.");
  const problem = slugProblem(slug);
  if (problem) return again(problem);
  if (await instanceBySlug(s.db, slug)) return again("That address is taken.");
  const now = s.now();
  const user = await ensureUser(s.db, email, now);
  const existing = await accountForOwner(s.db, user.id);
  if (existing) {
    await sendSignInLink(s, email, "/account");
    return page(
      "Check your email",
      signInPage("You already have a workspace: we've emailed you a sign-in link."),
    );
  }
  const accountId = newId("acc");
  const tenant = newTenantId();
  const iso = now.toISOString();
  const placement = s.env.DEFAULT_PLACEMENT === "account" ? "account" : "namespace";
  await s.db.batch([
    s.db
      .prepare(
        "INSERT INTO cp_accounts (id, name, owner_user_id, plan, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(accountId, name, user.id, plan, iso),
    s.db
      .prepare(
        "INSERT INTO cp_instances (id, account_id, slug, hostname, placement, namespace, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
      )
      .bind(
        tenant,
        accountId,
        slug,
        `${slug}.${s.env.SAAS_DOMAIN}`,
        placement,
        placement === "namespace" ? s.env.DISPATCH_NAMESPACE : null,
        iso,
        iso,
      ),
  ]);
  await audit(
    s.db,
    {
      actorKind: "customer",
      actor: email,
      action: "account.signed_up",
      accountId,
      instanceId: tenant,
      detail: { plan, slug },
    },
    now,
  );
  // The email link proves the address before anything is provisioned or charged.
  await sendSignInLink(s, email, "/account/start");
  return page(
    "Check your email",
    signInPage(
      `We've emailed ${email} a link to confirm your address and set up ${slug}.${s.env.SAAS_DOMAIN}.`,
    ),
  );
}

// ---- Account ------------------------------------------------------------------------------------

async function accountRoutes(
  s: Services,
  request: Request,
  url: URL,
  viewer: Viewer,
): Promise<Response> {
  const account = await accountForOwner(s.db, viewer.user.id);
  const path = url.pathname;
  const method = request.method;
  if (!account) {
    if (path === "/account")
      return page(
        "Your account",
        html`<h1>Your account</h1><p>No workspace yet. <a href="/signup">Create one</a>.</p>`,
        { signedIn: true, staff: viewer.staff },
      );
    throw new HttpError(404, "No account.");
  }
  const instance = await instanceForAccount(s.db, account.id);
  const actor = viewer.user.email;
  if (path === "/account" && method === "GET") {
    const { results: exports } = instance
      ? await s.db
          .prepare(
            "SELECT * FROM cp_exports WHERE instance_id = ? ORDER BY created_at DESC LIMIT 5",
          )
          .bind(instance.id)
          .all<ExportRow>()
      : { results: [] as ExportRow[] };
    const flash =
      url.searchParams.get("checkout") === "done"
        ? "Thanks! Your workspace is being set up."
        : url.searchParams.get("credit") === "done"
          ? "Thanks! Your AI credit has been added."
          : (url.searchParams.get("flash") ?? undefined);
    return page(
      "Your account",
      accountPage({
        account,
        instance,
        usage: instance ? await monthUsage(s, instance.id, account) : null,
        exports,
        grants: instance ? await grantsFor(s.db, instance.id) : [],
        flash,
      }),
      { signedIn: true, staff: viewer.staff },
    );
  }
  if (path === "/account/start") {
    if (!instance || !["pending", "failed"].includes(instance.status)) return redirect("/account");
    if (PLANS[account.plan].paid && !account.stripe_subscription_id) {
      return redirect(
        await subscriptionCheckout(s, account, account.plan === "business" ? "business" : "team"),
      );
    }
    await s.enqueue({ kind: "provision", instanceId: instance.id });
    return redirect("/account?flash=Your+workspace+is+being+set+up.");
  }
  if (method !== "POST") throw new HttpError(405, "Method not allowed.");
  const values = await form(request);
  switch (path) {
    case "/account/billing":
      return redirect(await portalUrl(s, account));
    case "/account/upgrade":
      return redirect(
        await subscriptionCheckout(s, account, values.plan === "business" ? "business" : "team"),
      );
    case "/account/credit":
      return redirect(await creditCheckout(s, account, Number(values.cents)));
    case "/account/free":
      await continueOnFree(s, account, actor);
      return redirect("/account?flash=You're+on+the+Free+plan.");
    case "/account/export":
      if (!instance) throw new HttpError(400, "No workspace.");
      await requestExport(s, instance, actor);
      return redirect("/account?flash=Export+started:+we'll+email+you+the+links.");
    case "/account/delete":
      if (!instance || values.confirm !== instance.slug)
        throw new HttpError(400, "Type the workspace address to confirm.");
      await requestDeletion(s, account, actor);
      return redirect(
        "/account?flash=Your+workspace+is+suspended+and+will+be+deleted+after+the+grace+period.",
      );
    case "/account/undelete":
      await cancelDeletion(s, account, actor);
      return redirect("/account?flash=Deletion+cancelled.");
    default:
      throw new HttpError(404, "Not found.");
  }
}

// ---- Stripe webhook -----------------------------------------------------------------------------

export async function stripeWebhook(s: Services, request: Request): Promise<Response> {
  const payload = await request.text();
  const ok = await verifyStripeSignature(
    payload,
    request.headers.get("stripe-signature"),
    s.stripeWebhookSecret,
    Math.floor(s.now().getTime() / 1000),
  );
  if (!ok) return Response.json({ error: "bad signature" }, { status: 400 });
  const event = JSON.parse(payload) as StripeEvent;
  await handleStripeEvent(s, event);
  return Response.json({ received: true });
}

// ---- Admin --------------------------------------------------------------------------------------

async function adminRoutes(
  s: Services,
  request: Request,
  url: URL,
  viewer: Viewer,
  _ctx: ExecutionContext,
): Promise<Response> {
  const path = url.pathname;
  const method = request.method;
  const staff = viewer.user.email;
  const opts = { signedIn: true, staff: true };
  if (path === "/admin" && method === "GET") {
    const { results: accounts } = await s.db
      .prepare(
        "SELECT * FROM cp_accounts WHERE status != 'deleted' ORDER BY created_at DESC LIMIT 500",
      )
      .all<AccountRow>();
    const customers = await Promise.all(
      accounts.map(async (account) => ({
        account,
        instance: await instanceForAccount(s.db, account.id),
        owner: (await userById(s.db, account.owner_user_id))?.email ?? null,
      })),
    );
    const { results: rollouts } = await s.db
      .prepare("SELECT * FROM cp_rollouts ORDER BY created_at DESC LIMIT 20")
      .all<RolloutRow>();
    const versions = s.fake
      ? [...s.fake.releases.versions].reverse()
      : [await s.releases.latest(s.env.RELEASE_CHANNEL === "beta" ? "beta" : "stable")];
    return page(
      "Admin",
      adminHome({
        customers,
        rollouts,
        versions,
        flash: url.searchParams.get("flash") ?? undefined,
      }),
      opts,
    );
  }
  if (path === "/admin/audit")
    return page(
      "Audit",
      html`<h1>Audit log</h1>${auditTable(await recentAudit(s.db, null, 300))}`,
      opts,
    );
  if (path === "/admin/enterprise") {
    if (method === "GET") return page("Enterprise", enterpriseForm(), opts);
    return await createEnterprise(s, await form(request), staff);
  }
  if (path === "/admin/rollouts" && method === "POST") {
    const values = await form(request);
    const id = await startRollout(s, {
      version: values.version ?? "",
      staff,
      maxFailures: intVar(values.max_failures, 0),
    });
    return redirect(`/admin/rollouts/${id}`);
  }
  let m = /^\/admin\/rollouts\/([\w-]+)(?:\/(resume|rollback))?$/.exec(path);
  if (m) {
    const id = m[1] as string;
    if (m[2] === "resume" && method === "POST") await resumeRollout(s, id, staff);
    if (m[2] === "rollback" && method === "POST") await rollBackRollout(s, id, staff);
    if (m[2]) return redirect(`/admin/rollouts/${id}`);
    const rollout = await s.db
      .prepare("SELECT * FROM cp_rollouts WHERE id = ?")
      .bind(id)
      .first<RolloutRow>();
    if (!rollout) throw new HttpError(404, "No such rollout.");
    const { results: targets } = await s.db
      .prepare("SELECT * FROM cp_rollout_targets WHERE rollout_id = ? ORDER BY wave, instance_id")
      .bind(id)
      .all<TargetRow>();
    return page("Rollout", adminRollout({ rollout, targets }), opts);
  }
  m = /^\/admin\/grants\/([\w-]+)\/(open|revoke)$/.exec(path);
  if (m && method === "POST") {
    const id = m[1] as string;
    const grant = await s.db
      .prepare("SELECT instance_id FROM cp_support_grants WHERE id = ?")
      .bind(id)
      .first<{ instance_id: string }>();
    if (!grant) throw new HttpError(404, "No such grant.");
    if (m[2] === "revoke") {
      await revokeGrant(s, id, staff);
      return redirect(`/admin/instances/${grant.instance_id}?flash=Grant+revoked.`);
    }
    try {
      return redirect(await openSupportSession(s, id, staff));
    } catch (error) {
      return redirect(
        `/admin/instances/${grant.instance_id}?error=${encodeURIComponent((error as Error).message)}`,
      );
    }
  }
  m = /^\/admin\/instances\/([\w-]+)(?:\/([\w-]+))?$/.exec(path);
  if (m) {
    const instance = await instanceById(s.db, m[1] as string);
    if (!instance) throw new HttpError(404, "No such workspace.");
    if (m[2] && method === "POST")
      return await instanceAction(s, instance, m[2], await form(request), staff);
    const account = (await accountById(s.db, instance.account_id)) as AccountRow;
    const health = url.searchParams.get("health");
    return page(
      instance.slug,
      adminInstance({
        account,
        instance,
        owner: (await userById(s.db, account.owner_user_id))?.email ?? null,
        usage: await monthUsage(s, instance.id, account),
        grants: await grantsFor(s.db, instance.id),
        audit: await recentAudit(s.db, account.id, 50),
        health,
        flash: url.searchParams.get("flash") ?? undefined,
        error: url.searchParams.get("error") ?? undefined,
      }),
      opts,
    );
  }
  throw new HttpError(404, "Not found.");
}

async function instanceAction(
  s: Services,
  instance: InstanceRow,
  action: string,
  values: Record<string, string>,
  staff: string,
): Promise<Response> {
  const back = (q: string) => redirect(`/admin/instances/${instance.id}?${q}`);
  const actor = { kind: "staff" as const, id: staff };
  switch (action) {
    case "health": {
      const host = instance.custom_hostname ?? instance.hostname;
      let result: string;
      try {
        const response = await s.healthFetch(`https://${host}/api/health`, {
          headers: { "cache-control": "no-cache" },
        });
        const body = (await response.json()) as { status?: string; version?: string };
        result = `${response.status} ${body.status ?? ""} ${body.version ?? ""}`.trim();
      } catch (error) {
        result = `unreachable: ${(error as Error).message}`;
      }
      await audit(
        s.db,
        {
          actorKind: "staff",
          actor: staff,
          action: "instance.health_checked",
          accountId: instance.account_id,
          instanceId: instance.id,
          detail: { result },
        },
        s.now(),
      );
      return back(`health=${encodeURIComponent(result)}`);
    }
    case "pause":
    case "wake":
    case "suspend":
    case "resume": {
      const done = await changeLifecycle(
        s,
        instance.id,
        action as LifecycleChange,
        actor,
        action === "suspend" ? "staff" : undefined,
      );
      return back(
        done ? `flash=${action}+done` : `error=${action}+not+possible+from+${instance.status}`,
      );
    }
    case "provision":
      await s.enqueue({ kind: "provision", instanceId: instance.id });
      return back("flash=Provisioning+started");
    case "cohort": {
      const cohort = instance.cohort === "canary" ? "general" : "canary";
      await updateInstance(s.db, instance.id, { cohort }, s.now());
      await audit(
        s.db,
        {
          actorKind: "staff",
          actor: staff,
          action: "instance.cohort",
          accountId: instance.account_id,
          instanceId: instance.id,
          detail: { cohort },
        },
        s.now(),
      );
      return back(`flash=Cohort+${cohort}`);
    }
    case "custom-hostname": {
      const zone = s.env.SAAS_ZONE_ID;
      if (!zone || !instance.custom_hostname) return back("error=No+SaaS+zone+or+custom+hostname");
      const found = await s.cf.customHostname(zone, instance.custom_hostname);
      const status = found?.status ?? "missing";
      await updateInstance(s.db, instance.id, { custom_hostname_status: status }, s.now());
      if (status === "active" && instance.status === "active") {
        await publishRoute(s, (await instanceById(s.db, instance.id)) as InstanceRow, "active");
      }
      return back(`flash=Custom+hostname+${status}`);
    }
    case "grants": {
      try {
        await requestGrant(s, {
          instanceId: instance.id,
          staffEmail: staff,
          reason: values.reason ?? "",
          role: (values.role ?? "viewer") as SupportRole,
          minutes: Number(values.minutes ?? 120),
        });
        return back("flash=Requested.+The+customer+approves+it+in+their+workspace.");
      } catch (error) {
        return back(`error=${encodeURIComponent((error as Error).message)}`);
      }
    }
    default:
      throw new HttpError(404, "Not found.");
  }
}

async function createEnterprise(
  s: Services,
  values: Record<string, string>,
  staff: string,
): Promise<Response> {
  const email = (values.email ?? "").toLowerCase();
  const slug = (values.slug ?? "").toLowerCase();
  const model = values.model === "managed" ? "managed" : "dedicated";
  const problem = !EMAIL.test(email) ? "Enter the owner's email." : slugProblem(slug);
  if (problem)
    return page("Enterprise", enterpriseForm(problem), {
      signedIn: true,
      staff: true,
      status: 400,
    });
  if (await instanceBySlug(s.db, slug))
    return page("Enterprise", enterpriseForm("That address is taken."), {
      signedIn: true,
      staff: true,
      status: 400,
    });
  const now = s.now();
  const iso = now.toISOString();
  const user = await ensureUser(s.db, email, now);
  const accountId = newId("acc");
  const tenant = newTenantId();
  const custom = (values.custom_hostname ?? "").toLowerCase() || null;
  await s.db.batch([
    s.db
      .prepare(
        "INSERT INTO cp_accounts (id, name, owner_user_id, plan, billing_status, deployment_model, enterprise, created_at) VALUES (?, ?, ?, 'enterprise', 'contract', ?, ?, ?)",
      )
      .bind(
        accountId,
        values.name || slug,
        user.id,
        model,
        JSON.stringify({ contract: values.contract ?? "" }),
        iso,
      ),
    s.db
      .prepare(
        "INSERT INTO cp_instances (id, account_id, slug, hostname, custom_hostname, placement, cf_account_id, namespace, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
      )
      .bind(
        tenant,
        accountId,
        slug,
        `${slug}.${s.env.SAAS_DOMAIN}`,
        custom,
        model === "managed" ? "customer-account" : "namespace",
        model === "managed" ? values.cf_account || null : null,
        model === "managed" ? null : s.env.DISPATCH_NAMESPACE,
        iso,
        iso,
      ),
  ]);
  if (custom && model === "dedicated" && s.env.SAAS_ZONE_ID) {
    const created = await s.cf.createCustomHostname(s.env.SAAS_ZONE_ID, custom);
    await updateInstance(s.db, tenant, { custom_hostname_status: created.status }, s.now());
  }
  await audit(
    s.db,
    {
      actorKind: "staff",
      actor: staff,
      action: "account.enterprise_created",
      accountId,
      instanceId: tenant,
      detail: { model, custom },
    },
    now,
  );
  if (model === "dedicated") await s.enqueue({ kind: "provision", instanceId: tenant });
  return redirect(`/admin/instances/${tenant}`);
}

// ---- Fake mode: the fake Stripe's pages and the mailbox ------------------------------------------

async function devRoutes(s: Services, request: Request, url: URL): Promise<Response> {
  const fake = s.fake;
  if (!fake) return new Response("Not Found", { status: 404 });
  const deliver = (events: ReturnType<typeof fake.stripe.completeCheckout>) =>
    fake.stripe.deliver(events, s.stripeWebhookSecret, (body, signature) =>
      stripeWebhook(
        s,
        new Request(`${url.origin}/api/stripe/webhook`, {
          method: "POST",
          body,
          headers: { "stripe-signature": signature },
        }),
      ),
    );
  if (url.pathname === "/dev/mail") {
    const to = (url.searchParams.get("to") ?? "").toLowerCase();
    const { results } = await s.db
      .prepare("SELECT * FROM cp_dev_mail WHERE to_address = ? ORDER BY created_at DESC LIMIT 20")
      .bind(to)
      .all<{ subject: string; body: string; created_at: string }>();
    return page(
      "Fake mailbox",
      html`<h1>Mail to ${to}</h1>${results.map((m) => html`<div class="card"><strong>${m.subject}</strong> <span class="muted">${m.created_at}</span><pre style="white-space:pre-wrap">${m.body}</pre></div>`)}`,
    );
  }
  if (url.pathname === "/dev/tenant") {
    // A request to a tenant hostname, through the dispatch logic and the fake namespace (the
    // browser cannot resolve <org>.relationshiposcrm.com locally).
    const host = url.searchParams.get("host") ?? "";
    const path = url.searchParams.get("path") ?? "/";
    if (!/^[a-z0-9.-]+$/.test(host) || !path.startsWith("/")) return new Response("Bad request", { status: 400 });
    return s.healthFetch(`https://${host}${path}`);
  }
  let m = /^\/dev\/stripe\/checkout\/([\w-]+)$/.exec(url.pathname);
  if (m) {
    const id = m[1] as string;
    const session = fake.stripe.sessions.get(id);
    if (!session) return new Response("No such session", { status: 404 });
    if (request.method === "POST") {
      await deliver(fake.stripe.completeCheckout(id));
      return redirect(
        session.mode === "payment" ? "/account?credit=done" : "/account?checkout=done",
      );
    }
    const what =
      session.mode === "payment"
        ? `AI credit $${(session.amountCents ?? 0) / 100}`
        : `Subscription ${session.metadata.plan ?? ""}${session.trialDays ? ` with a ${session.trialDays}-day trial` : ""}`;
    return page(
      "Fake checkout",
      html`<h1>Fake Stripe Checkout</h1><div class="card"><p>${what}</p><form method="post"><button>Pay</button></form></div>`,
    );
  }
  m = /^\/dev\/stripe\/portal$/.exec(url.pathname);
  if (m) {
    const customer = url.searchParams.get("customer") ?? "";
    if (request.method === "POST") {
      const values = await form(request);
      const change = values.change ?? "";
      const changes: Record<string, { status?: string; planPrice?: string }> = {
        cancel: { status: "canceled" },
        past_due: { status: "past_due" },
        unpaid: { status: "unpaid" },
        recover: { status: "active" },
        team: { planPrice: s.prices.team },
        business: { planPrice: s.prices.business },
      };
      const wanted = changes[change];
      if (wanted) await deliver(fake.stripe.changeSubscription(customer, wanted));
      return redirect("/account");
    }
    const button = (change: string, label: string) =>
      html`<form class="inline" method="post"><input type="hidden" name="change" value="${change}"><button class="secondary">${label}</button></form>`;
    return page(
      "Fake billing portal",
      html`<h1>Fake Stripe billing portal</h1><div class="card">${button("team", "Switch to Team")}${button("business", "Switch to Business")}${button("past_due", "Renewal fails")}${button("unpaid", "Becomes unpaid")}${button("recover", "Payment recovered")}${button("cancel", "Cancel subscription")}</div><p><a href="/account">Back</a></p>`,
    );
  }
  return new Response("Not Found", { status: 404 });
}

/** The service-binding entrypoint ros-dispatch calls to wake a paused tenant. */
export async function wakeTenant(s: Services, tenantId: string): Promise<boolean> {
  return changeLifecycle(s, tenantId, "wake", { kind: "system", id: "dispatch" }, "sign-in");
}
