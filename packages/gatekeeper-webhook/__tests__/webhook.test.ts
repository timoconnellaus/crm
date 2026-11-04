import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import type { ObservationDescription } from "@crm/gatekeeper-interface/gatekeeper";
import { describe, expect, it, vi } from "vitest";
import type { EndpointConfigured } from "../src/configurator/endpoint-configurator-types.js";
import type { EndpointStatus } from "../src/endpoint.js";
import type { WebhookEndpointInfo, WebhookEvent, WebhookScheme } from "../src/types.js";
import { signForScheme } from "../src/verify.js";

const BASE = "https://crm.example.com/gatekeeper/webhook";

type Ui = {
  configure(input: unknown): Promise<EndpointConfigured>;
  status(endpointId: unknown): Promise<EndpointStatus & { url: string }>;
  resourceUrl(endpointId: unknown): Promise<string>;
};

type Account = {
  describe(): Promise<{ displayName: string }>;
  getSupportedResources(): Promise<{ urlPattern: string; title: string; grantable?: boolean }[]>;
  getGatekeeperClassFor(url: string): Promise<unknown>;
  startResourceConfigurator(pattern: string): Promise<{ iframeHtml: string; ui: Ui }>;
};

// The RPC stub types of entrypoints returned over RPC collapse; these are the shapes used here.
const vendor = exports.GatekeeperVendor as unknown as {
  describe(): Promise<{ displayName: string; autoProvisionsAccount?: boolean }>;
  createAccount(): Promise<Account>;
  connectAccount(callback: unknown): Promise<unknown>;
  getSupportedResources(): Promise<{ urlPattern: string; title: string; grantable?: boolean }[]>;
  getTypeScriptTypes(): Promise<string>;
};

let counter = 0;
/** A fresh endpoint id per test, so tests never share an endpoint's storage. */
function newEndpointId(): string {
  return `ep-${Date.now().toString(36)}-${(counter++).toString(36)}`;
}

async function ui(): Promise<Ui> {
  const account = await vendor.createAccount();
  const frame = await account.startResourceConfigurator("webhook://endpoint/:endpointId");
  return frame.ui;
}

async function configure(scheme: WebhookScheme, secret?: string): Promise<EndpointConfigured> {
  return (await ui()).configure({ endpointId: newEndpointId(), scheme, secret });
}

/** TestHost as called here: its stub types collapse results carrying `unknown` to `never`. */
type Host = {
  describe(endpointId: string): Promise<unknown>;
  call(
    endpointId: string,
    method: "getEndpoint" | "listEvents",
    ...args: unknown[]
  ): Promise<{ result?: unknown; error?: string; observations: ObservationDescription[] }>;
  bindAndEnable(endpointId: string, key: string): Promise<{ title: string; description: string }>;
  disable(endpointId: string): Promise<void>;
  received(
    key: string,
  ): Promise<{ events: WebhookEvent[]; observations: ObservationDescription[] }>;
  failNext(key: string, count: number): Promise<void>;
};

function host(): Host {
  return env.TEST_HOST.get(env.TEST_HOST.idFromName("host")) as unknown as Host;
}

