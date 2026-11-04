// The automation and notification UI's wording (src/components/automations/model.ts): run outcome
// text, the test-mode report as lines, the provenance line, diagram code parts, durations,
// compact relative times and notification links.
import type { AutomationTestReport, RunStepRecord } from "@crm/core";
import { describe, expect, it } from "vitest";
import {
  asTestReport,
  compactRelative,
  diagramParts,
  fallbackOutcomeText,
  formatDuration,
  joinNames,
  notificationHref,
  provenanceLine,
  runOutcome,
  statusTone,
  testReportLines,
} from "../src/components/automations/model.ts";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

function step(partial: Partial<RunStepRecord>): RunStepRecord {
  return {
    name: "step",
    kind: "do",
    status: "completed",
    startedAt: iso(NOW - DAY),
    operations: [],
    logs: [],
    ...partial,
  };
}

const run = (
  status: Parameters<typeof fallbackOutcomeText>[0]["status"],
  steps: RunStepRecord[],
) => ({
  status,
  statusReason: null,
  outcomeText: "",
  steps,
});

describe("run outcomes", () => {
  it("counts the days of a durable wait", () => {
    const start = NOW - 2 * 3600_000;
    const waiting = run("waiting", [
      step({ name: "create tasks" }),
      step({
        name: "wait",
        kind: "sleep",
        status: "waiting",
        startedAt: iso(start),
        until: iso(start + 3 * DAY),
      }),
    ]);
    expect(fallbackOutcomeText(waiting, NOW)).toBe("Waiting (day 1 of 3)");
    expect(fallbackOutcomeText(waiting, start + 2.5 * DAY)).toBe("Waiting (day 3 of 3)");
    expect(runOutcome(waiting, NOW).tone).toBe("pause");
  });

  it("shows a step that failed and then succeeded on retry", () => {
    const retried = run("completed", [step({ attempts: 2 }), step({ name: "notify" })]);
    expect(runOutcome(retried, NOW)).toEqual({ text: "Failed step 1 · retried ✓", tone: "fail" });
    expect(runOutcome(run("completed", [step({})]), NOW)).toEqual({
      text: "Completed",
      tone: "ok",
    });
  });

  it("names the failed step and other states", () => {
    expect(fallbackOutcomeText(run("failed", [step({}), step({ status: "failed" })]), NOW)).toBe(
      "Failed step 2",
    );
    expect(fallbackOutcomeText(run("review", []), NOW)).toBe("Waiting for approval");
    expect(fallbackOutcomeText({ ...run("skipped", []), statusReason: "depth limit" }, NOW)).toBe(
      "Skipped (depth limit)",
    );
    expect(fallbackOutcomeText(run("expired", []), NOW)).toBe("Expired (approval not decided)");
  });

  it("prefers the server's outcome text", () => {
    expect(
      runOutcome({ ...run("waiting", []), outcomeText: "Waiting (day 2 of 3)" }, NOW).text,
    ).toBe("Waiting (day 2 of 3)");
  });

  it("colours statuses", () => {
    expect(statusTone("active")).toBe("ok");
    expect(statusTone("paused")).toBe("pause");
    expect(statusTone("disabled")).toBe("pause");
    expect(statusTone("killed")).toBe("fail");
  });
});

const report = (partial: Partial<AutomationTestReport> = {}): AutomationTestReport => ({
  automationId: "deals.wonOnboarding",
  record: { object: "deals.deal", id: "rec_1", title: "Acme renewal 2027" },
  matched: true,
  matchReason: "stage Negotiation → Won",
  steps: [
    { name: "create onboarding tasks", kind: "do", operations: [], logs: [] },
    { name: "notify owner", kind: "do", operations: [], logs: [] },
    { name: "wait 3 days", kind: "sleep", skippedMs: 3 * DAY, operations: [], logs: [] },
    { name: "check tasks", kind: "do", operations: [], logs: [] },
  ],
  writes: ["Kick-off call", "Send welcome pack", "Set up account"].map((title, i) => ({
    object: "task",
    id: `tsk_pending_${i}`,
    action: "create",
    title,
    for: "Sarah Chen",
  })),
  notifications: [
    { to: ["usr_1"], toNames: ["Sarah Chen"], type: "automation.message", title: "Deal won" },
  ],
  approvals: [],
  policyPreset: "balanced",
  ok: true,
  ...partial,
});

const text = (lines: ReturnType<typeof testReportLines>) =>
  lines.map((line) => line.parts.map((p) => p.text).join(""));

