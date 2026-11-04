// The deterministic gate (ADR 0011, ADR 0018): actor × risk class (× bulk size) → auto | review |
// deny. The org picks a preset (an org setting, admin- and human-only to change). The deploy-time
// floor (env APPROVAL_FLOOR) can only make decisions stricter, never looser.
import { z } from "zod";
import { ConfigError } from "./errors.ts";
import { ACTORS, type Actor, RISK_CLASSES, type RiskClass } from "./principals.ts";

export const GATE_DECISIONS = ["auto", "review", "deny"] as const;
export type GateDecision = (typeof GATE_DECISIONS)[number];

/**
 * A cell of the matrix: a fixed decision, or a bulk threshold (auto while the number of records
 * touched is at most `autoUpTo`, otherwise `above`).
 */
export type GateRule = GateDecision | { autoUpTo: number; above: "review" | "deny" };
export type GateMatrix = Record<Actor, Record<RiskClass, GateRule>>;

export const POLICY_PRESETS = ["cautious", "balanced", "autonomous"] as const;
export type PolicyPreset = (typeof POLICY_PRESETS)[number];

/** Stored in core_settings under `approval_policy`. */
export const approvalPolicySchema = z.object({ preset: z.enum(POLICY_PRESETS) });
export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>;
export const DEFAULT_POLICY: ApprovalPolicy = { preset: "balanced" };
export const APPROVAL_POLICY_SETTING = "approval_policy";

const HUMAN_ALL_AUTO: Record<RiskClass, GateRule> = {
  read: "auto",
  write: "auto",
  "bulk-write": "auto",
  destructive: "auto",
  schema: "auto",
  extension: "auto",
  outbound: "auto",
};

const cautiousAi: Record<RiskClass, GateRule> = {
  read: "auto",
  write: "review",
  "bulk-write": "review",
  destructive: "review",
  schema: "review",
  extension: "review",
  outbound: "review",
};
const balancedAi: Record<RiskClass, GateRule> = {
  read: "auto",
  write: "auto",
  "bulk-write": { autoUpTo: 25, above: "review" },
  destructive: "review",
  schema: "review",
  extension: "review",
  outbound: "review",
};
/**
 * Balanced for external MCP clients (stage 2, ADR 0022, ADR 0018 amendment): every bulk write
 * goes to review whatever its size, as do destructive and merge operations (merges are
 * `destructive`). The in-app assistant keeps the stage-1 threshold until stage 7.
 */
const balancedMcp: Record<RiskClass, GateRule> = { ...balancedAi, "bulk-write": "review" };
const autonomousAi: Record<RiskClass, GateRule> = {
  read: "auto",
  write: "auto",
  "bulk-write": "auto",
  destructive: { autoUpTo: 10, above: "review" },
  schema: "review",
  extension: "review",
  outbound: "auto",
};

/**
 * Extension code (ADR 0025) is gated like an automation: it already holds declared, approved
 * permissions, but it never changes schema or extensions and bulk work above 100 records waits.
 */
const extensionRow = (bulk: GateRule, destructive: GateRule): Record<RiskClass, GateRule> => ({
  read: "auto",
  write: "auto",
  "bulk-write": bulk,
  destructive,
  schema: "deny",
  extension: "deny",
  outbound: "review",
});

/**
 * The presets. Humans are `auto` everywhere (role permissions still apply); the presets differ
 * in how much the in-app assistant, MCP clients and automations may do without review.
 * Automations never change schema or extensions.
 */
export const PRESET_MATRICES: Record<PolicyPreset, GateMatrix> = {
  cautious: {
    human: HUMAN_ALL_AUTO,
    assistant: cautiousAi,
    mcp: cautiousAi,
    automation: {
      read: "auto",
      write: "auto",
      "bulk-write": "review",
      destructive: "review",
      schema: "deny",
      extension: "deny",
      outbound: "review",
    },
    extension: extensionRow("review", "review"),
  },
  balanced: {
    human: HUMAN_ALL_AUTO,
    assistant: balancedAi,
    mcp: balancedMcp,
    automation: {
      read: "auto",
      write: "auto",
      "bulk-write": { autoUpTo: 100, above: "review" },
      destructive: "review",
      schema: "deny",
      extension: "deny",
      outbound: "review",
    },
    extension: extensionRow({ autoUpTo: 100, above: "review" }, "review"),
  },
  autonomous: {
    human: HUMAN_ALL_AUTO,
    assistant: autonomousAi,
    mcp: autonomousAi,
    automation: { ...autonomousAi, schema: "deny", extension: "deny" },
    extension: extensionRow("auto", { autoUpTo: 10, above: "review" }),
  },
};

