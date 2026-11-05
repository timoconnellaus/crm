// Hosted support access end to end in ros-app (ADR 0212): an admin approves a grant, support
// enters with a token the control plane signed (a test Ed25519 key here), the cookie makes the
// request the support user, and revoking or expiry refuses the very next request. Plus the plan
// limits as the UI adapter reports them (ADR 0211).
import { env } from "cloudflare:workers";
import { AiAllowanceError, clearEntitlementsCache, newId } from "@relationship-os/core";
import { createCrmDb } from "@relationship-os/db";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { modelsFor } from "../src/server/ai.ts";
import { authorize } from "../src/server/identity.ts";
import { runOperation } from "../src/server/operations.ts";
import {
  base64urlEncode,
  handleSupportRoute,
  SUPPORT_COOKIE,
  SUPPORT_TOKEN_MAX_LIFETIME,
  signSupportCookie,
} from "../src/server/support.ts";

const HOST = "acme.relationshiposcrm.com";
const ORIGIN = `https://${HOST}`;
const page = { handlerType: "router" } as const;

let keys: CryptoKeyPair;
let otherKeys: CryptoKeyPair;
let supportEnv: typeof env & { ROS_SUPPORT_PUBLIC_KEY: string };
const admin = { userId: "", email: "", name: "Admin", roles: [] as string[] };
const member = { userId: "", email: "", name: "Member", roles: [] as string[] };

async function addUser(role: "admin" | "member") {
  const id = newId("user");
  const email = `${role}-${id}@example.com`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
  )
    .bind(id, role, email, now, now)
    .run();
  await env.DB.prepare("UPDATE core_user SET role = ? WHERE id = ?").bind(role, id).run();
  return { userId: id, email };
}

const json = (value: unknown) => base64urlEncode(new TextEncoder().encode(JSON.stringify(value)));