function post(
  endpointId: string,
  body: string,
  headers: Record<string, string>,
): Promise<Response> {
  return exports.default.fetch(
    new Request(`${BASE}/in/${endpointId}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    }),
  );
}

const now = () => Math.floor(Date.now() / 1000);

type Case = {
  scheme: WebhookScheme;
  body: string;
  /** Provider headers that are not part of the signature. */
  headers: Record<string, string>;
  expectedId: string;
  expectedType: string;
  /** The header that carries the signature, which must never reach the event. */
  signatureHeader: string;
  /** Whether the scheme signs a timestamp. */
  timestamped: boolean;
};

const CASES: Case[] = [
  {
    scheme: "hmac-sha256",
    body: JSON.stringify({ type: "order.created", order: { id: 7 } }),
    headers: { "X-Webhook-Id": "delivery-1" },
    expectedId: "delivery-1",
    expectedType: "order.created",
    signatureHeader: "x-webhook-signature",
    timestamped: true,
  },
  {
    scheme: "github",
    body: JSON.stringify({ action: "opened", issue: { number: 12 } }),
    headers: {
      "X-GitHub-Event": "issues",
      "X-GitHub-Delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
    },
    expectedId: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
    expectedType: "github.issues.opened",
    signatureHeader: "x-hub-signature-256",
    timestamped: false,
  },
  {
    scheme: "stripe",
    body: JSON.stringify({ id: "evt_1NG8Du2eZvKYlo2CUI79vXWy", type: "invoice.paid", data: {} }),
    headers: {},
    expectedId: "evt_1NG8Du2eZvKYlo2CUI79vXWy",
    expectedType: "invoice.paid",
    signatureHeader: "stripe-signature",
    timestamped: true,
  },
  {
    scheme: "slack",
    body: JSON.stringify({
      type: "event_callback",
      event_id: "Ev08MFMKH6",
      event: { type: "app_mention", text: "hi" },
    }),
    headers: {},
    expectedId: "Ev08MFMKH6",
    expectedType: "slack.app_mention",
    signatureHeader: "x-slack-signature",
    timestamped: true,
  },
];

describe.each(CASES)("$scheme deliveries", (c) => {
  it("accepts a valid signature and shapes the typed event", async () => {
    const { endpointId, secret } = await configure(c.scheme);
    const signed = await signForScheme(c.scheme, secret, c.body, now());
    const response = await post(endpointId, c.body, { ...c.headers, ...signed });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, id: c.expectedId });

    const listed = await host().call(endpointId, "listEvents");
    const events = listed.result as WebhookEvent[];
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event).toMatchObject({
      id: c.expectedId,
      endpointId,
      scheme: c.scheme,
      type: c.expectedType,
      payload: JSON.parse(c.body),
    });
    expect(Number.isNaN(Date.parse(event?.receivedAt ?? ""))).toBe(false);
    expect(event?.headers["content-type"]).toBe("application/json");
    expect(Object.keys(event?.headers ?? {})).not.toContain(c.signatureHeader);
    expect(JSON.stringify(event)).not.toContain(secret);
  });

  it("rejects bad, missing, wrong-secret and stale signatures with 401 and delivers nothing", async () => {
    const { endpointId, secret } = await configure(c.scheme);
    const key = `${endpointId}-hook`;
    await host().bindAndEnable(endpointId, key);

    const signed = await signForScheme(c.scheme, secret, c.body, now());
    const tampered = c.body.replace("}", ',"x":1}');
    const wrongSecret = await signForScheme(c.scheme, "not-the-secret-at-all", c.body, now());
    const attempts: [string, Record<string, string>][] = [
      ["bad signature", { ...c.headers, ...signed }],
      ["missing signature", { ...c.headers }],
      ["wrong secret", { ...c.headers, ...wrongSecret }],
    ];
    if (c.timestamped) {
      const stale = await signForScheme(c.scheme, secret, c.body, now() - 10 * 60);
      attempts.push(["stale timestamp", { ...c.headers, ...stale }]);
    }
    for (const [label, headers] of attempts) {
      const response = await post(
        endpointId,
        label === "bad signature" ? tampered : c.body,
        headers,
      );
      expect(response.status, label).toBe(401);
      const body = (await response.json()) as { ok: boolean; error: string };
      expect(body.ok, label).toBe(false);
      expect(typeof body.error).toBe("string");
    }

    const status = await (await ui()).status(endpointId);
    expect(status).toMatchObject({ accepted: 0, rejected: attempts.length, hookEnabled: true });
    expect(((await host().call(endpointId, "listEvents")).result as unknown[]).length).toBe(0);
    // A valid delivery afterwards is the only one the hook receives.
    expect((await post(endpointId, c.body, { ...c.headers, ...signed })).status).toBe(200);
    await vi.waitFor(async () => expect((await host().received(key)).events).toHaveLength(1));
    expect((await host().received(key)).events[0]?.id).toBe(c.expectedId);
  });
});

describe("generic hmac-sha256 details", () => {
  it("verifies an untimestamped signature over the raw body", async () => {
    const { endpointId, secret } = await configure("hmac-sha256");
    const body = "plain text, not JSON";
    const timestamped = await signForScheme("hmac-sha256", secret, body, now());
    // Without a timestamp, the signature is over the body alone.
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
    );
    const hex = [...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const response = await post(endpointId, body, {
      "content-type": "text/plain",
      "X-Webhook-Signature": `sha256=${hex}`,
      "X-Webhook-Event": "custom.thing",
    });
    expect(response.status).toBe(200);
    const [event] = (await host().call(endpointId, "listEvents")).result as WebhookEvent[];
    expect(event).toMatchObject({ type: "custom.thing", payload: { raw: body } });
    // A generated id when the sender gives none.
    expect(event?.id).toMatch(/^[0-9a-f-]{36}$/);
    // The timestamped signature does not verify without its timestamp header.
    const { "X-Webhook-Signature": onlySignature } = timestamped;
    const refused = await post(endpointId, body, { "X-Webhook-Signature": onlySignature ?? "" });
    expect(refused.status).toBe(401);
  });

  it("falls back to `webhook` when neither header nor payload names a type", async () => {
    const { endpointId, secret } = await configure("hmac-sha256");
    const body = JSON.stringify({ hello: "world" });
    const response = await post(
      endpointId,
      body,
      await signForScheme("hmac-sha256", secret, body, now()),
    );
    expect(response.status).toBe(200);
    const [event] = (await host().call(endpointId, "listEvents")).result as WebhookEvent[];
    expect(event?.type).toBe("webhook");
  });
});

describe("stripe details", () => {
  it("accepts a header carrying several v1 signatures when one matches", async () => {
    const { endpointId, secret } = await configure("stripe", "whsec_test_0123456789abcdef");
    expect(secret).toBe("whsec_test_0123456789abcdef");
    const body = JSON.stringify({ id: "evt_multi", type: "customer.created" });
    const t = now();
    const good = (await signForScheme("stripe", secret, body, t))["Stripe-Signature"] ?? "";
    const goodHex = good.split("v1=")[1];
    const header = `t=${t},v1=${"0".repeat(64)},v1=${goodHex},v0=ignored`;
    const response = await post(endpointId, body, { "Stripe-Signature": header });
    expect(response.status).toBe(200);
  });
});

describe("slack url_verification", () => {
  it("answers the challenge after verifying, and stores nothing", async () => {
    const { endpointId, secret } = await configure("slack");
    const body = JSON.stringify({
      token: "x",
      challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P",
      type: "url_verification",
    });
    const response = await post(
      endpointId,
      body,
      await signForScheme("slack", secret, body, now()),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P",
    });
    expect(((await host().call(endpointId, "listEvents")).result as unknown[]).length).toBe(0);

    const unsigned = await post(endpointId, body, {});
    expect(unsigned.status).toBe(401);
  });
});

describe("replays", () => {
  it("acknowledges a replayed delivery id with 200 but stores and delivers it once", async () => {
    const { endpointId, secret } = await configure("github");
    const key = `${endpointId}-hook`;
    await host().bindAndEnable(endpointId, key);
    const body = JSON.stringify({ zen: "Keep it logically awesome." });
    const headers = {
      "X-GitHub-Event": "ping",
      "X-GitHub-Delivery": "replayed-delivery",
      ...(await signForScheme("github", secret, body, now())),
    };
    const first = await post(endpointId, body, headers);
    const second = await post(endpointId, body, headers);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, id: "replayed-delivery", duplicate: true });

    await vi.waitFor(async () => expect((await host().received(key)).events).toHaveLength(1));
    expect(((await host().call(endpointId, "listEvents")).result as unknown[]).length).toBe(1);
    expect(await (await ui()).status(endpointId)).toMatchObject({ accepted: 1, duplicates: 1 });
  });
});

describe("routing and limits", () => {
  it("answers 404 for an endpoint that is not configured", async () => {
    const response = await post(newEndpointId(), "{}", {
      "X-Webhook-Signature": `sha256=${"0".repeat(64)}`,
    });
    expect(response.status).toBe(404);
  });

  it("answers 404 for an invalid endpoint id or another path", async () => {
    expect((await post("NOT_VALID", "{}", {})).status).toBe(404);
    const other = await exports.default.fetch(new Request(`${BASE}/elsewhere`, { method: "POST" }));
    expect(other.status).toBe(404);
  });

  it("answers 405 to a GET of a delivery URL", async () => {
    const { endpointId } = await configure("github");
    const response = await exports.default.fetch(new Request(`${BASE}/in/${endpointId}`));
    expect(response.status).toBe(405);
  });

  it("answers 413 to a body over 256 KB, before verifying anything", async () => {
    const { endpointId, secret } = await configure("github");
    const body = JSON.stringify({ blob: "x".repeat(300 * 1024) });
    const response = await post(
      endpointId,
      body,
      await signForScheme("github", secret, body, now()),
    );
    expect(response.status).toBe(413);
    expect(await (await ui()).status(endpointId)).toMatchObject({ accepted: 0, rejected: 0 });
  });

  it("answers 413 to a streamed body over the limit without a content-length", async () => {
    const { endpointId } = await configure("github");
    const chunk = new Uint8Array(64 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ >= 5) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const response = await exports.default.fetch(
      new Request(`${BASE}/in/${endpointId}`, { method: "POST", body: stream }),
    );
    expect(response.status).toBe(413);
  });
});

describe("the hook, end to end", () => {
  it("binds through the session, is enabled by the host, and receives typed events", async () => {
    const { endpointId, secret } = await configure("stripe");
    const key = `${endpointId}-hook`;
    const bound = await host().bindAndEnable(endpointId, key);
    expect(bound.title).toContain(endpointId);
    expect(bound.description).toContain(`${BASE}/in/${endpointId}`);

    const body = JSON.stringify({
      id: "evt_hook_1",
      type: "charge.succeeded",
      data: { amount: 100 },
    });
    const response = await post(
      endpointId,
      body,
      await signForScheme("stripe", secret, body, now()),
    );
    expect(response.status).toBe(200);

    await vi.waitFor(async () => expect((await host().received(key)).events).toHaveLength(1));
    const { events, observations } = await host().received(key);
    expect(events[0]).toMatchObject({
      id: "evt_hook_1",
      endpointId,
      scheme: "stripe",
      type: "charge.succeeded",
      payload: { id: "evt_hook_1", type: "charge.succeeded", data: { amount: 100 } },
    });
    // Each firing records an observation through startHook()'s queue first.
    expect(observations[0]?.title).toBe("Webhook event charge.succeeded");
  });

  it("delivers nothing once the host disables the hook", async () => {
    const { endpointId, secret } = await configure("github");
    const key = `${endpointId}-hook`;
    await host().bindAndEnable(endpointId, key);
    await host().disable(endpointId);
    expect((await (await ui()).status(endpointId)).hookEnabled).toBe(false);

    const body = JSON.stringify({ action: "created" });
    const headers = {
      "X-GitHub-Event": "star",
      "X-GitHub-Delivery": "after-disable",
      ...(await signForScheme("github", secret, body, now())),
    };
    expect((await post(endpointId, body, headers)).status).toBe(200);
    // Stored for listEvents, but no hook fires.
    expect(((await host().call(endpointId, "listEvents")).result as unknown[]).length).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await host().received(key)).events).toHaveLength(0);
  });

  it("keeps a failed delivery queued for retry rather than losing it", async () => {
    const { endpointId, secret } = await configure("github");
    const key = `${endpointId}-hook`;
    await host().bindAndEnable(endpointId, key);
    await host().failNext(key, 1);
    const body = JSON.stringify({ action: "closed" });
    const headers = {
      "X-GitHub-Event": "issues",
      "X-GitHub-Delivery": "will-retry",
      ...(await signForScheme("github", secret, body, now())),
    };
    expect((await post(endpointId, body, headers)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 200));
    // The first attempt threw; the retry is scheduled (a minute out), so nothing has arrived yet.
    expect((await host().received(key)).events).toHaveLength(0);
    const stub = env.WEBHOOK_ENDPOINT.get(env.WEBHOOK_ENDPOINT.idFromName(endpointId));
    const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThan(Date.now() + 30_000);
    expect(alarm).toBeLessThanOrEqual(Date.now() + 61_000);
  });
});

describe("the session", () => {
  it("describes the facet", async () => {
    const endpointId = newEndpointId();
    expect(await host().describe(endpointId)).toEqual({
      url: `webhook://endpoint/${endpointId}`,
      title: `Webhook endpoint ${endpointId}`,
      snippet: `Receive signed events posted to ${BASE}/in/${endpointId}.`,
      suggestedBindingName: "WEBHOOK",
      tsType: "WebhookSession",
      hookTsType: "WebhookEventHook",
    });
  });

  it("reports the endpoint without its secret", async () => {
    const { endpointId, secret } = await configure("slack");
    const { result, observations } = await host().call(endpointId, "getEndpoint");
    expect(result as WebhookEndpointInfo).toEqual({
      endpointId,
      url: `${BASE}/in/${endpointId}`,
      scheme: "slack",
      configured: true,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(observations).toHaveLength(0);
  });

  it("reports an unconfigured endpoint", async () => {
    const endpointId = newEndpointId();
    const { result } = await host().call(endpointId, "getEndpoint");
    expect(result).toMatchObject({ endpointId, configured: false });
  });

  it("authorizes listEvents as an observation and validates its limit", async () => {
    const { endpointId, secret } = await configure("github");
    for (const id of ["a1", "a2", "a3"]) {
      const body = JSON.stringify({ n: id });
      const headers = {
        "X-GitHub-Event": "push",
        "X-GitHub-Delivery": id,
        ...(await signForScheme("github", secret, body, now())),
      };
      expect((await post(endpointId, body, headers)).status).toBe(200);
    }
    const { result, observations } = await host().call(endpointId, "listEvents", { limit: 2 });
    expect((result as WebhookEvent[]).map((event) => event.id)).toEqual(["a3", "a2"]);
    expect(observations.at(-1)?.title).toBe(`List webhook events (${endpointId})`);

    for (const limit of [0, 101, 1.5, "5"]) {
      const refused = await host().call(endpointId, "listEvents", { limit });
      expect(refused.error).toContain("limit must be");
    }
  });
});

