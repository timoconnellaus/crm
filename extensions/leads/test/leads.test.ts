// Stage 15 (local half): the Leads extension passes its contract checks against an installed
// Deals, and its tools work against @relationship-os/sdk/testing's in-memory host: conversion
// links without copying, is idempotent across an injected failure, refuses a converted lead, and
// moves the person's lifecycle stage when that field exists. apps/runner/test/leads.test.ts runs
// the same extension through the real runtime.
import deals from "@relationship-os/extension-deals";
import { toManifest } from "@relationship-os/sdk";
import { createTestHost, ExtensionToolError, type TestHost } from "@relationship-os/sdk/testing";
import { describe, expect, it } from "vitest";
import extension from "../index.ts";

const dealsObjects = Object.keys(toManifest(deals).objects).map((name) => `deals.${name}`);
const validate = { knownObjects: dealsObjects };

function hostWith(
  options: {
    lifecycle?: string | null;
    fail?: (operation: string, input: Record<string, unknown>) => boolean;
    openDeal?: boolean;
  } = {},
) {
  let host: TestHost | null = null;
  const person = {
    id: "per_1",
    displayName: "Ada Lovelace",
    ...(options.lifecycle !== undefined ? { "lifecycle.lifecycleStage": options.lifecycle } : {}),
  };
  const created = createTestHost(extension, {
    validate,
    records: {
      person: [person],
      organisation: [{ id: "org_1", name: "Analytical Engines" }],
      "leads.lead": [
        {
          id: "lead_1",
          name: "Analytical Engines lead",
          person: "per_1",
          organisation: "org_1",
          owner: "usr_sam",
          status: "contacted",
        },
        { id: "lead_2", name: "Org only", organisation: "org_1", status: "new" },
      ],
    },
    operations: {
      "extensionSettings.list": () => ({
        items: [{ values: { openDealAfterConvert: options.openDeal ?? true } }],
      }),
      "record.update": (input) => {
        if (options.fail?.("record.update", input)) {
          throw new ExtensionToolError("internal", "Injected failure");
        }
        const rows = host?.records.get(String(input.object));
        const row = rows?.get(String(input.id));
        if (!rows || !row) throw new ExtensionToolError("not_found", "No such record");
        const next = { ...row, ...(input.values as Record<string, unknown>) };
        rows.set(String(input.id), next);
        return { object: input.object, id: input.id, title: null, values: next };
      },
    },
  });
  host = created;
  return created;
}

const dealsOf = (host: TestHost) => [...(host.records.get("deals.deal")?.values() ?? [])];
const participantsOf = (host: TestHost) => [
  ...(host.records.get("deals.participant")?.values() ?? []),
];

