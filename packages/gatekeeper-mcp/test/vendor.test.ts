// Local smoke test (not from upstream): the Worker loads in workerd and its GatekeeperVendor
// entrypoint answers the read-only parts of the gatekeeper interface.
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("ros-gatekeeper-mcp vendor entrypoint", () => {
  const vendor = exports.GatekeeperVendor;

  it("describes itself", async () => {
    const description = await vendor.describe();
    expect(description.displayName).toBeTruthy();
    expect(description.url).toMatch(/^https?:\/\//);
  });

  it("offers HTTPS MCP endpoints only, outside insecure mode", async () => {
    const resources = await vendor.getSupportedResources();
    expect(resources.map((resource) => resource.urlPattern)).toEqual(["https://*"]);
  });

  it("serves the base session types", async () => {
    const types = await vendor.getTypeScriptTypes();
    expect(types.length).toBeGreaterThan(0);
  });
});
