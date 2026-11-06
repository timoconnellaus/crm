import { describe, expect, it } from "vitest";
import {
  formatReplayReport,
  parseCacheReportExport,
  parseReplayArgs,
  replayCacheReport,
} from "../../src/compaction/index.ts";
import sample from "./fixtures/cache-report.sample.json";

describe("cache report replay", () => {
  it("the sample export is valid", () => {
    const data = parseCacheReportExport(sample);
    expect(data.observations.length).toBeGreaterThan(50);
    expect(data.decisions.length).toBeGreaterThan(5);
  });

  it("reproduces the recorded estimates and decisions with unchanged parameters", () => {
    const report = replayCacheReport(sample);
    const [model] = report.models;
    expect(model).toMatchObject({
      provider: "example",
      model: "chat-large",
      ignored: sample.observations.filter((o) => !o.prefixUnchanged).length,
    });
    expect(model?.replayed.learnedSeconds).toBe(600);
    expect(model?.recordedLearnedSeconds).toBe(600);
    expect(report.decisions.agreeing).toBe(report.decisions.total);
    expect(report.decisions.withActual).toBe(report.decisions.total - 1);
    expect(report.decisions.meanAbsPctError).toBeLessThan(0.1);
    expect(report.decisions.replayedMeanAbsPctError).toBeCloseTo(
      report.decisions.meanAbsPctError ?? 0,
      10,
    );

    const text = formatReplayReport(report);
    expect(text).toContain("example/chat-large: replayed 10 min learned (recorded 10 min)");
    expect(text).toContain(`${report.decisions.total} decisions, ${report.decisions.total} agree`);
  });

  it("tries changed parameters", () => {
    const strict = replayCacheReport(sample, {
      learner: { hitBar: 0.97 },
      rails: { minTokens: 40_000 },
    });
    expect(strict.models[0]?.replayed.learnedSeconds).toBe(120); // a stricter bar errs shorter
    expect(strict.decisions.agreeing).toBeLessThan(strict.decisions.total);
    expect(strict.rows.some((r) => !r.agrees && r.replayed.rule === "floor")).toBe(true);
    expect(formatReplayReport(strict)).toContain("changed dec-");

    const published = replayCacheReport(sample, { published: { "example/chat-large": 300 } });
    expect(published.models[0]?.replayed).toMatchObject({ seconds: 300, source: "published" });
  });

  it("rejects a malformed export", () => {
    expect(() => replayCacheReport({ ...sample, version: 2 })).toThrow();
    expect(() =>
      replayCacheReport({
        ...sample,
        observations: [{ ...sample.observations[0], gapSeconds: -1 }],
      }),
    ).toThrow();
  });

  it("parses command-line arguments", () => {
    expect(
      parseReplayArgs([
        "export.json",
        "--hit-bar",
        "0.85",
        "--half-life-days",
        "7",
        "--min-tokens",
        "30000",
        "--published",
        "example/chat-large=300",
        "--published",
        "other/m=none",
        "--json",
      ]),
    ).toEqual({
      file: "export.json",
      json: true,
      overrides: {
        learner: { hitBar: 0.85, halfLifeDays: 7 },
        rails: { minTokens: 30_000 },
        published: { "example/chat-large": 300, "other/m": null },
      },
    });
    expect(() => parseReplayArgs([])).toThrow(/Usage/);
    expect(() => parseReplayArgs(["a.json", "--hit-bar"])).toThrow(/needs a number/);
    expect(() => parseReplayArgs(["a.json", "--bogus"])).toThrow(/Unknown option/);
    expect(() => parseReplayArgs(["a.json", "b.json"])).toThrow(/Only one/);
  });
});
