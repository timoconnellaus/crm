// The gate's full matrix: every preset × actor × risk class, bulk thresholds, and the floor.
import { describe, expect, it } from "vitest";
import {
  ACTORS,
  type Actor,
  ConfigError,
  evaluateGate,
  type GateDecision,
  isLoosening,
  type PolicyPreset,
  parseFloor,
  RISK_CLASSES,
  type RiskClass,
} from "../src/index.ts";

// Expected decision for a single-record call (bulk size 1) and for a 1000-record call.
// Columns: read, write, bulk-write, destructive, schema, extension, outbound.
// A cell "a/r" means auto at size 1, review at size 1000.
const EXPECTED: Record<PolicyPreset, Record<Actor, string>> = {
  cautious: {
    human: "a a a a a a a",
    assistant: "a r r r r r r",
    mcp: "a r r r r r r",
    automation: "a a r r d d r",
    extension: "a a r r d d r",
  },
  balanced: {
    human: "a a a a a a a",
    assistant: "a a a/r r r r r",
    // Stage 2 (ADR 0018 amendment): every MCP bulk write is reviewed, whatever its size.
    mcp: "a a r r r r r",
    automation: "a a a/r r d d r",
    extension: "a a a/r r d d r",
  },
  autonomous: {
    human: "a a a a a a a",
    assistant: "a a a a/r r r a",
    mcp: "a a a a/r r r a",
    automation: "a a a a/r d d a",
    extension: "a a a a/r d d r",
  },
};

const LETTER: Record<string, GateDecision> = { a: "auto", r: "review", d: "deny" };

function expected(preset: PolicyPreset, actor: Actor, risk: RiskClass, size: number) {
  const cell = EXPECTED[preset][actor].split(" ")[RISK_CLASSES.indexOf(risk)] ?? "";
  const [small, large = small] = cell.split("/");
  return LETTER[(size === 1 ? small : large) ?? ""];
}

describe("gate matrix", () => {
  for (const preset of ["cautious", "balanced", "autonomous"] as const) {
    describe(preset, () => {
      for (const actor of ACTORS) {
        for (const risk of RISK_CLASSES) {
          for (const size of [1, 1000]) {
            it(`${actor} × ${risk} × ${size}`, () => {
              const result = evaluateGate({ actor, risk, bulkSize: size }, { preset });
              expect(result.decision).toBe(expected(preset, actor, risk, size));
              expect(result.policyDecision).toBe(result.decision);
              expect(result.preset).toBe(preset);
            });
          }
        }
      }
    });
  }
});

describe("bulk thresholds", () => {
  it("balanced lets the assistant bulk-write up to 25 records", () => {
    const at = (bulkSize: number) =>
      evaluateGate({ actor: "assistant", risk: "bulk-write", bulkSize }, { preset: "balanced" })
        .decision;
    expect(at(25)).toBe("auto");
    expect(at(26)).toBe("review");
  });

  it("balanced reviews every MCP bulk write, even of 2 records", () => {
    const at = (bulkSize: number) =>
      evaluateGate({ actor: "mcp", risk: "bulk-write", bulkSize }, { preset: "balanced" }).decision;
    expect(at(1)).toBe("review");
    expect(at(2)).toBe("review");
    expect(evaluateGate({ actor: "mcp", risk: "write" }, { preset: "balanced" }).decision).toBe(
      "auto",
    );
  });

  it("balanced lets automations bulk-write up to 100 records", () => {
    const at = (bulkSize: number) =>
      evaluateGate({ actor: "automation", risk: "bulk-write", bulkSize }, { preset: "balanced" })
        .decision;
    expect(at(100)).toBe("auto");
    expect(at(101)).toBe("review");
  });

  it("autonomous lets AI delete up to 10 records", () => {
    const at = (bulkSize: number) =>
      evaluateGate({ actor: "assistant", risk: "destructive", bulkSize }, { preset: "autonomous" })
        .decision;
    expect(at(10)).toBe("auto");
    expect(at(11)).toBe("review");
  });

  it("treats a missing or zero bulk size as one record", () => {
    expect(
      evaluateGate({ actor: "assistant", risk: "bulk-write", bulkSize: 0 }, { preset: "balanced" })
        .decision,
    ).toBe("auto");
  });
});

describe("floor", () => {
  it("makes decisions stricter", () => {
    const floor = parseFloor('{"human":{"destructive":"review"}}');
    const result = evaluateGate(
      { actor: "human", risk: "destructive" },
      { preset: "balanced" },
      floor,
    );
    expect(result).toMatchObject({
      decision: "review",
      policyDecision: "auto",
      floorDecision: "review",
    });
  });

  it("never loosens the preset", () => {
    const floor = parseFloor('{"*":{"*":"auto"}}');
    for (const preset of ["cautious", "balanced", "autonomous"] as const) {
      for (const actor of ACTORS) {
        for (const risk of RISK_CLASSES) {
          const withFloor = evaluateGate({ actor, risk }, { preset }, floor);
          const without = evaluateGate({ actor, risk }, { preset });
          expect(withFloor.decision).toBe(without.decision);
        }
      }
    }
  });

  it("applies wildcards and takes the strictest matching rule", () => {
    const floor = parseFloor(
      '{"*":{"outbound":"review","*":{"autoUpTo":5,"above":"deny"}},"mcp":{"outbound":"deny"}}',
    );
    const run = (actor: Actor, risk: RiskClass, bulkSize = 1) =>
      evaluateGate({ actor, risk, bulkSize }, { preset: "autonomous" }, floor).decision;
    expect(run("mcp", "outbound")).toBe("deny");
    expect(run("assistant", "outbound")).toBe("review");
    expect(run("human", "write", 5)).toBe("auto");
    expect(run("human", "write", 6)).toBe("deny");
  });

  it("can deny a whole actor", () => {
    const floor = parseFloor('{"automation":{"*":"deny"}}');
    for (const risk of RISK_CLASSES) {
      expect(
        evaluateGate({ actor: "automation", risk }, { preset: "autonomous" }, floor).decision,
      ).toBe("deny");
    }
  });

  it("is empty when unset", () => {
    expect(parseFloor(undefined)).toEqual({});
    expect(parseFloor("  ")).toEqual({});
  });

  it("fails closed on malformed floors", () => {
    expect(() => parseFloor("{not json")).toThrow(ConfigError);
    expect(() => parseFloor('{"robot":{"read":"auto"}}')).toThrow(ConfigError);
    expect(() => parseFloor('{"mcp":{"read":"maybe"}}')).toThrow(ConfigError);
    expect(() => parseFloor('{"mcp":{"read":{"autoUpTo":-1,"above":"deny"}}}')).toThrow(
      ConfigError,
    );
  });
});

describe("preset ordering", () => {
  it("knows which changes loosen the policy", () => {
    expect(isLoosening("cautious", "balanced")).toBe(true);
    expect(isLoosening("balanced", "autonomous")).toBe(true);
    expect(isLoosening("autonomous", "cautious")).toBe(false);
    expect(isLoosening("balanced", "cautious")).toBe(false);
    expect(isLoosening("balanced", "balanced")).toBe(false);
  });
});
