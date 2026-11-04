import { createLocalJWKSet } from "jose";
import { describe, expect, it } from "vitest";
import { ACCESS_JWT_HEADER, cloudflareAccessProvider, normaliseTeamDomain } from "../src/index.ts";
import { AUD, createAccessKeys, TEAM } from "./access-jwt.ts";

const keys = await createAccessKeys();
const provider = cloudflareAccessProvider({
  teamDomain: "crm-test",
  audience: AUD,
  jwks: createLocalJWKSet(keys.jwks),
});

function request(headers: Record<string, string> = {}) {
  return new Request("https://crm.example.com/", { headers });
}

describe("cloudflare-access adapter", () => {
  it("admits a request with a valid Access JWT", async () => {
    const token = await keys.sign({ sub: "user-1", email: "ada@example.com", name: "Ada" });
    const principal = await provider.resolve(request({ [ACCESS_JWT_HEADER]: token }));
    expect(principal).toEqual({
      userId: "user-1",
      email: "ada@example.com",
      name: "Ada",
      roles: [],
    });
  });

  it("reads the CF_Authorization cookie when the header is missing", async () => {
    const token = await keys.sign({ sub: "user-1", email: "ada@example.com" });
    const principal = await provider.resolve(request({ cookie: `a=b; CF_Authorization=${token}` }));
    expect(principal?.email).toBe("ada@example.com");
    expect(principal?.name).toBe("ada@example.com");
  });

  it("rejects a request without a JWT", async () => {
    expect(await provider.resolve(request())).toBeNull();
  });

  it("rejects a JWT for another application", async () => {
    const token = await keys.sign({ sub: "u", email: "a@example.com" }, { audience: "other" });
    expect(await provider.resolve(request({ [ACCESS_JWT_HEADER]: token }))).toBeNull();
  });

  it("rejects a JWT from another team", async () => {
    const token = await keys.sign(
      { sub: "u", email: "a@example.com" },
      { issuer: "https://evil.cloudflareaccess.com" },
    );
    expect(await provider.resolve(request({ [ACCESS_JWT_HEADER]: token }))).toBeNull();
  });

  it("rejects a JWT signed by another key", async () => {
    const other = await createAccessKeys();
    const token = await other.sign({ sub: "u", email: "a@example.com" });
    expect(await provider.resolve(request({ [ACCESS_JWT_HEADER]: token }))).toBeNull();
  });

  it("rejects an expired JWT", async () => {
    const token = await keys.sign({ sub: "u", email: "a@example.com" }, { expiresIn: "-1m" });
    expect(await provider.resolve(request({ [ACCESS_JWT_HEADER]: token }))).toBeNull();
  });

  it("rejects service tokens, which have no email", async () => {
    const token = await keys.sign({ sub: "", common_name: "svc.access" });
    expect(await provider.resolve(request({ [ACCESS_JWT_HEADER]: token }))).toBeNull();
  });

  it("normalises team domains", () => {
    expect(normaliseTeamDomain("crm-test")).toBe(TEAM);
    expect(normaliseTeamDomain("crm-test.cloudflareaccess.com")).toBe(TEAM);
    expect(normaliseTeamDomain("https://crm-test.cloudflareaccess.com/")).toBe(TEAM);
  });
});
