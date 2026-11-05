// The judge's per-placement switches (ADR 0230): shipped defaults (`JUDGE_PLACEMENTS`), then the
// deploy layer (the JUDGE_PLACEMENTS var, JSON), then the admin layer (core_settings
// `judge_settings`, written only by `judge.update`: human admins). Settings only: keys are never
// here (ADR 0151).
//
// A deployment that wants the record-content placements on from the start (the user's own) sets
// JUDGE_PLACEMENTS='{"summary.statements":true,"outbound.message":true,"sync.jobChange":true}';
// a fresh install leaves them off until an admin turns them on.
import {
  isJudgePlacement,
  JUDGE_PLACEMENTS,
  type JudgePlacementId,
  SWITCHABLE_PLACEMENTS,
} from "./placements.ts";

/** core_settings key. */
export const JUDGE_SETTINGS = "judge_settings";

export interface JudgeSettings {
  /** Admin switches, by placement. Absent: the deploy layer or the shipped default. */
  placements: Partial<Record<JudgePlacementId, boolean>>;
}

export const EMPTY_JUDGE_SETTINGS: JudgeSettings = { placements: {} };

/** A layer of switches from JSON; unknown placements and non-booleans are dropped. */
export function parsePlacementLayer(value: unknown): Partial<Record<JudgePlacementId, boolean>> {
  let parsed = value;
  if (typeof value === "string") {
    if (!value.trim()) return {};
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return {};
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Partial<Record<JudgePlacementId, boolean>> = {};
  for (const [id, on] of Object.entries(parsed as Record<string, unknown>)) {
    if (isJudgePlacement(id) && SWITCHABLE_PLACEMENTS.includes(id) && typeof on === "boolean") {
      out[id] = on;
    }
  }
  return out;
}

export type PlacementSource = "shipped" | "deploy" | "admin" | "fixed";

/** Whether each placement asks the judge (given a key), and which layer said so. */
export function resolvePlacements(
  deployVar: string | undefined,
  settings: JudgeSettings,
): Record<JudgePlacementId, { on: boolean; source: PlacementSource }> {
  const deploy = parsePlacementLayer(deployVar ?? "");
  const out = {} as Record<JudgePlacementId, { on: boolean; source: PlacementSource }>;
  for (const p of JUDGE_PLACEMENTS) {
    const id = p.id as JudgePlacementId;
    if (!p.switchable) {
      out[id] = { on: true, source: "fixed" };
    } else if (settings.placements[id] !== undefined) {
      out[id] = { on: settings.placements[id] as boolean, source: "admin" };
    } else if (deploy[id] !== undefined) {
      out[id] = { on: deploy[id] as boolean, source: "deploy" };
    } else {
      out[id] = { on: p.defaultOn, source: "shipped" };
    }
  }
  return out;
}
