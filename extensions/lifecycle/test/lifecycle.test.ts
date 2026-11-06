// Stage 15 (local half): the lifecycle extension adds a person field tracked on the timeline, a
// read-only changed-on date its own automation keeps, and a board of people by stage.
// apps/runner/test/leads.test.ts installs it through the real runtime (opt-in).
import { createTestHost } from "@relationship-os/sdk/testing";
import { describe, expect, it } from "vitest";
import extension, { LIFECYCLE_STAGES } from "../index.ts";

describe("lifecycle extension (test host)", () => {
  it("passes the contract checks", () => {
    const host = createTestHost(extension);
    expect(host.issues).toEqual([]);
    expect(host.manifest.fields.person?.lifecycleStage).toMatchObject({
      type: "select",
      track: "timeline",
    });
    expect(host.manifest.fields.person?.lifecycleStage?.options?.map((o) => o.value)).toEqual(
      LIFECYCLE_STAGES.map((s) => s.value),
    );
    expect(host.manifest.fields.person?.lifecycleStageChangedAt).toMatchObject({
      type: "date",
      readOnly: true,
    });
    expect(host.manifest.views.peopleByStage).toMatchObject({
      type: "board",
      object: "person",
      groupBy: "lifecycle.lifecycleStage",
    });
  });

  it("dates a stage change", async () => {
    const host = createTestHost(extension, {
      records: { person: [{ id: "per_1", "lifecycle.lifecycleStage": "lead" }] },
    });
    const run = await host.runAutomation("stageChangedOn", {
      record: { object: "person", id: "per_1" },
    });
    expect(run.error).toBeNull();
    expect(run.undeclared).toEqual([]);
    expect(host.records.get("person")?.get("per_1")?.["lifecycle.lifecycleStageChangedAt"]).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });
});
