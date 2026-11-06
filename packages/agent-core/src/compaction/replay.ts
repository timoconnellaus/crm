// Offline replay of a cache report export (spec W2, "Review data"): rerun the learner over the
// recorded observations and the planner over the recorded decisions, optionally with changed
// parameters, and compare predicted cost with what the following turns actually cost.
// `scripts/ai-replay-cache.mjs` is the command-line wrapper (`pnpm ai:replay-cache <export.json>`).

import {
  type CacheLifetimeState,
  type EstimateChange,
  emptyCacheLifetimeState,
  estimateCacheLifetime,
  type LearnerParams,
  type LifetimeEstimate,
  observeCache,
} from "./cache-lifetime.ts";
import {
  type CacheReportExport,
  type CompactionDecisionRecord,
  type LearnerOverrides,
  parseCacheReportExport,
} from "./export.ts";
import { type PlanDecision, type PlannerParams, planCompaction, type Rails } from "./plan.ts";

export interface ReplayOverrides {
  learner?: LearnerOverrides;
  rails?: Partial<Rails>;
  planner?: Partial<PlannerParams>;
  /** Published lifetimes by `provider/model`; null removes a published value. */
  published?: Record<string, number | null>;
}

export interface ReplayModelSummary {
  provider: string;
  model: string;
  publishedLifetimeSeconds: number | null;
  observations: number;
  counted: number;
  ignored: number;
  /** The last recorded learned value from the export's history, if any. */
  recordedLearnedSeconds: number | null;
  /** The estimate the replay ends with. */
  replayed: LifetimeEstimate;
  changes: Array<EstimateChange & { atIso: string }>;
}

export interface ReplayDecisionRow {
  id: string;
  at: string;
  provider: string;
  model: string;
  recorded: CompactionDecisionRecord["result"];
  replayed: PlanDecision;
  agrees: boolean;
  /** Recorded prediction for the option taken, per turn. */
  predictedPerTurn: number | null;
  /** The replay's prediction for the option that was actually taken, per turn. */
  replayedPredictedPerTurn: number | null;
  actualPerTurn: number | null;
}

export interface ReplayReport {
  models: ReplayModelSummary[];
  decisions: {
    total: number;
    agreeing: number;
    recordedCompactions: number;
    replayedCompactions: number;
    /** Decisions with an actual cost recorded. */
    withActual: number;
    /** Mean per-turn cost over decisions with an actual cost. */
    meanPredictedPerTurn: number | null;
    meanReplayedPredictedPerTurn: number | null;
    meanActualPerTurn: number | null;
    /** Mean |predicted − actual| / actual, per turn, for the recorded and replayed predictions. */
    meanAbsPctError: number | null;
    replayedMeanAbsPctError: number | null;
  };
  rows: ReplayDecisionRow[];
}

const key = (provider: string, model: string) => `${provider}/${model}`;

