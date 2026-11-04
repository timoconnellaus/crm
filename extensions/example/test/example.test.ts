// AC5 (local half): the example extension passes its contract and formula checks and its tools
// work against @crm/sdk/testing's in-memory host modules. apps/runner/test/example.test.ts runs
// the same extension through the real runtime.
import { createTestHost, ExtensionToolError } from "@crm/sdk/testing";
import { describe, expect, it } from "vitest";
import extension from "../index.ts";

describe("example extension (test host)", () => {
  it("passes the contract and formula checks", () => {
    const host = createTestHost(extension);
    expect(host.issues).toEqual([]);
    expect(Object.keys(host.manifest.tools)).toEqual(["summariseOrganisation", "setTier"]);
    expect(Object.keys(host.manifest.recordTabs)).toEqual(["projects"]);
    expect(host.manifest.recordTabs.projects).toMatchObject({
      on: "organisation",
      view: { type: "table", object: "example.project", relation: "organisation" },
    });
    expect(host.manifest.settings.defaultStatus).toMatchObject({
      type: "select",
      default: "planned",
    });
    expect(
      host.manifest.objects.project?.fields.status?.options?.find((o) => o.value === "done"),
    ).toMatchObject({ requires: ["spent"] });
    expect(host.manifest.tools.summariseOrganisation?.inputSchema).toMatchObject({
      type: "object",
      required: ["organisationId"],
    });
  });

  it("summarises an organisation's projects", async () => {
    const host = createTestHost(extension, {
      records: {
        organisation: [{ id: "org_1", name: "Acme", "example.tier": "gold" }],
        "example.project": [
          { id: "rec_1", name: "A", organisation: "org_1", budget: 100, remaining: 40 },
          { id: "rec_2", name: "B", organisation: "org_1", budget: 50, remaining: 50 },
          { id: "rec_3", name: "C", organisation: "org_2", budget: 999, remaining: 0 },
        ],
      },
    });
    const summary = await host.runTool("summariseOrganisation", { organisationId: "org_1" });
    expect(summary).toEqual({
      organisationId: "org_1",
      tier: "gold",
      projects: 2,
      totalBudget: 150,
      totalRemaining: 90,
    });
    expect(host.logs).toEqual([
      {
        level: "info",
        message: "summarised organisation",
        data: { organisationId: "org_1", projects: 2 },
      },
    ]);
    expect(host.storage.get("summary:org_1")).toEqual(summary);
  });

  it("validates tool input", async () => {
    const host = createTestHost(extension);
    await expect(
      host.runTool("setTier", { organisationId: "org_1", tier: "platinum" }),
    ).rejects.toThrow(ExtensionToolError);
  });

  it("sets a tier through record.update on the organisation", async () => {
    const host = createTestHost(extension, {
      records: { organisation: [{ id: "org_1", name: "Acme" }] },
    });
    await host.runTool("setTier", { organisationId: "org_1", tier: "silver" });
    expect(host.records.get("organisation")?.get("org_1")).toMatchObject({
      "example.tier": "silver",
    });
    expect(host.calls).toEqual([
      {
        operation: "record.update",
        input: { object: "organisation", id: "org_1", values: { "example.tier": "silver" } },
        allowed: true,
      },
    ]);
  });
});
