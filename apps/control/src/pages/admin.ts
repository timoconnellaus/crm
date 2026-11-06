// The admin console (staff only): customers, plans, usage, health, release waves, support grants
// and the audit log. Staff cannot see customer data from here; support access needs a grant the
// customer approved.
import type { AuditRow } from "../audit.ts";
import type { AccountRow, InstanceRow } from "../db.ts";
import type { MonthUsage } from "../metering.ts";
import { PLANS } from "../plans.ts";
import type { RolloutRow, TargetRow } from "../rollout.ts";
import { type GrantRow, SUPPORT_ROLES } from "../support.ts";
import { dollars } from "../util.ts";
import { html, type Raw } from "./layout.ts";

export interface CustomerLine {
  account: AccountRow;
  instance: InstanceRow | null;
  owner: string | null;
}

export function adminHome(input: {
  customers: CustomerLine[];
  rollouts: RolloutRow[];
  versions: string[];
  flash?: string | undefined;
}): Raw {
  return html`<h1>Admin</h1>${input.flash ? html`<p class="ok">${input.flash}</p>` : ""}
<p><a href="/admin/audit">Audit log</a> · <a href="/admin/enterprise">New enterprise customer</a> · <a href="/admin/marketplace">Marketplace</a></p>
<h2>Customers (${input.customers.length})</h2>
<div class="table-wrap"><table><tr><th>Workspace</th><th>Owner</th><th>Plan</th><th>Billing</th><th>Status</th><th>Release</th><th>Last active</th></tr>
${input.customers.map(
  ({ account, instance, owner }) =>
    html`<tr><td>${instance ? html`<a href="/admin/instances/${instance.id}">${instance.slug}</a>` : account.name}</td><td>${owner ?? ""}</td><td>${PLANS[account.plan].name}${account.deployment_model !== "saas" ? html` <span class="badge">${account.deployment_model}</span>` : ""}</td><td>${account.billing_status}</td><td>${instance?.status ?? "—"}${instance?.cohort === "canary" ? html` <span class="badge">canary</span>` : ""}</td><td>${instance?.version ?? "—"}</td><td>${instance?.last_activity_at?.slice(0, 10) ?? "—"}</td></tr>`,
)}</table></div>
<h2>Releases</h2>
<form method="post" action="/admin/rollouts" class="card">
<label for="version">Roll out release</label><select id="version" name="version">${input.versions.map((v) => html`<option>${v}</option>`)}</select>
<label for="max_failures">Failures tolerated per wave before pausing</label><input id="max_failures" name="max_failures" type="number" min="0" value="0">
<p class="muted">Waves: canary cohort → 10% → all. Each deployment is updated with a database bookmark and rolled back automatically if its health check fails.</p>
<button>Start rollout</button></form>
<div class="table-wrap"><table><tr><th>Rollout</th><th>Release</th><th>Status</th><th>Started</th></tr>
${input.rollouts.map((r) => html`<tr><td><a href="/admin/rollouts/${r.id}">${r.id}</a></td><td>${r.version}</td><td>${r.status}</td><td>${r.created_at.slice(0, 16).replace("T", " ")}</td></tr>`)}
</table></div>`;
}

