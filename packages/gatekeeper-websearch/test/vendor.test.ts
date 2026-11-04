// Local smoke test (not from upstream): the Worker loads in workerd with its real config, and its
// GatekeeperVendor entrypoint answers the read-only parts of the gatekeeper interface and mints an
// auto-provisioned account with a singleton.
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("crm-gatekeeper-websearch vendor entrypoint", () => {
  const vendor = exports.GatekeeperVendor;

  it("describes itself as auto-provisioned", async () => {
    const description = await vendor.describe();
    expect(description.displayName).toBe("Web Search");
    expect(description.autoProvisionsAccount).toBe(true);
    expect(description.providesAuth).toBe(false);
  });

  it("offers no URL-addressed resources", async () => {
    expect(await vendor.getSupportedResources()).toEqual([]);
  });

  it("serves its session types", async () => {
    const types = await vendor.getTypeScriptTypes();
    expect(types).toContain("WebSearchSession");
  });

  it("mints an account whose singleton is a WebSearchSession", async () => {
    // The RPC stub types of a Fetcher<GatekeeperUser> returned over RPC collapse to `never`; the
    // account is a WebSearchAccount entrypoint.
    const account = (await vendor.createAccount()) as unknown as {
      describe(): Promise<{ singleton?: { tsType: string } }>;
    };
    const description = await account.describe();
    expect(description.singleton).toEqual({ tsType: "WebSearchSession" });
  });
});