describe("secret configuration through the ui capability", () => {
  it("generates a 32-byte hex secret, returned once and never readable again", async () => {
    const capability = await ui();
    const endpointId = newEndpointId();
    const configured = await capability.configure({ endpointId, scheme: "hmac-sha256" });
    expect(configured).toEqual({
      endpointId,
      scheme: "hmac-sha256",
      secret: expect.stringMatching(/^[0-9a-f]{64}$/),
      url: `${BASE}/in/${endpointId}`,
    });
    const status = await capability.status(endpointId);
    expect(status).toMatchObject({ endpointId, configured: true, scheme: "hmac-sha256" });
    expect(JSON.stringify(status)).not.toContain(configured.secret);

    // Reconfiguring rotates the secret: the old one stops verifying.
    const rotated = await capability.configure({ endpointId, scheme: "hmac-sha256" });
    expect(rotated.secret).not.toBe(configured.secret);
    const body = JSON.stringify({ type: "x" });
    const old = await post(
      endpointId,
      body,
      await signForScheme("hmac-sha256", configured.secret, body, now()),
    );
    expect(old.status).toBe(401);
    const fresh = await post(
      endpointId,
      body,
      await signForScheme("hmac-sha256", rotated.secret, body, now()),
    );
    expect(fresh.status).toBe(200);
  });

  it("refuses invalid input", async () => {
    const capability = await ui();
    await expect(capability.configure({ endpointId: "A", scheme: "github" })).rejects.toThrow(
      /endpointId/,
    );
    await expect(
      capability.configure({ endpointId: newEndpointId(), scheme: "md5" }),
    ).rejects.toThrow(/scheme/);
    await expect(
      capability.configure({ endpointId: newEndpointId(), scheme: "github", secret: "short" }),
    ).rejects.toThrow(/secret/);
    await expect(capability.configure("nope")).rejects.toThrow(/object/);
    await expect(capability.status("../x")).rejects.toThrow(/endpointId/);
  });

  it("builds resource URLs", async () => {
    expect(await (await ui()).resourceUrl("github-main")).toBe("webhook://endpoint/github-main");
  });
});

