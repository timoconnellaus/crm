// Local smoke test (not from upstream; upstream has no tests for this package): the Worker loads
// in workerd with its real config, its GatekeeperVendor entrypoint answers the read-only parts of
// the gatekeeper interface, and its fetch handler serves nothing but connect completions.
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("crm-gatekeeper-email vendor entrypoint", () => {
  const vendor = exports.GatekeeperVendor;

  it("describes itself", async () => {
    const description = await vendor.describe();
    expect(description.displayName).toBe("Email");
  });

  it("offers one mailbox resource under its base URL", async () => {
    const resources = await vendor.getSupportedResources();
    expect(resources.map((resource) => resource.urlPattern)).toEqual([
      "http://localhost:8787/gatekeeper/email/mailbox/:user",
    ]);
  });

  it("serves its session types", async () => {
    const types = await vendor.getTypeScriptTypes();
    expect(types).toContain("interface EmailSession");
  });

  it("answers 404 for anything but a connect completion", async () => {
    const response = await exports.default.fetch("http://localhost:8787/gatekeeper/email/anything");
    expect(response.status).toBe(404);
  });
});