/** Rerun the learner and planner over an export. Throws if the export is malformed. */
export function replayCacheReport(raw: unknown, overrides: ReplayOverrides = {}): ReplayReport {
  const data: CacheReportExport = parseCacheReportExport(raw);
  const learner: Partial<LearnerParams> = { ...data.params?.learner, ...overrides.learner };

  const published = new Map<string, number | null>();
  for (const m of data.models) published.set(key(m.provider, m.model), m.publishedLifetimeSeconds);
  for (const [k, v] of Object.entries(overrides.published ?? {})) published.set(k, v);

  // Observations before decisions at the same instant: a decision is planned after its turn's usage.
  type Event =
    | { kind: "obs"; t: number; i: number; rec: CacheReportExport["observations"][number] }
    | { kind: "dec"; t: number; i: number; rec: CompactionDecisionRecord };
  const events: Event[] = [
    ...data.observations.map((rec, i) => ({ kind: "obs" as const, t: Date.parse(rec.at), i, rec })),
    ...data.decisions.map((rec, i) => ({ kind: "dec" as const, t: Date.parse(rec.at), i, rec })),
  ];
  events.sort((a, b) => a.t - b.t || (a.kind === b.kind ? a.i - b.i : a.kind === "obs" ? -1 : 1));

  interface ModelRun {
    provider: string;
    model: string;
    state: CacheLifetimeState;
    observations: number;
    changes: Array<EstimateChange & { atIso: string }>;
  }
  const runs = new Map<string, ModelRun>();
  const runFor = (provider: string, model: string): ModelRun => {
    const k = key(provider, model);
    let run = runs.get(k);
    if (!run) {
      run = {
        provider,
        model,
        state: emptyCacheLifetimeState(learner),
        observations: 0,
        changes: [],
      };
      runs.set(k, run);
    }
    return run;
  };
  const contextFor = (provider: string, model: string) => ({
    publishedLifetimeSeconds: published.get(key(provider, model)) ?? null,
    params: learner,
  });

  const rows: ReplayDecisionRow[] = [];
  for (const event of events) {
    const run = runFor(event.rec.provider, event.rec.model);
    const context = contextFor(event.rec.provider, event.rec.model);
    if (event.kind === "obs") {
      const { rec } = event;
      run.observations++;
      const result = observeCache(
        run.state,
        {
          at: event.t,
          gapSeconds: rec.gapSeconds,
          prefixUnchanged: rec.prefixUnchanged,
          cachedTokens: rec.cachedTokens,
          promptTokens: rec.promptTokens,
          prefixTokens: rec.prefixTokens ?? null,
        },
        context,
      );
      run.state = result.state;
      if (result.change) run.changes.push({ ...result.change, atIso: rec.at });
      continue;
    }
    const { rec } = event;
    const estimate = estimateCacheLifetime(run.state, context);
    const replayed = planCompaction({
      ...rec.input,
      lifetime: {
        seconds: estimate.seconds,
        source: estimate.source,
        confidence: estimate.confidence,
      },
      rails: { ...rec.input.rails, ...overrides.rails },
      params: { ...rec.input.params, ...overrides.planner },
    });
    const taken = rec.result.decision;
    const perTurn = (cost: number | null, turns: number) => (cost === null ? null : cost / turns);
    rows.push({
      id: rec.id,
      at: rec.at,
      provider: rec.provider,
      model: rec.model,
      recorded: rec.result,
      replayed,
      agrees: replayed.decision === taken,
      predictedPerTurn: perTurn(
        taken === "compact" ? rec.result.costCompact : rec.result.costContinue,
        rec.result.horizonTurns,
      ),
      replayedPredictedPerTurn: perTurn(
        taken === "compact" ? replayed.costCompact : replayed.costContinue,
        replayed.horizonTurns,
      ),
      actualPerTurn: rec.actual ? rec.actual.cost / rec.actual.turns : null,
    });
  }

  const recordedLatest = new Map<string, number | null>();
  for (const h of [...data.estimateHistory].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    recordedLatest.set(key(h.provider, h.model), h.toSeconds);
  }

  const models: ReplayModelSummary[] = [...runs.values()].map((run) => ({
    provider: run.provider,
    model: run.model,
    publishedLifetimeSeconds: published.get(key(run.provider, run.model)) ?? null,
    observations: run.observations,
    counted: run.state.counted,
    ignored: run.state.ignored,
    recordedLearnedSeconds: recordedLatest.get(key(run.provider, run.model)) ?? null,
    replayed: estimateCacheLifetime(run.state, contextFor(run.provider, run.model)),
    changes: run.changes,
  }));

  const withActual = rows.filter((r) => r.actualPerTurn !== null);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const pctErrors = (pick: (r: ReplayDecisionRow) => number | null) =>
    mean(
      withActual.flatMap((r) => {
        const p = pick(r);
        const a = r.actualPerTurn ?? 0;
        return p === null || a === 0 ? [] : [Math.abs(p - a) / a];
      }),
    );

  return {
    models,
    decisions: {
      total: rows.length,
      agreeing: rows.filter((r) => r.agrees).length,
      recordedCompactions: rows.filter((r) => r.recorded.decision === "compact").length,
      replayedCompactions: rows.filter((r) => r.replayed.decision === "compact").length,
      withActual: withActual.length,
      meanPredictedPerTurn: mean(withActual.flatMap((r) => r.predictedPerTurn ?? [])),
      meanReplayedPredictedPerTurn: mean(
        withActual.flatMap((r) => r.replayedPredictedPerTurn ?? []),
      ),
      meanActualPerTurn: mean(withActual.flatMap((r) => r.actualPerTurn ?? [])),
      meanAbsPctError: pctErrors((r) => r.predictedPerTurn),
      replayedMeanAbsPctError: pctErrors((r) => r.replayedPredictedPerTurn),
    },
    rows,
  };
}

const fmtSeconds = (s: number | null) =>
  s === null ? "none" : s % 60 === 0 ? `${s / 60} min` : `${s} s`;
const fmtCost = (c: number | null) => (c === null ? "n/a" : `$${c.toFixed(6)}`);
const fmtPct = (p: number | null) => (p === null ? "n/a" : `${(p * 100).toFixed(1)}%`);

