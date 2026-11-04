// Local smoke test (not from upstream): the Worker loads in workerd with its real config and its
// GatekeeperVendor entrypoint answers the read-only parts of the gatekeeper interface.
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("crm-gatekeeper-microsoft vendor entrypoint", () => {
  const vendor = exports.GatekeeperVendor;

  it("describes itself", async () => {
    const description = await vendor.describe();
    expect(description.displayName).toBe("Microsoft 365");
  });

  it("offers SharePoint, Outlook and Calendar resources", async () => {
    const resources = await vendor.getSupportedResources();
    const patterns = resources.map((resource) => resource.urlPattern);
    expect(patterns).toContain("https://outlook.office.com/calendar/*");
    expect(patterns).toContain("https://outlook.office.com/*");
    expect(patterns.some((pattern) => pattern.includes("sharepoint.com"))).toBe(true);
    // The Workshop takes the first matching pattern, so Calendar must come before Outlook.
    expect(patterns.indexOf("https://outlook.office.com/calendar/*")).toBeLessThan(
      patterns.indexOf("https://outlook.office.com/*"),
    );
  });

  it("serves its session types", async () => {
    const types = await vendor.getTypeScriptTypes();
    expect(types).toContain("interface");
  });
});
