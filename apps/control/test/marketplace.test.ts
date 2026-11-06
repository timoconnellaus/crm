// The hosted plugin marketplace (ADR 0347) over HTTP against real D1: who may call it, and that a
// workspace only ever sees what staff reviewed.
import { env } from "cloudflare:workers";
import {
  MARKETPLACE_LISTINGS_PATH as LISTINGS,
  manifestFingerprint,
  marketplaceListingResultSchema,
  marketplaceSearchResultSchema,
  marketplaceSubmissionResultSchema,
  type PluginManifestInput,
  pluginManifestSchema,
  MARKETPLACE_SUBMISSIONS_PATH as SUBMISSIONS,
} from "@relationship-os/agent-plugins";
import { signDeploymentRequest } from "@relationship-os/release";
import { describe, expect, it } from "vitest";
import { changeLifecycle } from "../src/instances.ts";
import { approveSubmission } from "../src/marketplace.ts";
import { tenantChannelKey } from "../src/platform-ai.ts";
import { Browser, instanceFor, ORIGIN, services, signInLink, signUp } from "./helpers.ts";

const STAFF = "staff@relationshiposcrm.com";

function manifest(id: string, version = "1.0.0", over: Partial<PluginManifestInput> = {}) {
  return {
    id,
    name: `Plugin ${id}`,
    version,
    publisher: "Inboxwise",
    description: "Morning renewals brief",
    access: { connections: ["gmail"], words: ["Reads your deals"] },
    items: [{ kind: "skill", key: "brief", label: "Renewal brief", body: { text: "hello" } }],
    ...over,
  } satisfies PluginManifestInput;
}

async function tenantOf(slug: string) {
  await signUp({ email: `owner@${slug}.test`, slug, plan: "free" });
  return (await instanceFor(slug))?.id as string;
}

async function signed(
  tenant: string,
  method: string,
  url: string,
  body = "",
  options: { key?: string } = {},
) {
  const headers = await signDeploymentRequest({
    key: options.key ?? (await tenantChannelKey(services(), tenant)),
    tenant,
    method,
    path: new URL(url, ORIGIN).pathname,
    body,
  });
  return new Browser().request(url, { method, headers, ...(body ? { body } : {}) });
}

function bearer(token: string, url: string, init: RequestInit = {}) {
  return new Browser().request(url, {
    ...init,
    headers: { authorization: `Bearer ${token}` },
  });
}

const submitBy = (tenant: string, body: unknown) =>
  signed(tenant, "POST", SUBMISSIONS, JSON.stringify(body));

async function submitted(tenant: string, body: unknown): Promise<string> {
  const response = await submitBy(tenant, body);
  expect(response.status).toBe(201);
  return marketplaceSubmissionResultSchema.parse(await response.json()).id;
}

async function staffBrowser() {
  const browser = new Browser();
  await browser.post("/signin", { email: STAFF });
  await browser.get(await signInLink(STAFF));
  return browser;
}

async function approve(staff: Browser, id: string) {
  const response = await staff.post(`/admin/marketplace/submissions/${id}/approve`);
  expect(response.status).toBe(303);
  return decodeURIComponent(response.headers.get("location") as string);
}

async function issue(staff: Browser, label: string) {
  const text = await (await staff.post("/admin/marketplace/tokens", { label })).text();
  const token = /ros_mkt_[\w-]+/.exec(text)?.[0];
  if (!token) throw new Error("no token on the page");
  return token;
}

async function search(tenant: string, q = "") {
  const response = await signed(tenant, "GET", `${LISTINGS}?q=${encodeURIComponent(q)}`);
  expect(response.status).toBe(200);
  return marketplaceSearchResultSchema.parse(await response.json()).listings;
}

const audited = (action: string) =>
  env.DB.prepare("SELECT * FROM cp_audit WHERE action = ? ORDER BY at DESC").bind(action).all<{
    actor: string;
    detail: string;
  }>();

