// AC1 (local half): the Deals extension passes its contract and formula checks, its stage
// behaviour, indexes and seeds are well formed, and its tool works against @crm/sdk/testing's
// in-memory host modules. apps/runner/test/deals.test.ts runs the same extension through the real
// runtime (executor, reconciler, stage rules, stage history).
import { createTestHost, ExtensionToolError } from "@crm/sdk/testing";
import { describe, expect, it } from "vitest";
import extension from "../index.ts";

describe("deals extension (test host)", () => {
  it("passes the contract and formula checks", () => {
    const host = createTestHost(extension);
    expect(host.issues).toEqual([]);
    expect(Object.keys(host.manifest.objects)).toEqual([
      "pipeline",
      "stage",
      "deal",
      "participant",
    ]);
    expect(Object.keys(host.manifest.tools)).toEqual(["stageMetrics"]);
    // Phase 2: a Deals tab on organisations and people, People on a deal, an open-deals panel,
    // the default pipeline setting, four shipped views and two dashboards.
    expect(host.manifest.recordTabs.organisationDeals).toMatchObject({
      on: "organisation",
      view: { type: "table", object: "deals.deal", relation: "organisation" },
    });
    expect(host.manifest.recordTabs.personDeals?.view).toMatchObject({
      object: "deals.participant",
      relation: "person",
    });
    expect(Object.keys(host.manifest.recordPanels)).toEqual(["organisationOpenDeals"]);
    expect(host.manifest.settings.defaultPipeline).toMatchObject({
      type: "text",
      default: "New business",
    });
    expect(Object.values(host.manifest.views).map((v) => v.label)).toEqual([
      "My open deals",
      "Closing this month",
      "Won this quarter",
      "Pipeline board",
    ]);
    expect(host.manifest.views.pipelineBoard).toMatchObject({ type: "board", groupBy: "stage" });
    expect(Object.values(host.manifest.dashboards).map((d) => [d.title, d.home ?? false])).toEqual([
      ["Sales overview", true],
      ["Pipeline health", false],
    ]);
    expect(host.manifest.objects.deal?.stages).toMatchObject({
      field: "stage",
      group: "pipeline",
      requiredByType: { lost: ["lostReason"] },
    });
  });

  it("seeds New business and Renewals with typed, ordered stages", () => {
    const { stage, pipeline } = createTestHost(extension).manifest.objects;
    expect(Object.values(pipeline?.seed ?? {}).map((p) => p.name)).toEqual([
      "New business",
      "Renewals",
    ]);
    const newBusiness = Object.values(stage?.seed ?? {}).filter(
      (s) => (s.pipeline as { seed: string }).seed === "newBusiness",
    );
    expect(newBusiness.map((s) => `${s.name}:${s.type}`)).toEqual([
      "Lead:open",
      "Qualified:open",
      "Proposal:open",
      "Negotiation:open",
      "Won:won",
      "Lost:lost",
    ]);
    const renewals = Object.values(stage?.seed ?? {}).filter(
      (s) => (s.pipeline as { seed: string }).seed === "renewals",
    );
    expect(renewals.map((s) => s.type)).toEqual(["open", "open", "open", "won", "lost"]);
  });

  it("refuses a malformed stage behaviour with structured issues", () => {
    const broken = {
      ...extension,
      objects: {
        ...extension.objects,
        deal: {
          ...extension.objects.deal,
          stages: {
            ...extension.objects.deal.stages,
            closedDate: "expectedClose",
            status: "source",
          },
        },
      },
    } as unknown as typeof extension;
    const host = createTestHost(broken);
    expect(host.issues.map((i) => i.path)).toEqual([
      "objects.deal.stages.closedDate",
      "objects.deal.stages.status",
    ]);
  });

  it("computes stage metrics from query.sql results", async () => {
    const calls: unknown[] = [];
    const host = createTestHost(extension, {
      operations: {
        "query.sql": (input) => {
          calls.push(input.params);
          return String(input.sql).includes("avg_days_to_win")
            ? { rows: [{ won: 2, avg_days_to_win: 12.3456, won_value: 5000 }] }
            : {
                rows: [
                  {
                    stage_id: "rec_1",
                    stage: "Lead",
                    type: "open",
                    entered: 3,
                    current: 1,
                    avg_days: 4.111,
                    avg_days_completed: 5,
                  },
                ],
              };
        },
      },
    });
    const out = await host.runTool("stageMetrics", { pipelineId: "rec_p" });
    expect(out).toEqual({
      pipelineId: "rec_p",
      stages: [
        {
          stageId: "rec_1",
          stage: "Lead",
          type: "open",
          entered: 3,
          current: 1,
          avgDaysInStage: 4.11,
          avgDaysBeforeMovingOn: 5,
        },
      ],
      velocity: { won: 2, avgDaysToWin: 12.35, wonValue: 5000 },
    });
    expect(calls).toEqual([
      ["rec_p", null, null],
      ["rec_p", null, null],
    ]);
  });

  it("validates tool input", async () => {
    const host = createTestHost(extension);
    await expect(host.runTool("stageMetrics", { pipelineId: "" })).rejects.toBeInstanceOf(
      ExtensionToolError,
    );
  });
});
