// The judge (ADR 0230, docs/jev.md): one seam beside the model role registry. Code asks for a
// placement, never a model; Jev answers when a key is reachable, and with none every placement is
// off and behaves exactly as before stage 11.
import { type JudgeCallLog, type JudgeEnv, jevJudge, judgeRoute } from "./jev.ts";
import { type JudgePlacementId, placementInfo } from "./placements.ts";
import { EMPTY_JUDGE_SETTINGS, type JudgeSettings, resolvePlacements } from "./settings.ts";
import type { Judge, JudgeOutcome, JudgeRequest, Questions } from "./types.ts";

export * from "./calibration.ts";
export * from "./dev.ts";
export * from "./fake.ts";
export * from "./jev.ts";
export * from "./placements.ts";
export * from "./policy-rules.ts";
export * from "./questions.ts";
export * from "./settings.ts";
export * from "./types.ts";

export interface JudgeForOptions {
  /**
   * Loads the admin layer (one primary-key D1 read), at most once per judge, and only when a
   * switchable placement first asks: a read path that never asks costs nothing.
   */
  loadSettings?: () => Promise<JudgeSettings>;
  fetch?: typeof fetch;
  log?: (line: JudgeCallLog) => void;
}

/**
 * The judge for one invocation: `offJudge`-like (no network call, ever) when no key is reachable;
 * otherwise Jev, asking only for placements that are on (a switched-off placement answers `off`).
 */
export function judgeFor(env: JudgeEnv, options: JudgeForOptions = {}): Judge {
  const route = judgeRoute(env);
  if (!route.ready) {
    const reason = route.reason;
    return {
      provider: "off",
      async ask() {
        return { status: "unavailable", reason, detail: route.why };
      },
    };
  }
  const jev = jevJudge({
    route,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
  let settings: Promise<JudgeSettings> | undefined;
  const placementOn = async (placement: JudgePlacementId): Promise<boolean> => {
    if (!placementInfo(placement).switchable) return true;
    settings ??= (options.loadSettings?.() ?? Promise.resolve(EMPTY_JUDGE_SETTINGS)).catch(
      () => EMPTY_JUDGE_SETTINGS,
    );
    return resolvePlacements(env.JUDGE_PLACEMENTS, await settings)[placement].on;
  };
  return {
    provider: "jev",
    async ask<const Q extends Questions>(request: JudgeRequest<Q>): Promise<JudgeOutcome<Q>> {
      if (!(await placementOn(request.placement))) return { status: "unavailable", reason: "off" };
      return jev.ask(request);
    },
  };
}
