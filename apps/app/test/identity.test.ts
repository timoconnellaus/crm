// The identity middleware's decisions (src/server/identity.ts), run in workerd against real D1.
import { env } from "cloudflare:workers";
import { ACCESS_JWT_HEADER, type IdentityEnv } from "@crm/auth";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { authorize } from "../src/server/identity.ts";
import { AUD, createAccessKeys, TEAM } from "./access-jwt.ts";

const ORIGIN = "https://crm.example.com";
const page = { handlerType: "router" } as const;

function get(path: string, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}${path}`, { headers });
}

describe("with IDENTITY_PROVIDER=cloudflare-access", () => {
  let keys: Awaited<ReturnType<typeof createAccessKeys>>;
  const accessEnv: IdentityEnv = {
    ...env,
    IDENTITY_PROVIDER: "cloudflare-access",
    CF_ACCESS_TEAM_DOMAIN: "crm-test.cloudflareaccess.com",
    CF_ACCESS_AUD: AUD,
  };

  beforeAll(async () => {
    keys = await createAccessKeys();
    // The adapter fetches the team's real JWKS URL; serve the test key there.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === `${TEAM}/cdn-cgi/access/certs`) return Response.json(keys.jwks);
      return new Response("unexpected fetch", { status: 500 });
    });
  });
  afterAll(() => vi.restoreAllMocks());

  it("admits a request carrying a valid Access JWT", async () => {
    const token = await keys.sign({ sub: "u-1", email: "ada@example.com", name: "Ada" });
    const result = await authorize(get("/", { [ACCESS_JWT_HEADER]: token }), accessEnv, page);
    expect(result).toEqual({
      ok: true,
      principal: { userId: "u-1", email: "ada@example.com", name: "Ada", roles: [] },
    });
  });

  it("rejects a page request without a JWT", async () => {
    const result = await authorize(get("/"), accessEnv, page);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("rejects an API request with a JWT for another application", async () => {
    const token = await keys.sign(
      { sub: "u-1", email: "a@example.com" },
      { audience: "other-app" },
    );
    const result = await authorize(
      get("/api/anything", { [ACCESS_JWT_HEADER]: token }),
      accessEnv,
      page,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("rejects a server function call without a JWT", async () => {
    const result = await authorize(get("/_serverFn/x"), accessEnv, {
      handlerType: "serverFn",
      serverFnFile: "src/server/system.ts",
    });
    expect(result.ok).toBe(false);
  });
});

describe("with IDENTITY_PROVIDER=better-auth", () => {
  const authEnv: IdentityEnv = { ...env, IDENTITY_PROVIDER: "better-auth" };

  it("redirects a signed-out page request to sign-in", async () => {
    const result = await authorize(get("/status?x=1"), authEnv, page);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(302);
      expect(result.response.headers.get("location")).toBe(
        `${ORIGIN}/sign-in?redirect=%2Fstatus%3Fx%3D1`,
      );
    }
  });

  it("returns 401 for signed-out API and private server function calls", async () => {
    const api = await authorize(get("/api/private"), authEnv, page);
    const fn = await authorize(get("/_serverFn/x"), authEnv, {
      handlerType: "serverFn",
      serverFnFile: "src/server/system.ts",
    });
    for (const result of [api, fn]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(401);
    }
  });

  it("lets anyone reach public paths and *.public.ts server functions", async () => {
    for (const path of ["/sign-in", "/api/health", "/api/auth/get-session"]) {
      expect(await authorize(get(path), authEnv, page)).toEqual({ ok: true, principal: null });
    }
    const fn = await authorize(get("/_serverFn/x"), authEnv, {
      handlerType: "serverFn",
      serverFnFile: "src/server/session.public.ts",
    });
    expect(fn).toEqual({ ok: true, principal: null });
  });

  it("resolves the Principal from a Better Auth session", async () => {
    const signUp = await fetchAuth(authEnv, "/api/auth/sign-up/email", {
      email: "first@example.com",
      password: "correct-horse-battery",
      name: "First User",
    });
    expect(signUp.status).toBe(200);
    const cookie = signUp.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const result = await authorize(get("/", { cookie }), authEnv, page);
    expect(result).toMatchObject({ ok: true, principal: { email: "first@example.com" } });
  });
});

async function fetchAuth(identityEnv: IdentityEnv, path: string, body: unknown) {
  const { createIdentityProvider } = await import("@crm/auth");
  const provider = createIdentityProvider(identityEnv);
  const response = await provider.handle?.(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify(body),
    }),
  );
  if (!response) throw new Error("no auth route");
  return response;
}