export function adminInstance(input: {
  account: AccountRow;
  instance: InstanceRow;
  owner: string | null;
  usage: MonthUsage;
  grants: GrantRow[];
  audit: AuditRow[];
  health: string | null;
  flash?: string | undefined;
  error?: string | undefined;
}): Raw {
  const { account, instance } = input;
  const action = (name: string, label: string, cls = "secondary") =>
    html`<form class="inline" method="post" action="/admin/instances/${instance.id}/${name}"><button class="${cls}">${label}</button></form>`;
  return html`<h1>${instance.slug}</h1>
${input.flash ? html`<p class="ok">${input.flash}</p>` : ""}${input.error ? html`<p class="bad">${input.error}</p>` : ""}
<div class="card"><table>
<tr><th>Account</th><td>${account.name} (${account.id})</td></tr>
<tr><th>Owner</th><td>${input.owner ?? ""}</td></tr>
<tr><th>Plan</th><td>${PLANS[account.plan].name} · ${account.billing_status} · ${account.deployment_model}</td></tr>
<tr><th>Hostname</th><td>${instance.hostname}${instance.custom_hostname ? html` · ${instance.custom_hostname} (${instance.custom_hostname_status ?? "pending"})` : ""}</td></tr>
<tr><th>Placement</th><td>${instance.placement}${instance.namespace ? html` · ${instance.namespace}` : ""}</td></tr>
<tr><th>Status</th><td>${instance.status}${instance.suspended_reason ? html` (${instance.suspended_reason})` : ""}${instance.error ? html` <span class="bad">${instance.error}</span>` : ""}</td></tr>
<tr><th>Release</th><td>${instance.version ?? "—"} · cohort ${instance.cohort}</td></tr>
<tr><th>Health</th><td>${input.health ?? html`<span class="muted">not checked</span>`}</td></tr>
<tr><th>AI this month</th><td>${input.usage.requests} requests · cost ${dollars(input.usage.providerCostMicros)} · billed ${dollars(input.usage.chargedMicros)} · overage ${dollars(input.usage.overageCents * 10_000)}</td></tr>
${account.plan === "free" ? html`<tr><th>AI credit</th><td>${dollars(account.ai_credit_micros)}</td></tr>` : ""}
</table>
${action("health", "Check health")}
${instance.status === "active" ? action("pause", "Pause") : ""}
${instance.status === "paused" ? action("wake", "Wake") : ""}
${["active", "paused"].includes(instance.status) ? action("suspend", "Suspend", "danger") : ""}
${instance.status === "suspended" ? action("resume", "Resume") : ""}
${["pending", "failed"].includes(instance.status) ? action("provision", "Provision") : ""}
${action("cohort", instance.cohort === "canary" ? "Move to general cohort" : "Move to canary cohort")}
${instance.custom_hostname && instance.custom_hostname_status !== "active" ? action("custom-hostname", "Check custom hostname") : ""}
</div>
<h2>Support access</h2>
<p class="muted">Ask the customer for access. An admin of their workspace must approve it there; it expires on its own and every action is audited in their workspace and here.</p>
<form method="post" action="/admin/instances/${instance.id}/grants" class="card">
<label for="reason">Reason (the customer sees this)</label><textarea id="reason" name="reason" required maxlength="500"></textarea>
<label for="role">Access</label><select id="role" name="role">${SUPPORT_ROLES.map((r) => html`<option>${r}</option>`)}</select>
<label for="minutes">Duration (minutes, at most 72 hours)</label><input id="minutes" name="minutes" type="number" min="15" max="4320" value="120">
<button>Request access</button></form>
<div class="table-wrap"><table><tr><th>Grant</th><th>Staff</th><th>Reason</th><th>Status</th><th></th></tr>
${input.grants.map(
  (g) =>
    html`<tr><td>${g.id}</td><td>${g.staff_email}</td><td>${g.reason}</td><td>${g.status}${g.expires_at ? html` until ${g.expires_at.slice(0, 16).replace("T", " ")}` : ""}</td><td>
<form class="inline" method="post" action="/admin/grants/${g.id}/open"><button>Open session</button></form>
<form class="inline" method="post" action="/admin/grants/${g.id}/revoke"><button class="secondary">Revoke</button></form></td></tr>`,
)}</table></div>
<h2>Audit</h2>${auditTable(input.audit)}`;
}

export function auditTable(rows: AuditRow[]): Raw {
  return html`<div class="table-wrap"><table><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr>
${rows.map((r) => html`<tr><td>${r.at.slice(0, 19).replace("T", " ")}</td><td>${r.actor_kind}: ${r.actor}</td><td>${r.action}</td><td><code>${r.detail ?? ""}</code></td></tr>`)}
</table></div>`;
}

export function adminRollout(input: { rollout: RolloutRow; targets: TargetRow[] }): Raw {
  const { rollout } = input;
  const waves = JSON.parse(rollout.waves) as { name: string }[];
  return html`<h1>Rollout ${rollout.version}</h1>
<p>Status <strong>${rollout.status}</strong> · wave ${waves[rollout.current_wave]?.name ?? rollout.current_wave} · failures tolerated per wave ${rollout.max_failures}</p>
${rollout.status === "paused" ? html`<form class="inline" method="post" action="/admin/rollouts/${rollout.id}/resume"><button>Resume (accept this wave's failures)</button></form>` : ""}
${["paused", "running", "completed"].includes(rollout.status) ? html`<form class="inline" method="post" action="/admin/rollouts/${rollout.id}/rollback"><button class="danger">Roll back every updated workspace</button></form><p class="muted">Rolling back restores each workspace's database to its pre-update bookmark: changes made since the update are lost.</p>` : ""}
<div class="table-wrap"><table><tr><th>Workspace</th><th>Wave</th><th>From</th><th>Status</th><th>Error</th></tr>
${input.targets.map((t) => html`<tr><td><a href="/admin/instances/${t.instance_id}">${t.instance_id}</a></td><td>${waves[t.wave]?.name ?? t.wave}</td><td>${t.from_version ?? ""}</td><td>${t.status}</td><td>${t.error ?? ""}</td></tr>`)}
</table></div>`;
}

export function enterpriseForm(error?: string): Raw {
  return html`<h1>New enterprise customer</h1>${error ? html`<p class="bad">${error}</p>` : ""}
<form method="post" action="/admin/enterprise" class="card">
<label for="email">Owner email</label><input id="email" name="email" type="email" required>
<label for="name">Organisation</label><input id="name" name="name" required>
<label for="slug">Workspace address</label><input id="slug" name="slug" required>
<label for="model">Deployment</label><select id="model" name="model"><option value="dedicated">Dedicated, in our account</option><option value="managed">Managed, in the customer's Cloudflare account (runbook)</option></select>
<label for="custom_hostname">Custom hostname (optional, e.g. crm.example.com)</label><input id="custom_hostname" name="custom_hostname">
<label for="cf_account">Customer's Cloudflare account id (managed only)</label><input id="cf_account" name="cf_account">
<label for="contract">Contract terms (SLA, SSO, reference)</label><textarea id="contract" name="contract"></textarea>
<button>Create</button></form>
<p class="muted">Enterprise customers are invoiced by contract; Stripe is optional. Dedicated deployments are provisioned here like SaaS; managed ones are installed and updated by runbook (docs/saas-go-live.md).</p>`;
}
