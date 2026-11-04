import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createIdentityProvider, IdentityConfigError, type IdentityEnv } from "../src/index.ts";

const ORIGIN = "http://localhost:5173";

function authEnv(overrides: Partial<IdentityEnv> = {}): IdentityEnv {
  return {
    DB: env.DB,
    IDENTITY_PROVIDER: "better-auth",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123",
    BETTER_AUTH_URL: ORIGIN,
    ...overrides,
  };
}

async function signUp(provider: ReturnType<typeof createIdentityProvider>, email: string) {
  // biome-ignore lint/style/noNonNullAssertion: the Better Auth adapter always has routes.
  return provider.handle!(
    new Request(`${ORIGIN}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email, password: "correct-horse-battery", name: "Test User" }),
    }),
  );
}

describe("better-auth adapter", () => {
  it("signs a user up into core_user and resolves their session", async () => {
    const provider = createIdentityProvider(authEnv());
    const response = await signUp(provider, "first@example.com");
    expect(response?.status).toBe(200);

    const cookie =
      response?.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ") ?? "";
    const principal = await provider.resolve(new Request(`${ORIGIN}/`, { headers: { cookie } }));
    expect(principal).toMatchObject({ email: "first@example.com", name: "Test User", roles: [] });

    const row = await env.DB.prepare("SELECT email FROM core_user").first<{ email: string }>();
    expect(row?.email).toBe("first@example.com");
  });

  it("returns no principal without a session", async () => {
    const provider = createIdentityProvider(authEnv());
    expect(await provider.resolve(new Request(`${ORIGIN}/`))).toBeNull();
  });

  it("closes sign-up after the first user unless AUTH_ALLOW_SIGNUP=true", async () => {
    // Storage is shared across tests in a file, so make sure a first user exists either way.
    const closed = createIdentityProvider(authEnv());
    await signUp(closed, "first@example.com");
    const users = await env.DB.prepare("SELECT COUNT(*) AS n FROM core_user").first<{ n: number }>();
    expect(users?.n).toBeGreaterThan(0);

    expect((await signUp(closed, "second@example.com"))?.ok).toBe(false);

    const open = createIdentityProvider(authEnv({ AUTH_ALLOW_SIGNUP: "true" }));
    expect((await signUp(open, "third@example.com"))?.status).toBe(200);
  });

  it("ignores routes outside /api/auth", async () => {
    const provider = createIdentityProvider(authEnv());
    // biome-ignore lint/style/noNonNullAssertion: the Better Auth adapter always has routes.
    expect(await provider.handle!(new Request(`${ORIGIN}/api/health`))).toBeNull();
  });
});

describe("adapter selection", () => {
  it("defaults to better-auth", () => {
    expect(createIdentityProvider(authEnv({ IDENTITY_PROVIDER: undefined })).kind).toBe(
      "better-auth",
    );
  });

  it("selects cloudflare-access", () => {
    const provider = createIdentityProvider(
      authEnv({
        IDENTITY_PROVIDER: "cloudflare-access",
        CF_ACCESS_TEAM_DOMAIN: "t",
        CF_ACCESS_AUD: "a",
      }),
    );
    expect(provider.kind).toBe("cloudflare-access");
  });

  it("fails closed on unknown or incomplete configuration", () => {
    expect(() => createIdentityProvider(authEnv({ IDENTITY_PROVIDER: "none" }))).toThrow(
      IdentityConfigError,
    );
    expect(() =>
      createIdentityProvider(authEnv({ IDENTITY_PROVIDER: "cloudflare-access" })),
    ).toThrow(IdentityConfigError);
    expect(() => createIdentityProvider(authEnv({ BETTER_AUTH_SECRET: undefined }))).toThrow(
      IdentityConfigError,
    );
  });
});