async function token(
  claims: Record<string, unknown>,
  options: { key?: CryptoKey; header?: Record<string, unknown> } = {},
): Promise<string> {
  const header = json(options.header ?? { alg: "EdDSA", typ: "JWT" });
  const payload = json(claims);
  const signature = await crypto.subtle.sign(
    "Ed25519",
    options.key ?? keys.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64urlEncode(signature)}`;
}

function claimsFor(grantId: string, email: string, overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "relationshiposcrm-control",
    aud: HOST,
    sub: grantId,
    email,
    iat: now,
    exp: now + 300,
    jti: crypto.randomUUID(),
    ...overrides,
  };
}

async function requestGrant(role: "admin" | "member" | "viewer" = "member", minutes = 60) {
  const id = `sgr_${newId("user").slice(4)}`;
  const email = `staff-${id}@relationshiposcrm.com`;
  await env.DB.prepare(
    "INSERT INTO core_support_grants (id, staff_email, reason, role, requested_minutes, status, requested_at) VALUES (?, ?, 'Ticket 7', ?, ?, 'requested', ?)",
  )
    .bind(id, email, role, minutes, new Date().toISOString())
    .run();
  return { id, email };
}

async function approve(grantId: string) {
  const result = await runOperation(env, admin, {
    name: "support.grant.approve",
    input: { id: grantId },
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.data as { userId: string; expiresAt: string };
}

function enter(tokenValue: string, e = supportEnv) {
  return handleSupportRoute(
    new Request(`${ORIGIN}/support/enter?token=${encodeURIComponent(tokenValue)}`),
    e,
  );
}

function cookieFrom(response: Response): string {
  const set = response.headers.get("set-cookie") ?? "";
  return set.split(";")[0] as string;
}

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  otherKeys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = (await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer;
  supportEnv = { ...env, ROS_SUPPORT_PUBLIC_KEY: base64urlEncode(raw) };
  Object.assign(admin, await addUser("admin"));
  Object.assign(member, await addUser("member"));
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM core_entitlements").run();
  clearEntitlementsCache();
});

describe("/support/enter", () => {
  it("is a 404 on a self-hosted install (no ROS_SUPPORT_PUBLIC_KEY), and the cookie is ignored", async () => {
    const { id, email } = await requestGrant();
    const approved = await approve(id);
    const response = await enter(await token(claimsFor(id, email)), env);
    expect(response.status).toBe(404);
    const exp = Math.floor(Date.parse(approved.expiresAt) / 1000);
    const cookie = `${SUPPORT_COOKIE}=${await signSupportCookie(id, exp, env.BETTER_AUTH_SECRET)}`;
    const result = await authorize(new Request(`${ORIGIN}/`, { headers: { cookie } }), env, page);
    expect(result.ok).toBe(false);
  });

  it("lets support in as the support user, audits it, and revocation bites on the next request", async () => {
    const { id, email } = await requestGrant("viewer");
    const approved = await approve(id);

    const response = await enter(await token(claimsFor(id, email)));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^ros_support=sgr_[^.]+\.\d+\.[A-Za-z0-9_-]+; /);
    for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age="]) {
      expect(setCookie).toContain(attribute);
    }
    const maxAge = Number(/Max-Age=(\d+)/.exec(setCookie)?.[1]);
    expect(maxAge).toBeGreaterThan(55 * 60);
    expect(maxAge).toBeLessThanOrEqual(60 * 60);
    const cookie = cookieFrom(response);

    const authorized = await authorize(
      new Request(`${ORIGIN}/people`, { headers: { cookie } }),
      supportEnv,
      page,
    );
    expect(authorized.ok).toBe(true);
    const principal = authorized.ok ? authorized.principal : null;
    expect(principal?.userId).toBe(approved.userId);
    expect(principal?.name).toBe(`Support (${email})`);

    // The support user works, with the grant's role (viewer: reads yes, writes no).
    const list = await runOperation(supportEnv, principal, { name: "person.list", input: {} });
    expect(list.ok).toBe(true);
    const write = await runOperation(supportEnv, principal, {
      name: "person.create",
      input: { displayName: "Nope" },
    });
    expect(write).toMatchObject({ ok: false, error: { code: "forbidden" } });

    // The session start is in the customer's audit log, which admins read in Settings → Audit.
    const audit = await runOperation(env, admin, {
      name: "audit.list",
      input: { operation: "support.session.start" },
    });
    expect(audit.ok).toBe(true);
    const entries = (audit.ok ? audit.data : { items: [] }) as {
      items: { operation: string; userId: string | null }[];
    };
    expect(entries.items.some((e) => e.userId === approved.userId)).toBe(true);

    // Revoke: the next request with the same cookie is not the support user any more.
    const revoked = await runOperation(env, admin, {
      name: "support.grant.revoke",
      input: { id },
    });
    expect(revoked.ok).toBe(true);
    const after = await authorize(
      new Request(`${ORIGIN}/people`, { headers: { cookie } }),
      supportEnv,
      page,
    );
    expect(after.ok).toBe(false);
    // And a principal resolved before the revoke is refused by the operations adapter.
    const stale = await runOperation(supportEnv, principal, { name: "person.list", input: {} });
    expect(stale).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("ignores the cookie once the grant expires, and a tampered cookie", async () => {
    const { id, email } = await requestGrant();
    await approve(id);
    const cookie = cookieFrom(await enter(await token(claimsFor(id, email))));
    const request = () => new Request(`${ORIGIN}/`, { headers: { cookie } });
    expect((await authorize(request(), supportEnv, page)).ok).toBe(true);

    const [name, value] = cookie.split("=") as [string, string];
    const [, exp, mac] = value.split(".");
    const other = await requestGrant();
    await approve(other.id);
    const forged = `${name}=${other.id}.${exp}.${mac}`;
    expect(
      (
        await authorize(
          new Request(`${ORIGIN}/`, { headers: { cookie: forged } }),
          supportEnv,
          page,
        )
      ).ok,
    ).toBe(false);

    await env.DB.prepare("UPDATE core_support_grants SET expires_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), id)
      .run();
    expect((await authorize(request(), supportEnv, page)).ok).toBe(false);
  });

  it("refuses bad tokens: signature, issuer, audience, expiry, lifetime, email, grant state", async () => {
    const { id, email } = await requestGrant();
    const now = Math.floor(Date.now() / 1000);
    // Not approved yet.
    expect((await enter(await token(claimsFor(id, email)))).status).toBe(403);
    await approve(id);

    const refused = [
      await token(claimsFor(id, email), { key: otherKeys.privateKey }),
      await token(claimsFor(id, email), { header: { alg: "HS256", typ: "JWT" } }),
      await token(claimsFor(id, email, { iss: "someone-else" })),
      await token(claimsFor(id, email, { aud: "other.relationshiposcrm.com" })),
      await token(claimsFor(id, email, { iat: now - 400, exp: now - 1 })),
      await token(claimsFor(id, email, { exp: now + SUPPORT_TOKEN_MAX_LIFETIME + 1 })),
      await token(claimsFor(id, "intruder@relationshiposcrm.com")),
      await token(claimsFor("sgr_unknown", email)),
      "not-a-token",
    ];
    for (const bad of refused) {
      const response = await enter(bad);
      expect(response.status).toBe(403);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    expect((await enter(await token(claimsFor(id, email)))).status).toBe(302);

    await runOperation(env, admin, { name: "support.grant.revoke", input: { id } });
    expect((await enter(await token(claimsFor(id, email)))).status).toBe(403);
  });

  it("only a human admin approves: a member is refused", async () => {
    const { id } = await requestGrant();
    const result = await runOperation(env, member, {
      name: "support.grant.approve",
      input: { id },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
});

describe("plan limits through the UI adapter", () => {
  async function setPlan(value: Record<string, unknown>) {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO core_entitlements (key, value, updated_at) VALUES ('plan', ?, ?)",
    )
      .bind(
        JSON.stringify({
          plan: "free",
          maxUsers: null,
          maxRecords: null,
          platformAi: true,
          updatedAt: "2026-11-05T00:00:00.000Z",
          ...value,
        }),
        new Date().toISOString(),
      )
      .run();
    clearEntitlementsCache();
  }

  it("plan.get reports the plan and usage; a record over the limit is a plan_limit error", async () => {
    const unmanaged = await runOperation(env, admin, { name: "plan.get", input: {} });
    expect(unmanaged).toMatchObject({ ok: true, data: { managed: false, billingUrl: null } });

    await setPlan({ plan: "free", maxRecords: 0 });
    const plan = await runOperation(env, admin, { name: "plan.get", input: {} });
    expect(plan).toMatchObject({
      ok: true,
      data: {
        managed: true,
        entitlements: { plan: "free", maxRecords: 0 },
        billingUrl: "https://app.relationshiposcrm.com/billing",
      },
    });
    const create = await runOperation(env, admin, {
      name: "organisation.create",
      input: { name: "Over the limit" },
    });
    expect(create).toMatchObject({ ok: false, error: { code: "plan_limit" } });
    if (!create.ok) expect(create.error.message).toMatch(/Upgrade at https:\/\/app\./);
  });

  it("blocks platform AI when the allowance is used up", async () => {
    await setPlan({ plan: "free", platformAi: false });
    const models = modelsFor({ ...env, AI_FAKE_MODEL: "true" }, createCrmDb(env.DB));
    await expect(
      models?.run("summarise", [{ role: "user", content: "hello" }]),
    ).rejects.toBeInstanceOf(AiAllowanceError);
    await setPlan({ plan: "free", platformAi: true });
    const allowed = modelsFor({ ...env, AI_FAKE_MODEL: "true" }, createCrmDb(env.DB));
    expect((await allowed?.run("summarise", [{ role: "user", content: "hello" }]))?.model).toBe(
      "fake",
    );
  });
});
