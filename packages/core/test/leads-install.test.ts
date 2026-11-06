// Stage 15, AC1 (ADR 0246): Leads needs Deals. Its relation to deals.deal and its field on it have
// nothing to attach to on a deployment without Deals, so the check refuses the install; with Deals
// reconciled first it passes. In its own file: storage is per test file, so Deals is absent here.
import deals from "@relationship-os/extension-deals";
import leads from "@relationship-os/extension-leads";
import { toManifest } from "@relationship-os/sdk";
import { describe, expect, it } from "vitest";
import { check, reconcile } from "./extension-helpers.ts";

describe("Leads requires Deals", () => {
  it("is refused without Deals, and passes once Deals is installed", async () => {
    const without = await check(toManifest(leads));
    expect(without.issues.length).toBeGreaterThan(0);
    expect(JSON.stringify(without.issues)).toContain("deals.deal");
    await reconcile(toManifest(deals));
    expect((await check(toManifest(leads))).issues).toEqual([]);
  });
});