describe("the vendor and account", () => {
  it("describes an auto-provisioned vendor with one grantable resource type", async () => {
    const description = await vendor.describe();
    expect(description.displayName).toBe("Inbound webhooks");
    expect(description.autoProvisionsAccount).toBe(true);
    expect(await vendor.getSupportedResources()).toEqual([
      expect.objectContaining({
        urlPattern: "webhook://endpoint/:endpointId",
        title: "Webhook endpoint",
        grantable: true,
      }),
    ]);
    await expect(vendor.connectAccount({})).rejects.toThrow(/auto-provisioned/);
  });

  it("serves self-contained session types", async () => {
    const types = await vendor.getTypeScriptTypes();
    for (const name of ["WebhookSession", "WebhookEventHook", "WebhookEvent", "WebhookScheme"]) {
      expect(types).toContain(name);
    }
    expect(types).not.toMatch(/^import /m);
  });

  it("mints accounts that refuse URLs that are not endpoint URLs", async () => {
    const account = await vendor.createAccount();
    expect((await account.describe()).displayName).toBe("Inbound webhooks");
    for (const url of [
      "webhook://endpoint/UPPER",
      "https://example.com/x",
      "webhook://endpoint/a",
    ]) {
      await expect(account.getGatekeeperClassFor(url)).rejects.toThrow(/webhook endpoint URL/);
    }
    await expect(account.startResourceConfigurator("https://other/*")).rejects.toThrow(
      /Unsupported/,
    );
  });
});
