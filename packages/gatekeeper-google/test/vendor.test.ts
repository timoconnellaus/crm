// Local smoke test (not from upstream): the Worker loads in workerd with its real config and its
// GatekeeperVendor entrypoint answers the read-only parts of the gatekeeper interface.
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("crm-gatekeeper-google vendor entrypoint", () => {
  const vendor = exports.GatekeeperVendor;

  it("describes itself", async () => {
    const description = await vendor.describe();
    expect(description.displayName).toBe("Google");
    expect(description.providesAuth).toBe(true);
  });

  it("offers Google resource types", async () => {
    const resources = await vendor.getSupportedResources();
    expect(resources.length).toBeGreaterThan(0);
    expect(resources.every((resource) => resource.urlPattern.startsWith("https://"))).toBe(true);
  });

  it("serves its session types", async () => {
    const types = await vendor.getTypeScriptTypes();
    expect(types).toContain("interface");
  });
});