describe("test-mode report", () => {
  it("reads like the reference design", () => {
    expect(text(testReportLines(report()))).toEqual([
      "✓ Trigger matched (stage Negotiation → Won)",
      "Would create 3 tasks for Sarah Chen (simulated, nothing written)",
      "Would notify Sarah Chen",
      "Would wait 3 days, then check tasks",
      "No approvals needed under your Balanced policy",
    ]);
    const lines = testReportLines(report());
    expect(lines[1]?.parts.find((p) => p.strong)?.text).toBe("Sarah Chen");
    expect(lines.at(-1)?.muted).toBe(true);
  });

  it("lists approvals and failures", () => {
    const lines = text(
      testReportLines(
        report({
          matched: false,
          matchReason: "stage is Lead",
          writes: [],
          notifications: [],
          steps: [],
          approvals: [{ operation: "task.createMany", reason: "bulk write", bulkSize: 3 }],
          error: { code: "boom", message: "step threw" },
        }),
      ),
    );
    expect(lines).toEqual([
      "✗ Trigger did not match: stage is Lead",
      "✗ Failed: step threw",
      "Would need approval: task.createMany ×3 (bulk write)",
      "Under your Balanced policy",
    ]);
  });

  it("pluralises extension objects and omits whom when unknown", () => {
    const lines = text(
      testReportLines(
        report({
          writes: [
            { object: "deals.deal", id: "a", action: "update", title: null },
            { object: "deals.deal", id: "b", action: "update", title: null },
            { object: "x.company", id: "c", action: "create", title: null },
          ],
        }),
      ),
    );
    expect(lines).toContain("Would update 2 deals (simulated, nothing written)");
    expect(lines).toContain("Would create 1 company (simulated, nothing written)");
  });

  it("narrows unknown values to a report", () => {
    expect(asTestReport(null)).toBeNull();
    expect(asTestReport({ matched: "yes" })).toBeNull();
    expect(asTestReport({ matched: true, steps: [] })?.writes).toEqual([]);
  });
});

describe("display helpers", () => {
  it("formats durations", () => {
    expect(formatDuration(3 * DAY)).toBe("3 days");
    expect(formatDuration(DAY)).toBe("1 day");
    expect(formatDuration(2 * 3600_000)).toBe("2 hours");
    expect(formatDuration(14 * DAY)).toBe("2 weeks");
    expect(formatDuration(10 * DAY)).toBe("10 days");
    expect(formatDuration(90_000)).toBe("1.5 minutes");
    expect(formatDuration(36 * 3600_000)).toBe("1.5 days");
    expect(formatDuration(100 * 60_000 + 30_000)).toBe("1.7 hours");
  });

  it("formats compact relative times", () => {
    expect(compactRelative(iso(NOW - 20_000), NOW)).toBe("just now");
    expect(compactRelative(iso(NOW - 5 * 60_000), NOW)).toBe("5m ago");
    expect(compactRelative(iso(NOW - 2 * 3600_000), NOW)).toBe("2h ago");
    expect(compactRelative(iso(NOW - 30 * 3600_000), NOW)).toBe("yesterday");
    expect(compactRelative(iso(NOW - 3 * DAY), NOW)).toBe("3d ago");
    expect(compactRelative(iso(NOW - 60 * DAY), NOW)).toBe("2026-09-06");
    expect(compactRelative(null, NOW)).toBe("");
  });

  it("joins names", () => {
    expect(joinNames(["Sarah"])).toBe("Sarah");
    expect(joinNames(["Sarah", "Tim", "Sarah"])).toBe("Sarah and Tim");
    expect(joinNames(["A", "B", "C", "D", "E"])).toBe("A, B and 3 others");
  });

  it("builds the provenance line", () => {
    const line = provenanceLine(
      {
        extensionId: "deals",
        extensionLabel: "Deals",
        version: "3",
        provenance: {
          author: "Claude (MCP)",
          approvedBy: "Tim",
          approvedAt: "2026-11-03T12:00:00Z",
          shipped: false,
        },
      },
      () => "2 days ago",
    );
    expect(line).toBe(
      "Deals extension · v3 · written by Claude (MCP) · approved by Tim, 2 days ago",
    );
    expect(
      provenanceLine(
        {
          extensionId: "deals",
          extensionLabel: null,
          version: null,
          provenance: { author: null, approvedBy: null, approvedAt: null, shipped: true },
        },
        () => "",
      ),
    ).toBe("deals extension · shipped");
  });

  it("splits diagram text around inline code", () => {
    expect(diagramParts("Deal · {code} changed → stage type {code}", ["stage", "won"])).toEqual([
      { text: "Deal · ", code: false },
      { text: "stage", code: true },
      { text: " changed → stage type ", code: false },
      { text: "won", code: true },
    ]);
    expect(diagramParts("3 days", [])).toEqual([{ text: "3 days", code: false }]);
  });
});

describe("notification links", () => {
  it("follows app paths and maps approvals to the inbox", () => {
    expect(notificationHref({ href: "/x/deals.deal/rec_1", link: null })).toBe(
      "/x/deals.deal/rec_1",
    );
    expect(notificationHref({ href: "/approvals/chs_ABC", link: null })).toBe(
      "/approvals?set=chs_ABC",
    );
  });

  it("never follows external URLs and falls back to the link", () => {
    expect(notificationHref({ href: "https://evil.example", link: null })).toBeNull();
    expect(notificationHref({ href: "//evil.example", link: null })).toBeNull();
    expect(
      notificationHref({
        href: null,
        link: { kind: "automationRun", automationId: "deals.wonOnboarding", runId: "arn_1" },
      }),
    ).toBe("/automations/deals.wonOnboarding?tab=runs&run=arn_1");
    expect(
      notificationHref({ href: null, link: { kind: "record", object: "person", id: "per_1" } }),
    ).toBe("/people/per_1");
    expect(notificationHref({ href: null, link: { kind: "approval", changeSetId: "chs_1" } })).toBe(
      "/approvals?set=chs_1",
    );
  });
});