describe("who may call the marketplace", () => {
  it("refuses a call with no credentials on every route", async () => {
    const anonymous = new Browser();
    for (const path of [LISTINGS, `${LISTINGS}/some-plugin`, `${SUBMISSIONS}/sub_x`]) {
      expect((await anonymous.get(path)).status).toBe(401);
    }
    const post = await anonymous.request(SUBMISSIONS, {
      method: "POST",
      body: JSON.stringify({ manifest: manifest("no-auth") }),
    });
    expect(post.status).toBe(401);
  });

  it("refuses a bad signature, even with a good token alongside it", async () => {
    const tenant = await tenantOf("badsigco");
    const other = await tenantOf("badsigother");
    const key = await tenantChannelKey(services(), other);
    expect((await signed(tenant, "GET", LISTINGS, "", { key })).status).toBe(401);

    const token = await issue(await staffBrowser(), "Alongside");
    const headers = await signDeploymentRequest({
      key,
      tenant,
      method: "GET",
      path: LISTINGS,
      body: "",
    });
    const response = await new Browser().request(LISTINGS, {
      headers: { ...headers, authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(401);
  });

  it("refuses a signed call for a tenant that does not exist or is suspended", async () => {
    const s = services();
    expect((await signed("tnosuchone", "GET", LISTINGS, "", { key: "x" })).status).toBe(401);
    const tenant = await tenantOf("suspendedmkt");
    const key = await tenantChannelKey(s, tenant);
    await changeLifecycle(s, tenant, "suspend", { kind: "staff", id: "test" }, "billing");
    expect((await signed(tenant, "GET", LISTINGS, "", { key })).status).toBe(401);
  });

  it("accepts a signed read: an empty body, and the query is not part of the signature", async () => {
    const tenant = await tenantOf("signedreadco");
    expect((await signed(tenant, "GET", LISTINGS)).status).toBe(200);
    expect((await signed(tenant, "GET", `${LISTINGS}?q=anything`)).status).toBe(200);
  });

  it("accepts a workspace token until it is revoked, and stores only its hash", async () => {
    const staff = await staffBrowser();
    const token = await issue(staff, "Self-hosted Acme");
    expect((await bearer(token, LISTINGS)).status).toBe(200);
    expect((await bearer(`${token}x`, LISTINGS)).status).toBe(401);
    expect(
      (await new Browser().request(LISTINGS, { headers: { authorization: token } })).status,
    ).toBe(401);

    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'cp_%'",
    ).all<{ name: string }>();
    for (const { name } of tables.results) {
      const rows = await env.DB.prepare(`SELECT * FROM "${name}"`).all();
      expect(JSON.stringify(rows.results)).not.toContain(token);
    }

    const row = await env.DB.prepare("SELECT id FROM cp_marketplace_tokens WHERE label = ?")
      .bind("Self-hosted Acme")
      .first<{ id: string }>();
    await staff.post(`/admin/marketplace/tokens/${row?.id}/revoke`);
    expect((await bearer(token, LISTINGS)).status).toBe(401);
    const issued = await audited("marketplace.token_issued");
    expect(issued.results.some((r) => r.actor === STAFF && r.detail.includes(row?.id ?? "?"))).toBe(
      true,
    );
    expect((await audited("marketplace.token_revoked")).results[0]?.actor).toBe(STAFF);
  });

  it("caps the body, with or without a content-length", async () => {
    const tenant = await tenantOf("bigbodyco");
    const body = JSON.stringify({
      manifest: manifest("big", "1.0.0"),
      note: "x".repeat(1_100_000),
    });
    expect((await submitBy(tenant, JSON.parse(body))).status).toBe(413);
    const token = await issue(await staffBrowser(), "Streams");
    const streamed = new Blob([body]).stream();
    const response = await bearer(token, SUBMISSIONS, {
      method: "POST",
      body: streamed,
      duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(413);
  });
});

describe("submitting and reviewing", () => {
  it("keeps a submission invisible until it is approved, then lists it", async () => {
    const tenant = await tenantOf("publishco");
    const reader = await tenantOf("readerco");
    const id = await submitted(tenant, { manifest: manifest("publish-me"), note: "first go" });

    expect((await search(reader, "publish-me")).length).toBe(0);
    expect((await signed(reader, "GET", `${LISTINGS}/publish-me`)).status).toBe(404);
    const status = await signed(tenant, "GET", `${SUBMISSIONS}/${id}`);
    expect(await status.json()).toEqual({ id, status: "in_review", reason: null });

    const staff = await staffBrowser();
    const queue = await (await staff.get("/admin/marketplace")).text();
    for (const shown of ["publish-me", "Renewal brief", "Reads your deals", "gmail", "first go"]) {
      expect(queue).toContain(shown);
    }

    expect(await approve(staff, id)).toContain("flash=Published.");
    const [found] = await search(reader, "publish-me");
    expect(found).toMatchObject({
      id: "publish-me",
      version: "1.0.0",
      installs: 0,
      adds: [{ kind: "skill", count: 1 }],
      connections: ["gmail"],
    });
    expect(found?.updatedAt).toBeTruthy();

    const response = await signed(reader, "GET", `${LISTINGS}/publish-me`);
    const detail = marketplaceListingResultSchema.parse(await response.json());
    expect(detail.manifest.items[0]?.key).toBe("brief");
    const version = await env.DB.prepare(
      "SELECT fingerprint FROM cp_marketplace_versions WHERE plugin_id = 'publish-me'",
    ).first<{ fingerprint: string }>();
    expect(version?.fingerprint).toBe(
      await manifestFingerprint(pluginManifestSchema.parse(manifest("publish-me"))),
    );
    const status2 = await signed(tenant, "GET", `${SUBMISSIONS}/${id}`);
    expect(await status2.json()).toEqual({ id, status: "approved", reason: null });
    expect((await audited("marketplace.approved")).results[0]?.detail).toContain("publish-me");
  });

  it("does not list a rejected submission, and tells the submitter why", async () => {
    const tenant = await tenantOf("rejectedco");
    const id = await submitted(tenant, { manifest: manifest("reject-me") });
    const staff = await staffBrowser();
    const noReason = await staff.post(`/admin/marketplace/submissions/${id}/reject`);
    expect(noReason.headers.get("location")).toContain("error=");
    await staff.post(`/admin/marketplace/submissions/${id}/reject`, { reason: "Reads too much" });

    expect((await search(tenant, "reject-me")).length).toBe(0);
    expect((await signed(tenant, "GET", `${LISTINGS}/reject-me`)).status).toBe(404);
    const status = await signed(tenant, "GET", `${SUBMISSIONS}/${id}`);
    expect(await status.json()).toEqual({ id, status: "rejected", reason: "Reads too much" });
    expect(await approve(staff, id)).toContain("error=");
    expect((await search(tenant, "reject-me")).length).toBe(0);
    expect((await audited("marketplace.rejected")).results[0]?.detail).toContain("reject-me");
  });

  it("searches name, description and publisher, treating % as a plain character", async () => {
    const tenant = await tenantOf("searchco");
    const staff = await staffBrowser();
    const id = await submitted(tenant, {
      manifest: manifest("search-me", "1.0.0", {
        name: "Zebra desk",
        description: "Stripes for quokkas",
        publisher: "Numbat Labs",
      }),
    });
    await approve(staff, id);
    for (const q of ["zebra", "QUOKKAS", "numbat"]) {
      expect((await search(tenant, q)).map((l) => l.id)).toEqual(["search-me"]);
    }
    expect((await search(tenant, "zeb%sk")).length).toBe(0);
  });

  it("delists: gone from reads, with its install count kept, back on a new approved version", async () => {
    const tenant = await tenantOf("delistco");
    const staff = await staffBrowser();
    await approve(staff, await submitted(tenant, { manifest: manifest("delist-me") }));
    await env.DB.prepare("UPDATE cp_marketplace_listings SET installs = 7 WHERE plugin_id = ?")
      .bind("delist-me")
      .run();

    await staff.post("/admin/marketplace/listings/delist-me/delist");
    expect((await search(tenant, "delist-me")).length).toBe(0);
    expect((await signed(tenant, "GET", `${LISTINGS}/delist-me`)).status).toBe(404);
    expect((await audited("marketplace.delisted")).results[0]?.detail).toContain("delist-me");

    const next = await submitted(tenant, { manifest: manifest("delist-me", "1.1.0") });
    expect(await (await staff.get("/admin/marketplace")).text()).toContain(
      "approving lists it again",
    );
    await approve(staff, next);
    const [listed] = await search(tenant, "delist-me");
    expect(listed).toMatchObject({ version: "1.1.0", installs: 7 });
  });

  it("refuses an equal or older version, by numbers and not by text", async () => {
    const tenant = await tenantOf("versionco");
    const staff = await staffBrowser();
    await approve(staff, await submitted(tenant, { manifest: manifest("versions", "1.9.0") }));
    for (const version of ["1.9.0", "1.8.5", "0.20.0"]) {
      expect((await submitBy(tenant, { manifest: manifest("versions", version) })).status).toBe(
        409,
      );
    }
    await approve(staff, await submitted(tenant, { manifest: manifest("versions", "1.10.0") }));
    const [listed] = await search(tenant, "Plugin versions");
    expect(listed?.version).toBe("1.10.0");
  });

  it("stops an older version waiting in the queue from replacing a newer approved one", async () => {
    const tenant = await tenantOf("staleco");
    const staff = await staffBrowser();
    const older = await submitted(tenant, { manifest: manifest("stale", "1.0.0") });
    const newer = await submitted(tenant, { manifest: manifest("stale", "2.0.0") });
    await approve(staff, newer);
    expect(await approve(staff, older)).toContain("already listed at 2.0.0");
    expect((await search(tenant, "Plugin stale"))[0]?.version).toBe("2.0.0");
  });

  it("does not let another tenant or token take over a plugin id", async () => {
    const owner = await tenantOf("ownerco");
    const rival = await tenantOf("rivalco");
    const staff = await staffBrowser();
    await approve(staff, await submitted(owner, { manifest: manifest("owned") }));

    const takeover = { manifest: manifest("owned", "9.0.0") };
    expect((await submitBy(rival, takeover)).status).toBe(403);
    const token = await issue(staff, "Rival token");
    const response = await bearer(token, SUBMISSIONS, {
      method: "POST",
      body: JSON.stringify(takeover),
    });
    expect(response.status).toBe(403);

    // Nor by getting into the queue before the id was taken.
    const first = await submitted(owner, { manifest: manifest("raced") });
    const second = await submitted(rival, { manifest: manifest("raced", "2.0.0") });
    await approve(staff, first);
    expect(await approve(staff, second)).toContain("listed by another publisher");
    expect((await search(owner, "Plugin raced"))[0]?.version).toBe("1.0.0");

    // The owner can publish, and a delisted id stays theirs.
    await staff.post("/admin/marketplace/listings/owned/delist");
    expect((await submitBy(rival, takeover)).status).toBe(403);
    expect((await submitBy(owner, { manifest: manifest("owned", "1.1.0") })).status).toBe(201);
  });

  it("publishes exactly one of two approvals that race for the same plugin id", async () => {
    const s = services();
    const first = await tenantOf("racefirstco");
    const second = await tenantOf("racesecondco");
    const a = await submitted(first, { manifest: manifest("photo-finish", "1.0.0") });
    const b = await submitted(second, { manifest: manifest("photo-finish", "2.0.0") });
    const outcomes = await Promise.all([
      approveSubmission(s, a, STAFF),
      approveSubmission(s, b, STAFF),
    ]);
    expect(outcomes.filter((problem) => problem === null).length).toBe(1);
    const { results } = await env.DB.prepare(
      "SELECT status FROM cp_marketplace_submissions WHERE plugin_id = 'photo-finish'",
    ).all<{ status: string }>();
    expect(results.map((r) => r.status).sort()).toEqual(["approved", "in_review"]);
    const versions = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM cp_marketplace_versions WHERE plugin_id = 'photo-finish'",
    ).first<{ n: number }>();
    expect(versions?.n).toBe(1);
  });

  it("works end to end with a workspace token", async () => {
    const staff = await staffBrowser();
    const token = await issue(staff, "Self-hosted publisher");
    const post = (version: string) =>
      bearer(token, SUBMISSIONS, {
        method: "POST",
        body: JSON.stringify({ manifest: manifest("token-made", version) }),
      });
    const created = await post("1.0.0");
    expect(created.status).toBe(201);
    const { id } = marketplaceSubmissionResultSchema.parse(await created.json());
    expect((await bearer(token, `${SUBMISSIONS}/${id}`)).status).toBe(200);
    await approve(staff, id);
    expect((await post("1.1.0")).status).toBe(201);
    const read = await bearer(token, `${LISTINGS}/token-made`);
    expect(marketplaceListingResultSchema.parse(await read.json()).listing.version).toBe("1.0.0");
  });

  it("shows a submission only to its submitter", async () => {
    const tenant = await tenantOf("privateco");
    const other = await tenantOf("nosyco");
    const id = await submitted(tenant, { manifest: manifest("private-sub") });
    expect((await signed(other, "GET", `${SUBMISSIONS}/${id}`)).status).toBe(404);
    const token = await issue(await staffBrowser(), "Nosy");
    expect((await bearer(token, `${SUBMISSIONS}/${id}`)).status).toBe(404);
  });

  it("treats a replayed submission as the same one, and a changed one as a conflict", async () => {
    const tenant = await tenantOf("replayco");
    const body = { manifest: manifest("replayed") };
    const id = await submitted(tenant, body);
    const again = await submitBy(tenant, body);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ id, status: "in_review", reason: null });
    const changed = { manifest: manifest("replayed", "1.0.0", { description: "Something else" }) };
    expect((await submitBy(tenant, changed)).status).toBe(409);
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM cp_marketplace_submissions WHERE plugin_id = 'replayed'",
    ).first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("refuses what is not a valid submission", async () => {
    const tenant = await tenantOf("invalidco");
    expect((await signed(tenant, "POST", SUBMISSIONS, "not json")).status).toBe(400);
    const items = { items: [] };
    expect((await submitBy(tenant, { manifest: manifest("bad", "1.0.0", items) })).status).toBe(
      400,
    );
    expect((await submitBy(tenant, { manifest: manifest("Not An Id") })).status).toBe(400);
    expect((await signed(tenant, "DELETE", `${LISTINGS}/bad`)).status).toBe(405);
  });

  it("escapes everything a submitter wrote on the review page", async () => {
    const tenant = await tenantOf("scriptco");
    await submitted(tenant, {
      manifest: manifest("script-me", "1.0.0", {
        name: "<script>alert(1)</script>",
        items: [{ kind: "skill", key: "x", label: "<b>y</b>", body: { a: "</pre><script>" } }],
      }),
    });
    const text = await (await (await staffBrowser()).get("/admin/marketplace")).text();
    expect(text).not.toContain("<script>");
    expect(text).not.toContain("<b>y</b>");
  });
});

describe("the review pages", () => {
  it("are for staff only", async () => {
    const tenant = await tenantOf("customerco");
    const id = await submitted(tenant, { manifest: manifest("staff-only") });
    const { browser: customer } = await signUp({
      email: "owner@customer2.test",
      slug: "customer2",
      plan: "free",
    });
    const routes = [
      `/admin/marketplace/submissions/${id}/approve`,
      `/admin/marketplace/submissions/${id}/reject`,
      "/admin/marketplace/listings/staff-only/delist",
      "/admin/marketplace/tokens",
    ];
    expect((await customer.get("/admin/marketplace")).status).toBe(404);
    for (const route of routes) {
      expect((await customer.post(route, { reason: "x", label: "x" })).status).toBe(404);
    }
    const anonymous = new Browser();
    expect((await anonymous.get("/admin/marketplace")).status).toBe(303);
    for (const route of routes) {
      expect((await anonymous.post(route, { reason: "x", label: "x" })).status).toBe(303);
    }
    // A workspace's credentials open the API, not the console.
    const headers = await signDeploymentRequest({
      key: await tenantChannelKey(services(), tenant),
      tenant,
      method: "GET",
      path: "/admin/marketplace",
      body: "",
    });
    expect((await new Browser().request("/admin/marketplace", { headers })).status).toBe(303);

    const row = await env.DB.prepare("SELECT status FROM cp_marketplace_submissions WHERE id = ?")
      .bind(id)
      .first<{ status: string }>();
    expect(row?.status).toBe("in_review");
    expect((await search(tenant, "staff-only")).length).toBe(0);
  });

  it("links from the admin home", async () => {
    const home = await (await (await staffBrowser()).get("/admin")).text();
    expect(home).toContain('href="/admin/marketplace"');
  });
});
