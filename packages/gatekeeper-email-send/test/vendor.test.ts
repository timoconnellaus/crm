import { exports } from "cloudflare:workers";
import type { SupportedResource } from "@relationship-os/gatekeeper-interface/gatekeeper";
import { describe, expect, it } from "vitest";
import senderConfigurator from "../src/configurator/sender-configurator-ui";
import { assertSenderAllowed, senderFromUrl, senderUrl } from "../src/sender";
import { isRefusedBeforeSending, isRetryableRefusal } from "../src/transport";

// The RPC stub types of a Fetcher<GatekeeperUser> returned over RPC collapse to `never`, so the
// account is driven through this narrow view.
type AccountView = {
  describe(): Promise<{ displayName?: string }>;
  getSupportedResources(): Promise<SupportedResource[]>;
  getGatekeeperClassFor(url: string): Promise<{ resource: SupportedResource }>;
  startResourceConfigurator(pattern: string): Promise<{
    iframeHtml: string;
    ui: { allowedDomains(): Promise<string[]> };
  }>;
  ensureResources(patterns: string[]): Promise<{ url?: string }>;
  reconnect(): Promise<{ url: string }>;
};

describe("vendor", () => {
  const vendor = exports.GatekeeperVendor;

  it("describes itself as auto-provisioned", async () => {
    const description = await vendor.describe();
    expect(description.displayName).toBe("Email sending");
    expect(description.autoProvisionsAccount).toBe(true);
    expect(description.providesAuth).toBe(false);
  });

  it("offers one grantable resource: a sender address", async () => {
    expect(await vendor.getSupportedResources()).toEqual([
      expect.objectContaining({
        urlPattern: "email-send://sender/:address",
        title: "Sender address",
        grantable: true,
      }),
    ]);
  });

  it("serves self-contained session types", async () => {
    const types = await vendor.getTypeScriptTypes();
    expect(types).toContain("export interface EmailSendSession");
    expect(types).not.toMatch(/^import /m);
  });

  it("has no connect flow", async () => {
    await expect(vendor.connectAccount(null as never)).rejects.toThrow(/no connect flow/);
  });
});

describe("account", () => {
  async function account(): Promise<AccountView> {
    return (await exports.GatekeeperVendor.createAccount()) as unknown as AccountView;
  }

  it("maps an allowed sender to the facet class", async () => {
    const { resource } = await (await account()).getGatekeeperClassFor(
      "email-send://sender/crm%40example.com",
    );
    expect(resource.urlPattern).toBe("email-send://sender/:address");
  });

  it("refuses a sender outside ALLOWED_SENDER_DOMAINS", async () => {
    await expect(
      (await account()).getGatekeeperClassFor("email-send://sender/crm%40evil.test"),
    ).rejects.toThrow(/can't be sent from evil.test/);
  });

  it("refuses malformed resource URLs", async () => {
    const a = await account();
    await expect(a.getGatekeeperClassFor("https://example.com/")).rejects.toThrow(
      /sender address URL/,
    );
    await expect(a.getGatekeeperClassFor("email-send://sender/not-an-address")).rejects.toThrow(
      /plain email address/,
    );
    await expect(a.getGatekeeperClassFor("email-send://sender/%E0%A4%A")).rejects.toThrow(
      /encoded/,
    );
  });

  it("opens a configurator that reports the allowed domains", async () => {
    const frame = await (await account()).startResourceConfigurator("email-send://sender/:address");
    expect(frame.iframeHtml).toContain("<html");
    expect(await frame.ui.allowedDomains()).toEqual(["example.com", "example.org"]);
  });

  it("has trivial grant and reconnect methods", async () => {
    const a = await account();
    expect(await a.ensureResources(["email-send://sender/:address"])).toEqual({});
    await expect(a.reconnect()).rejects.toThrow(/no connect flow/);
    expect((await a.describe()).displayName).toBe("Email sending");
  });
});

describe("sender addresses", () => {
  it("round-trips through the resource URL, lower-casing the domain", () => {
    expect(senderUrl("crm@example.com")).toBe("email-send://sender/crm%40example.com");
    expect(senderFromUrl("email-send://sender/CRM%40Example.COM")).toBe("CRM@example.com");
  });

  it("refuses everything when no sender domain is configured", () => {
    expect(() => assertSenderAllowed("crm@example.com", "")).toThrow(/ALLOWED_SENDER_DOMAINS/);
    expect(() => assertSenderAllowed("crm@example.com", " , ")).toThrow(/ALLOWED_SENDER_DOMAINS/);
    expect(() => assertSenderAllowed("crm@example.com", "example.com")).not.toThrow();
    expect(() => assertSenderAllowed("crm@sub.example.com", "example.com")).toThrow();
  });
});

describe("Email Service errors", () => {
  it("classifies refusals by code", () => {
    const coded = (code: string) => Object.assign(new Error(code), { code });
    expect(isRefusedBeforeSending(coded("E_SENDER_NOT_VERIFIED"))).toBe(true);
    expect(isRefusedBeforeSending(coded("E_DELIVERY_FAILED"))).toBe(false);
    expect(isRefusedBeforeSending(new Error("socket hang up"))).toBe(false);
    expect(isRetryableRefusal(coded("E_RATE_LIMIT_EXCEEDED"))).toBe(true);
    expect(isRetryableRefusal(coded("E_SENDER_NOT_VERIFIED"))).toBe(false);
  });
});

describe("sender configurator spec", () => {
  const ui = { allowedDomains: async () => ["example.com"] };

  it("is ready only for a plain address", () => {
    expect(senderConfigurator.isReady({ values: { address: "crm@example.com" } })).toBe(true);
    expect(senderConfigurator.isReady({ values: { address: "crm" } })).toBe(false);
  });

  it("builds the resource URL for an allowed domain", async () => {
    expect(
      await senderConfigurator.resourceUrl({ values: { address: " crm@example.com " }, ui }),
    ).toBe("email-send://sender/crm%40example.com");
    await expect(
      senderConfigurator.resourceUrl({ values: { address: "crm@other.test" }, ui }),
    ).rejects.toThrow(/example.com/);
  });

  it("reads its values back from a resource URL", () => {
    expect(
      senderConfigurator.initialValuesFromResourceUrl({
        resourceUrl: "email-send://sender/crm%40example.com",
        resourceUrlPattern: "email-send://sender/:address",
        ui,
      }),
    ).toEqual({ address: "crm@example.com" });
  });
});
