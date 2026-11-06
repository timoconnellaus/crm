// The marketplace's staff pages (ADR 0347): the review queue, listings and workspace tokens. Every
// field of a manifest is written by the submitter, so nothing here is trusted: `html` escapes it.
// A manifest can leave things out of its declared access, so the item bodies are shown too.
import type { ListingRow, QueueEntry, TokenRow } from "../marketplace.ts";
import { html, type Raw } from "./layout.ts";

const minute = (iso: string) => iso.slice(0, 16).replace("T", " ");

function access(label: string, values: string[]): Raw {
  return html`<tr><th>${label}</th><td>${values.length ? values.join(", ") : html`<span class="muted">none declared</span>`}</td></tr>`;
}

function reviewCard({ submission, manifest, listed }: QueueEntry): Raw {
  const action = `/admin/marketplace/submissions/${submission.id}`;
  return html`<div class="card"><h2>${manifest.name} <span class="badge">${manifest.version}</span></h2>
<p>${manifest.description}</p>
<table>
<tr><th>Plugin id</th><td><code>${manifest.id}</code></td></tr>
<tr><th>Publisher</th><td>${manifest.publisher}</td></tr>
<tr><th>Submitted by</th><td><code>${submission.submitted_by}</code> at ${minute(submission.created_at)}</td></tr>
<tr><th>Listed now</th><td>${
    listed
      ? html`${listed.version}${listed.delisted ? html` <span class="warn">delisted: approving lists it again</span>` : ""}${listed.owner !== submission.submitted_by ? html` <span class="bad">by another publisher: <code>${listed.owner}</code></span>` : ""}`
      : "new plugin"
  }</td></tr>
${submission.note ? html`<tr><th>Note</th><td>${submission.note}</td></tr>` : ""}
${manifest.whatsNew.length ? html`<tr><th>What's new</th><td>${manifest.whatsNew.join("; ")}</td></tr>` : ""}
${access("Operations", manifest.access.operations)}
${access("Connections", manifest.access.connections)}
${access("Schema", manifest.access.schema)}
${access("In words", manifest.access.words)}
</table>
<h2>Items (${manifest.items.length})</h2>
${manifest.items.map(
  (item) =>
    html`<details><summary><span class="badge">${item.kind}</span> ${item.label} <code>${item.key}</code></summary>${item.description ? html`<p>${item.description}</p>` : ""}<pre style="white-space:pre-wrap;overflow-wrap:anywhere">${JSON.stringify(item.body, null, 2)}</pre></details>`,
)}
<form method="post" action="${action}/approve"><button>Approve and publish</button></form>
<form method="post" action="${action}/reject">
<label for="reason-${submission.id}">Reason (the submitter sees this)</label><textarea id="reason-${submission.id}" name="reason" required maxlength="1000"></textarea>
<button class="danger">Reject</button></form></div>`;
}

export function adminMarketplace(input: {
  open: number;
  queue: QueueEntry[];
  listings: ListingRow[];
  tokens: TokenRow[];
  flash?: string | undefined;
  error?: string | undefined;
}): Raw {
  return html`<h1>Marketplace</h1>
${input.flash ? html`<p class="ok">${input.flash}</p>` : ""}${input.error ? html`<p class="bad">${input.error}</p>` : ""}
<h2>Review queue (${input.open})</h2>
${input.open > input.queue.length ? html`<p class="muted">Showing the oldest ${input.queue.length}.</p>` : ""}
${input.queue.length ? input.queue.map(reviewCard) : html`<p class="muted">Nothing to review.</p>`}
<h2>Listings (${input.listings.length})</h2>
<div class="table-wrap"><table><tr><th>Plugin</th><th>Version</th><th>Publisher</th><th>Installs</th><th>Updated</th><th></th></tr>
${input.listings.map(
  (l) =>
    html`<tr><td>${l.name} <code>${l.plugin_id}</code></td><td>${l.version}</td><td>${l.publisher}</td><td>${l.installs}</td><td>${minute(l.updated_at)}</td><td>${
      l.delisted
        ? html`<span class="badge">delisted</span>`
        : html`<form class="inline" method="post" action="/admin/marketplace/listings/${l.plugin_id}/delist"><button class="danger">Delist</button></form>`
    }</td></tr>`,
)}</table></div>
<h2>Workspace tokens</h2>
<p class="muted">For self-hosted workspaces. Hosted deployments sign their calls and need none.</p>
<form method="post" action="/admin/marketplace/tokens" class="card">
<label for="label">Who it is for</label><input id="label" name="label" required maxlength="120">
<button>Issue token</button></form>
<div class="table-wrap"><table><tr><th>Token</th><th>For</th><th>Issued</th><th>Status</th><th></th></tr>
${input.tokens.map(
  (t) =>
    html`<tr><td><code>${t.id}</code></td><td>${t.label}</td><td>${minute(t.created_at)}</td><td>${t.revoked_at ? `revoked ${minute(t.revoked_at)}` : "active"}</td><td>${
      t.revoked_at
        ? ""
        : html`<form class="inline" method="post" action="/admin/marketplace/tokens/${t.id}/revoke"><button class="secondary">Revoke</button></form>`
    }</td></tr>`,
)}</table></div>`;
}

/** Shown once, straight from the POST: the token never goes in a URL or a log. */
export function tokenIssued(input: { label: string; token: string; origin: string }): Raw {
  return html`<h1>Token for ${input.label}</h1>
<div class="card"><p class="warn">Copy this now. It is not stored and cannot be shown again.</p>
<pre style="white-space:pre-wrap;overflow-wrap:anywhere">${input.token}</pre>
<p>The workspace also needs the marketplace address: <code>${input.origin}</code></p></div>
<p><a href="/admin/marketplace">Back to the marketplace</a></p>`;
}
