// The landing page's form against the Worker and a real local D1: a browser POST is stored and
// redirected, JSON callers get JSON, bad input and bots store nothing, repeats update one row, and
// a burst is rate limited.
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

const worker = exports.default;

function post(fields: Record<string, string>, init: { json?: boolean; ip?: string } = {}) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return worker.fetch(
    new Request("https://relationshiposcrm.com/api/signup", {
      method: "POST",
      body,
      redirect: "manual",
      headers: {
        "cf-connecting-ip": init.ip ?? crypto.randomUUID(),
        ...(init.json ? { accept: "application/json" } : {}),
      },
    }),
  );
}

const rows = async () =>
  (
    await env.DB.prepare(
      "SELECT kind, email, name, plan, message FROM marketing_signup ORDER BY id",
    ).all()
  ).results;

describe("POST /api/signup", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM marketing_signup");
  });

  it("stores a waitlist signup and redirects a browser to /thanks/", async () => {
    const response = await post({ email: "  Ada@Example.com ", kind: "waitlist" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://relationshiposcrm.com/thanks/");
    expect(await rows()).toEqual([
      { kind: "waitlist", email: "ada@example.com", name: null, plan: null, message: null },
    ]);
  });

  it("answers JSON callers with JSON, and a repeat updates the same row", async () => {
    const first = await post({ email: "grace@example.com", kind: "sales" }, { json: true });
    expect(await first.json()).toEqual({ ok: true });
    await post(
      { email: "grace@example.com", kind: "sales", plan: "enterprise", message: "SSO?" },
      { json: true },
    );
    expect(await rows()).toEqual([
      {
        kind: "sales",
        email: "grace@example.com",
        name: null,
        plan: "enterprise",
        message: "SSO?",
      },
    ]);
  });

  it("refuses an invalid email and stores nothing", async () => {
    const browser = await post({ email: "not-an-email" });
    expect(browser.status).toBe(303);
    expect(browser.headers.get("location")).toBe("https://relationshiposcrm.com/check-form/");
    const json = await post({ email: "nope", kind: "partners" }, { json: true });
    expect(json.status).toBe(400);
    expect(await json.json()).toEqual({ ok: false, error: "invalid" });
    expect(await rows()).toEqual([]);
  });

  it("pretends to accept a bot that fills the honeypot, and stores nothing", async () => {
    const response = await post({ email: "bot@example.com", website: "https://spam.test" });
    expect(response.headers.get("location")).toBe("https://relationshiposcrm.com/thanks/");
    expect(await rows()).toEqual([]);
  });

  it("rate limits a burst from one address", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const response = await post({ email: `p${i}@example.com` }, { json: true, ip: "192.0.2.1" });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses.at(-1)).toBe(429);
  });

  it("only accepts POST, and leaves every other path to the static assets", async () => {
    const get = await worker.fetch(new Request("https://relationshiposcrm.com/api/signup"));
    expect(get.status).toBe(405);
    const other = await worker.fetch(new Request("https://relationshiposcrm.com/api/other"));
    expect(other.status).toBe(404);
    const page = await worker.fetch(new Request("https://relationshiposcrm.com/"));
    expect(await page.text()).toBe("static asset");
  });
});
