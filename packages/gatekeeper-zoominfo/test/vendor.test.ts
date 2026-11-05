// Local smoke test (not from upstream; upstream has no tests for this package): the Worker loads
// in workerd with its real config and its GatekeeperVendor entrypoint answers the read-only parts
// of the gatekeeper interface.
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("ros-gatekeeper-zoominfo vendor entrypoint", () => {
  const vendor = exports.GatekeeperVendor;

  it("describes itself", async () => {
    const description = await vendor.describe();
    expect(description.displayName).toBe("ZoomInfo");
  });

  it("offers one whole-account resource", async () => {
    const resources = await vendor.getSupportedResources();
    expect(resources.map((resource) => resource.urlPattern)).toEqual(["https://*"]);
  });

  it("serves its session types", async () => {
    const types = await vendor.getTypeScriptTypes();
    expect(types).toContain("interface");
  });
});
