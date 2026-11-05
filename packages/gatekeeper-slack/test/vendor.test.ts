// Local smoke test (not from upstream): the Worker loads in workerd with its real config and its
// GatekeeperVendor entrypoint answers the read-only parts of the gatekeeper interface.
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("ros-gatekeeper-slack vendor entrypoint", () => {
  const vendor = exports.GatekeeperVendor;

  it("describes itself", async () => {
    const description = await vendor.describe();
    expect(description.displayName).toBe("Slack");
  });

  it("offers workspace, conversation and thread resources", async () => {
    const resources = await vendor.getSupportedResources();
    const patterns = resources.map((resource) => resource.urlPattern);
    expect(patterns).toContain("https://app.slack.com/client/:teamId/:conversationId");
    expect(patterns).toContain("https://*.slack.com/archives/:conversationId/:messageId");
  });

  it("serves its session types", async () => {
    const types = await vendor.getTypeScriptTypes();
    expect(types).toContain("interface");
  });
});
