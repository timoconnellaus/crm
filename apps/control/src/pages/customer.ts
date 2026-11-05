// Pages a customer sees: sign-in, sign-up with plan choice, and their account.
import type { AccountRow, InstanceRow } from "../db.ts";
import type { ExportRow } from "../lifecycle.ts";
import type { MonthUsage } from "../metering.ts";
import { CREDIT_PACKS_CENTS, PLANS, SELF_SERVE_PLANS } from "../plans.ts";
import type { GrantRow } from "../support.ts";
import { dollars } from "../util.ts";
import { html, type Raw } from "./layout.ts";

export function signInPage(message?: string): Raw {
  return html`<h1>Sign in</h1>
<div class="card"><form method="post" action="/signin">
<label for="email">Email</label><input id="email" name="email" type="email" required autocomplete="email">
<button>Email me a sign-in link</button></form>
${message ? html`<p class="muted">${message}</p>` : ""}</div>
<p>New here? <a href="/signup">Create a workspace</a>.</p>`;
}

export function signUpPage(input: {
  plan?: string;
  error?: string;
  values?: Record<string, string>;
  domain: string;
}): Raw {
  const v = input.values ?? {};
  const chosen = SELF_SERVE_PLANS.includes(input.plan as never) ? input.plan : "free";
  const planCard = (id: (typeof SELF_SERVE_PLANS)[number]) => {
    const p = PLANS[id];
    const price = p.priceCents ? `$${p.priceCents / 100}/month` : "$0";
    const users =
      p.maxUsers === null ? "Unlimited users" : `${p.maxUsers} user${p.maxUsers > 1 ? "s" : ""}`;
    const records =
      p.maxRecords === null
        ? "Unlimited records"
        : `Up to ${p.maxRecords.toLocaleString("en-US")} people + organisations`;
    const ai = p.aiIncludedMicros
      ? `${dollars(p.aiIncludedMicros)} of AI a month included`
      : "Buy AI credit, or bring your own AI over MCP";
    return html`<label><input type="radio" name="plan" value="${id}" ${chosen === id ? html`checked` : ""}><strong>${p.name}</strong> · ${price}<br><span class="muted">${users}. ${records}. ${ai}.${p.paid ? " 14-day free trial." : ""}</span></label>`;
  };
  return html`<h1>Create your workspace</h1>
${input.error ? html`<p class="bad">${input.error}</p>` : ""}
<form method="post" action="/signup" class="card">
<label for="email">Your email</label><input id="email" name="email" type="email" required value="${v.email ?? ""}">
<label for="name">Organisation name</label><input id="name" name="name" required maxlength="80" value="${v.name ?? ""}">
<label for="slug">Workspace address</label><input id="slug" name="slug" required pattern="[a-z0-9-]{3,32}" value="${v.slug ?? ""}" aria-describedby="slug-help">
<p id="slug-help" class="muted">Your workspace will be at <strong>&lt;address&gt;.${input.domain}</strong></p>
<h2>Plan</h2><div class="plans">${SELF_SERVE_PLANS.map(planCard)}</div>
<p class="muted">AI beyond what's included is billed at the provider's cost plus 20%, itemised in dollars. Your own AI keys and MCP clients cost nothing.</p>
<button>Create workspace</button></form>`;
}

const STATUS_TEXT: Record<string, string> = {
  pending: "Waiting to be set up",
  provisioning: "Setting up…",
  active: "Running",
  paused: "Paused while idle — it wakes when you next sign in",
  suspended: "Suspended",
  failed: "Set-up failed — we've been notified",
  deleting: "Being deleted",
  deleted: "Deleted",
};