/** Deploy-time floor: per actor (or `*`) and risk class (or `*`), the least strict rule allowed. */
export type GateFloor = Partial<Record<Actor | "*", Partial<Record<RiskClass | "*", GateRule>>>>;

const ruleSchema: z.ZodType<GateRule> = z.union([
  z.enum(GATE_DECISIONS),
  z.object({ autoUpTo: z.number().int().min(0), above: z.enum(["review", "deny"]) }).strict(),
]);
const floorSchema = z.partialRecord(
  z.enum([...ACTORS, "*"]),
  z.partialRecord(z.enum([...RISK_CLASSES, "*"]), ruleSchema),
);

/**
 * Parses APPROVAL_FLOOR, e.g. `{"*":{"destructive":"review"},"mcp":{"outbound":"deny"}}`.
 * Empty means no floor. Anything malformed throws: a broken floor must fail closed, never open.
 */
export function parseFloor(value: string | undefined | null): GateFloor {
  if (!value?.trim()) return {};
  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch {
    throw new ConfigError("APPROVAL_FLOOR is not valid JSON");
  }
  const parsed = floorSchema.safeParse(json);
  if (!parsed.success) {
    throw new ConfigError(`APPROVAL_FLOOR is invalid: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data as GateFloor;
}

const STRICTNESS: Record<GateDecision, number> = { auto: 0, review: 1, deny: 2 };

export function stricter(a: GateDecision, b: GateDecision): GateDecision {
  return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}

/** Applies one rule to a call touching `bulkSize` records. */
export function applyRule(rule: GateRule, bulkSize: number): GateDecision {
  if (typeof rule === "string") return rule;
  return bulkSize <= rule.autoUpTo ? "auto" : rule.above;
}

export interface GateRequest {
  actor: Actor;
  risk: RiskClass;
  /** Records the call touches. Single-record operations are 1. */
  bulkSize?: number;
  /**
   * For risk `outbound` (ADR 0051): the gatekeeper action's kind. Under Balanced an outbound
   * action is reviewed unless the gatekeeper marked it `autoApprovable` AND an admin enabled
   * auto-approval for its kind. Cautious always reviews; the floor still applies.
   */
  outbound?: { autoApprovable: boolean; enabled: boolean };
}

export interface GateResult {
  decision: GateDecision;
  /** What the org's preset said, before the floor. */
  policyDecision: GateDecision;
  /** What the floor said, when a floor rule applied. */
  floorDecision?: GateDecision;
  preset: PolicyPreset;
}

/** Evaluates the gate. Pure and synchronous; the pipeline loads the policy and floor. */
export function evaluateGate(
  request: GateRequest,
  policy: ApprovalPolicy,
  floor: GateFloor = {},
): GateResult {
  const bulkSize = Math.max(1, request.bulkSize ?? 1);
  let policyDecision = applyRule(
    PRESET_MATRICES[policy.preset][request.actor][request.risk],
    bulkSize,
  );
  if (
    request.risk === "outbound" &&
    policyDecision === "review" &&
    policy.preset === "balanced" &&
    request.outbound?.autoApprovable &&
    request.outbound.enabled
  ) {
    policyDecision = "auto";
  }

  const floorRules = [
    floor[request.actor]?.[request.risk],
    floor[request.actor]?.["*"],
    floor["*"]?.[request.risk],
    floor["*"]?.["*"],
  ].filter((rule): rule is GateRule => rule !== undefined);

  let decision = policyDecision;
  let floorDecision: GateDecision | undefined;
  for (const rule of floorRules) {
    const fromFloor = applyRule(rule, bulkSize);
    floorDecision = floorDecision ? stricter(floorDecision, fromFloor) : fromFloor;
    decision = stricter(decision, fromFloor);
  }
  return {
    decision,
    policyDecision,
    ...(floorDecision ? { floorDecision } : {}),
    preset: policy.preset,
  };
}

/** True when moving from `from` to `to` makes any cell less strict. Used to audit loosening. */
export function isLoosening(from: PolicyPreset, to: PolicyPreset): boolean {
  const a = PRESET_MATRICES[from];
  const b = PRESET_MATRICES[to];
  for (const actor of ACTORS) {
    for (const risk of RISK_CLASSES) {
      for (const size of [1, 10, 11, 25, 26, 100, 101, 10_000]) {
        if (
          STRICTNESS[applyRule(b[actor][risk], size)] < STRICTNESS[applyRule(a[actor][risk], size)]
        )
          return true;
      }
    }
  }
  return false;
}