describe("leads extension (test host)", () => {
  it("passes the contract checks with Deals installed", () => {
    const host = createTestHost(extension, { validate });
    expect(host.issues).toEqual([]);
    const lead = host.manifest.objects.lead;
    expect(lead?.owner).toBe("owner");
    expect(lead?.requireOneOf).toEqual([["person", "organisation"]]);
    expect(lead?.timelineLinks).toEqual(["person", "organisation"]);
    expect(lead?.fields.status?.editableOptions).toBe(true);
    expect(lead?.fields.source?.defaultSetting).toBe("defaultSource");
    expect(host.manifest.fields["deals.deal"]?.lead).toMatchObject({
      type: "relation",
      to: "leads.lead",
      readOnly: true,
    });
    expect(Object.keys(host.manifest.views)).toEqual([
      "leadsInbox",
      "myLeads",
      "unassigned",
      "leadsBoard",
    ]);
    expect(Object.keys(host.manifest.tools)).toEqual(["convert", "disqualify"]);
    expect(host.manifest.tools.convert?.recordAction).toMatchObject({
      object: "leads.lead",
      idInput: "leadId",
    });
    expect(Object.values(host.manifest.automations).map((a) => a.enabled)).toEqual([false, false]);
  });

  it("is refused without Deals: the deal relation and the deal field have no target", () => {
    const host = createTestHost(extension);
    const paths = host.issues.map((i) => i.path);
    expect(paths).toContain("objects.lead.fields.deal.to");
    expect(paths).toContain("fields.deals.deal");
  });

  it("converts a lead into a linked deal without copying data", async () => {
    const host = hostWith();
    const result = await host.runTool<{ dealId: string; created: boolean; open: unknown }>(
      "convert",
      { leadId: "lead_1", value: 5000 },
    );
    expect(result.created).toBe(true);
    expect(result.open).toEqual({ object: "deals.deal", id: result.dealId });
    const [deal] = dealsOf(host);
    expect(deal).toEqual({
      id: result.dealId,
      name: "Analytical Engines lead",
      "leads.lead": "lead_1",
      organisation: "org_1",
      owner: "usr_sam",
      value: 5000,
    });
    expect(participantsOf(host)).toEqual([
      expect.objectContaining({ deal: result.dealId, person: "per_1", role: "other" }),
    ]);
    const lead = host.records.get("leads.lead")?.get("lead_1");
    expect(lead).toMatchObject({ status: "converted", deal: result.dealId });
    expect(lead?.convertedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("finishes after an injected failure without a second deal", async () => {
    let failing = true;
    const host = hostWith({
      fail: (_op, input) => failing && input.object === "leads.lead",
    });
    await expect(host.runTool("convert", { leadId: "lead_1" })).rejects.toThrow(/Injected failure/);
    expect(dealsOf(host)).toHaveLength(1);
    expect(host.records.get("leads.lead")?.get("lead_1")?.status).toBe("contacted");
    failing = false;
    const again = await host.runTool<{ dealId: string; created: boolean }>("convert", {
      leadId: "lead_1",
    });
    expect(again.created).toBe(false);
    expect(dealsOf(host)).toHaveLength(1);
    expect(participantsOf(host)).toHaveLength(1);
    expect(host.records.get("leads.lead")?.get("lead_1")?.deal).toBe(again.dealId);
  });

  it("refuses to convert a converted lead", async () => {
    const host = hostWith();
    await host.runTool("convert", { leadId: "lead_1" });
    await expect(host.runTool("convert", { leadId: "lead_1" })).rejects.toThrow(
      /already converted/,
    );
    expect(dealsOf(host)).toHaveLength(1);
  });

  it("converts an organisation-only lead and respects the open-deal setting", async () => {
    const host = hostWith({ openDeal: false });
    const result = await host.runTool<{ open: unknown }>("convert", { leadId: "lead_2" });
    expect(result.open).toBeNull();
    expect(participantsOf(host)).toHaveLength(0);
    expect(dealsOf(host)[0]).not.toHaveProperty("owner");
  });

  it("moves the person's lifecycle stage to opportunity when lifecycle is installed", async () => {
    const withLifecycle = hostWith({ lifecycle: "salesQualified" });
    await withLifecycle.runTool("convert", { leadId: "lead_1" });
    expect(withLifecycle.records.get("person")?.get("per_1")?.["lifecycle.lifecycleStage"]).toBe(
      "opportunity",
    );

    const customer = hostWith({ lifecycle: "customer" });
    await customer.runTool("convert", { leadId: "lead_1" });
    expect(customer.records.get("person")?.get("per_1")?.["lifecycle.lifecycleStage"]).toBe(
      "customer",
    );

    const without = hostWith();
    await without.runTool("convert", { leadId: "lead_1" });
    expect(without.records.get("person")?.get("per_1")).not.toHaveProperty(
      "lifecycle.lifecycleStage",
    );
  });

  it("disqualifies with a reason, and not a converted lead", async () => {
    const host = hostWith();
    await host.runTool("disqualify", { leadId: "lead_2", reason: "noBudget" });
    expect(host.records.get("leads.lead")?.get("lead_2")).toMatchObject({
      status: "unqualified",
      unqualifiedReason: "noBudget",
    });
    await host.runTool("convert", { leadId: "lead_1" });
    await expect(host.runTool("disqualify", { leadId: "lead_1", reason: "other" })).rejects.toThrow(
      /already converted/,
    );
  });

  it("ships two automations, turned off", async () => {
    const host = hostWith();
    const run = await host.runAutomation("notifyNewLead", {
      record: { object: "leads.lead", id: "lead_1" },
    });
    expect(run.error).toBeNull();
    expect(run.undeclared).toEqual([]);
    const reminder = await host.runAutomation("remindNewLead", {
      record: { object: "leads.lead", id: "lead_2" },
    });
    // lead_2 has no owner, so the conditions do not match.
    expect(reminder.matched).toBe(false);
  });
});