export function accountPage(input: {
  account: AccountRow;
  instance: InstanceRow | null;
  usage: MonthUsage | null;
  exports: ExportRow[];
  grants: GrantRow[];
  flash?: string | undefined;
}): Raw {
  const { account, instance, usage } = input;
  const plan = PLANS[account.plan];
  const url = instance ? `https://${instance.custom_hostname ?? instance.hostname}` : null;
  const workspace = instance
    ? html`<div class="card"><h2 style="margin-top:0">${account.name}</h2>
<p><strong>${STATUS_TEXT[instance.status] ?? instance.status}</strong>${instance.status === "suspended" && instance.suspended_reason ? html` <span class="muted">(${instance.suspended_reason})</span>` : ""}</p>
${instance.status === "active" || instance.status === "paused" ? html`<p><a class="button" href="${url}">Open ${instance.hostname}</a></p>` : ""}
${instance.status === "pending" && plan.paid ? html`<form method="post" action="/account/start"><button>Continue to payment</button></form>` : ""}
${instance.status === "pending" && !plan.paid ? html`<form method="post" action="/account/start"><button>Set up my workspace</button></form>` : ""}
<p class="muted">Release ${instance.version ?? "—"}</p></div>`
    : html`<div class="card"><p>No workspace yet. <a href="/signup">Create one</a>.</p></div>`;

  const cancelled = account.status === "cancelled";
  const billing = html`<div class="card"><h2 style="margin-top:0">Plan and billing</h2>
<p><strong>${plan.name}</strong>${account.billing_status !== "none" ? html` · <span class="badge">${account.billing_status}</span>` : ""}${account.trial_ends_at && account.billing_status === "trialing" ? html` <span class="muted">trial ends ${account.trial_ends_at.slice(0, 10)}</span>` : ""}</p>
${cancelled ? html`<p class="warn">Cancelled. Your workspace will be deleted on ${account.delete_after?.slice(0, 10)} unless you resubscribe or continue on Free. Export your data before then.</p>` : ""}
${account.stripe_customer_id ? html`<form class="inline" method="post" action="/account/billing"><button class="secondary">Manage billing and invoices</button></form>` : ""}
${!plan.paid || cancelled ? html`<form class="inline" method="post" action="/account/upgrade"><input type="hidden" name="plan" value="team"><button>Upgrade to Team</button></form><form class="inline" method="post" action="/account/upgrade"><input type="hidden" name="plan" value="business"><button class="secondary">Business</button></form>` : ""}
${cancelled ? html`<form class="inline" method="post" action="/account/free"><button class="secondary">Continue on Free</button></form>` : ""}
</div>`;

  const ai = usage
    ? html`<div class="card"><h2 style="margin-top:0">AI this month (${usage.month})</h2>
<table><tr><th>Requests through your AI Gateway</th><td>${usage.requests}</td></tr>
<tr><th>Provider cost</th><td>${dollars(usage.providerCostMicros)}</td></tr>
<tr><th>Billed AI (cost + 20%, your own keys excluded)</th><td>${dollars(usage.chargedMicros)}</td></tr>
${plan.paid ? html`<tr><th>Included in ${plan.name}</th><td>${dollars(usage.includedMicros)}</td></tr><tr><th>Overage billed</th><td>${dollars(usage.overageCents * 10_000)}</td></tr>` : html`<tr><th>AI credit left</th><td>${dollars(account.ai_credit_micros)}</td></tr>`}
</table>
${!plan.paid ? html`<p class="muted">Built-in AI uses your credit. Your own provider keys and MCP clients are free.</p>${CREDIT_PACKS_CENTS.map((c) => html`<form class="inline" method="post" action="/account/credit"><input type="hidden" name="cents" value="${c}"><button class="secondary">Add $${c / 100}</button></form>`)}` : ""}
</div>`
    : "";

  const grants = input.grants.length
    ? html`<div class="card"><h2 style="margin-top:0">Support access requests</h2>
<p class="muted">Our staff can only see your workspace if an admin approves a request in your workspace under Settings → Support access. Access ends when it expires or you revoke it, and every action is in your audit log.</p>
<div class="table-wrap"><table><tr><th>Requested</th><th>Who</th><th>Why</th><th>Status</th></tr>
${input.grants.map((g) => html`<tr><td>${g.created_at.slice(0, 16).replace("T", " ")}</td><td>${g.staff_email}</td><td>${g.reason}</td><td>${g.status}${g.expires_at ? html` until ${g.expires_at.slice(0, 16).replace("T", " ")}` : ""}</td></tr>`)}
</table></div></div>`
    : "";

  const data =
    instance && ["active", "paused", "suspended"].includes(instance.status)
      ? html`<div class="card"><h2 style="margin-top:0">Your data</h2>
<p class="muted">An export is a full SQL dump of your database and read access to your files, sent to your email. It never passes through our systems.</p>
<form class="inline" method="post" action="/account/export"><button class="secondary">Export everything</button></form>
${input.exports.length ? html`<ul>${input.exports.map((e) => html`<li>${e.created_at.slice(0, 16).replace("T", " ")}: ${e.status}${e.status === "ready" && e.d1_url ? html` — <a href="${e.d1_url}">database dump</a>` : ""}${e.error ? html` <span class="bad">${e.error}</span>` : ""}</li>`)}</ul>` : ""}
${cancelled ? html`<form method="post" action="/account/undelete"><button>Keep my workspace</button></form>` : html`<details><summary class="bad">Delete workspace</summary><form method="post" action="/account/delete"><p>Your workspace is suspended now and deleted for good after the grace period. Type <strong>${instance.slug}</strong> to confirm.</p><input name="confirm" required><button class="danger">Delete</button></form></details>`}
</div>`
      : "";

  return html`<h1>Your account</h1>${input.flash ? html`<p class="ok">${input.flash}</p>` : ""}${workspace}${billing}${ai}${data}${grants}`;
}