/** A plain-text summary of a replay, for the terminal. */
export function formatReplayReport(report: ReplayReport): string {
  const lines: string[] = ["Cache lifetime"];
  for (const m of report.models) {
    lines.push(
      `  ${m.provider}/${m.model}: replayed ${fmtSeconds(m.replayed.learnedSeconds)} learned` +
        ` (recorded ${fmtSeconds(m.recordedLearnedSeconds)}), published ${fmtSeconds(m.publishedLifetimeSeconds)},` +
        ` planner uses ${fmtSeconds(m.replayed.seconds)} (${m.replayed.source});` +
        ` ${m.counted} counted, ${m.ignored} ignored, effective sample ${m.replayed.sampleSize.toFixed(1)}`,
    );
    for (const c of m.changes) {
      lines.push(
        `    ${c.atIso} ${c.reason} ${fmtSeconds(c.fromSeconds)} -> ${fmtSeconds(c.toSeconds)}`,
      );
    }
  }
  const d = report.decisions;
  lines.push(
    "Decisions",
    `  ${d.total} decisions, ${d.agreeing} agree with the replay;` +
      ` compactions recorded ${d.recordedCompactions}, replayed ${d.replayedCompactions}`,
    `  per turn, over ${d.withActual} decisions with actual cost:` +
      ` predicted ${fmtCost(d.meanPredictedPerTurn)}, replayed ${fmtCost(d.meanReplayedPredictedPerTurn)},` +
      ` actual ${fmtCost(d.meanActualPerTurn)}`,
    `  mean absolute error: recorded ${fmtPct(d.meanAbsPctError)}, replayed ${fmtPct(d.replayedMeanAbsPctError)}`,
  );
  for (const r of report.rows.filter((row) => !row.agrees)) {
    lines.push(
      `  changed ${r.id} ${r.at}: ${r.recorded.decision} (${r.recorded.rule}) -> ${r.replayed.decision} (${r.replayed.rule})`,
    );
  }
  return lines.join("\n");
}

export interface ReplayArgs {
  file: string;
  json: boolean;
  overrides: ReplayOverrides;
}

export const REPLAY_USAGE = `Usage: pnpm ai:replay-cache <export.json> [options]

Reruns the cache-lifetime learner and the compaction planner over an ai.cacheReport export.

Learner:  --half-life-days N  --hit-share X  --hit-bar X  --lower-quantile X  --upper-quantile X
          --prior-strength N  --prior-agreement X  --min-prefix-tokens N
Rails:    --min-tokens N  --max-share X
Planner:  --max-horizon N  --fallback-idle-seconds N
Models:   --published provider/model=SECONDS|none   (repeatable)
Output:   --json`;

const LEARNER_FLAGS: Record<string, keyof LearnerOverrides> = {
  "--half-life-days": "halfLifeDays",
  "--hit-share": "hitShare",
  "--hit-bar": "hitBar",
  "--lower-quantile": "lowerQuantile",
  "--upper-quantile": "upperQuantile",
  "--prior-strength": "publishedPriorStrength",
  "--prior-agreement": "publishedPriorAgreement",
  "--min-prefix-tokens": "minPrefixTokens",
};

/** Parse command-line arguments. Throws an Error with a usage message on bad input. */
export function parseReplayArgs(argv: readonly string[]): ReplayArgs {
  const overrides: ReplayOverrides = {};
  let file: string | null = null;
  let json = false;
  const number = (flag: string, value: string | undefined): number => {
    const n = Number(value);
    if (value === undefined || value.trim() === "" || !Number.isFinite(n)) {
      throw new Error(`${flag} needs a number\n\n${REPLAY_USAGE}`);
    }
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const learnerKey = LEARNER_FLAGS[arg];
    if (learnerKey) {
      overrides.learner = { ...overrides.learner, [learnerKey]: number(arg, argv[++i]) };
    } else if (arg === "--min-tokens") {
      overrides.rails = { ...overrides.rails, minTokens: number(arg, argv[++i]) };
    } else if (arg === "--max-share") {
      overrides.rails = { ...overrides.rails, maxShareOfWindow: number(arg, argv[++i]) };
    } else if (arg === "--max-horizon") {
      overrides.planner = { ...overrides.planner, maxHorizonTurns: number(arg, argv[++i]) };
    } else if (arg === "--fallback-idle-seconds") {
      overrides.planner = { ...overrides.planner, fallbackIdleSeconds: number(arg, argv[++i]) };
    } else if (arg === "--published") {
      const spec = argv[++i] ?? "";
      const eq = spec.lastIndexOf("=");
      if (eq <= 0) throw new Error(`--published needs provider/model=SECONDS\n\n${REPLAY_USAGE}`);
      const value = spec.slice(eq + 1);
      overrides.published = {
        ...overrides.published,
        [spec.slice(0, eq)]: value === "none" ? null : number(arg, value),
      };
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(REPLAY_USAGE);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option ${arg}\n\n${REPLAY_USAGE}`);
    } else if (file === null) {
      file = arg;
    } else {
      throw new Error(`Only one export file, got ${file} and ${arg}\n\n${REPLAY_USAGE}`);
    }
  }
  if (file === null) throw new Error(REPLAY_USAGE);
  return { file, json, overrides };
}
