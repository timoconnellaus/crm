// Calibration (ADR 0231, docs/jev.md "Thresholds and calibration"): each case of a labelled set is
// asked `runs` times and judged by its median against the question's threshold. A median within
// CLOSE_CALL of the threshold could land either side on another day, so it is a close call,
// counted as neither right nor wrong. A case clearly on the wrong side is WRONG; a case with no
// answer is unanswered. A run with any wrong or unanswered case fails.
//
// Everything here but `runPlacementSet` is arithmetic, and is unit-tested.
import type { CalibrationRecord, Judge, Question } from "@relationship-os/core/judge";
import { questionHash } from "@relationship-os/core/judge";
import { withRun } from "./recorder.ts";

/** A median this close to the threshold is a close call (ADR 0231). */
export const CLOSE_CALL = 0.15;

export type Side = "above" | "below";

/** One question of a placement: its calibration key, threshold and how to read its number. */
export interface SetQuestion<A> {
  /** `authoring.intent/recipients`: the calibration record's key. */
  key: string;
  title: string;
  /** The question as the product asks it (hashed for the calibration record). */
  question: Question;
  threshold: number;
  /** The label(s) held to the threshold, for the record. */
  label: string;
  /** The number the product holds to the threshold. */
  read(answers: A): number;
}

/** One labelled case: a state built by the product's own function, and the side per question. */
export interface LabelledCase<S> {
  name: string;
  /** Where the case comes from: a real eval failure, its correct twin, a boundary, … */
  note?: string;
  state: S;
  expect: Record<string, Side>;
}

/** A labelled set for one placement: every case asks all its questions in one call. */
export interface PlacementSet<S, A> {
  id: string;
  title: string;
  /** The file the questions live in. */
  where: string;
  questions: SetQuestion<A>[];
  cases: LabelledCase<S>[];
  /** Asks one case once; null where the judge gave no answer. */
  ask(judge: Judge, state: S): Promise<A | null>;
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export type CaseVerdict = "right" | "wrong" | "close" | "unanswered";

export interface CaseResult {
  name: string;
  expect: Side;
  answers: number[];
  median: number | null;
  verdict: CaseVerdict;
}

/** Where a case's answers leave it. At the threshold counts as above, as the product decides. */
export function judgeCase(
  name: string,
  expect: Side,
  answers: number[],
  threshold: number,
  runs: number,
): CaseResult {
  if (answers.length < runs) {
    return {
      name,
      expect,
      answers,
      median: answers.length ? median(answers) : null,
      verdict: "unanswered",
    };
  }
  const middle = median(answers);
  const side: Side = middle >= threshold ? "above" : "below";
  const verdict: CaseVerdict =
    Math.abs(middle - threshold) < CLOSE_CALL ? "close" : side === expect ? "right" : "wrong";
  return { name, expect, answers, median: middle, verdict };
}

export interface Margin {
  highestBelow: number | null;
  belowGap: number | null;
  lowestAbove: number | null;
  aboveGap: number | null;
  /** Every "below" median sits under every "above" median, so some threshold separates them. */
  separates: boolean;
}

export function marginOf(cases: CaseResult[], threshold: number): Margin {
  const medians = (side: Side) =>
    cases.flatMap((c) => (c.expect === side && c.median !== null ? [c.median] : []));
  const below = medians("below");
  const above = medians("above");
  const highestBelow = below.length ? Math.max(...below) : null;
  const lowestAbove = above.length ? Math.min(...above) : null;
  return {
    highestBelow,
    belowGap: highestBelow === null ? null : threshold - highestBelow,
    lowestAbove,
    aboveGap: lowestAbove === null ? null : lowestAbove - threshold,
    separates: highestBelow === null || lowestAbove === null || highestBelow < lowestAbove,
  };
}

export interface QuestionResult {
  key: string;
  title: string;
  threshold: number;
  label: string;
  question: Question;
  cases: CaseResult[];
  right: number;
  wrong: number;
  close: number;
  unanswered: number;
  margin: Margin;
  /** The widest gap between two adjacent medians on either side (most spread within a case). */
  spread: number;
}

export function summarise(
  q: Pick<SetQuestion<unknown>, "key" | "title" | "threshold" | "label" | "question">,
  cases: CaseResult[],
): QuestionResult {
  const count = (v: CaseVerdict) => cases.filter((c) => c.verdict === v).length;
  const spread = Math.max(
    0,
    ...cases.map((c) => (c.answers.length ? Math.max(...c.answers) - Math.min(...c.answers) : 0)),
  );
  return {
    key: q.key,
    title: q.title,
    threshold: q.threshold,
    label: q.label,
    question: q.question,
    cases,
    right: count("right"),
    wrong: count("wrong"),
    close: count("close"),
    unanswered: count("unanswered"),
    margin: marginOf(cases, q.threshold),
    spread,
  };
}

/** Runs every case `runs` times (each run under its own recording) and judges each question. */
export async function runPlacementSet<S, A>(
  set: PlacementSet<S, A>,
  judge: Judge,
  runs = 3,
  onCase?: (name: string) => void,
): Promise<QuestionResult[]> {
  const numbers = new Map<string, Map<string, number[]>>();
  for (const c of set.cases) {
    onCase?.(c.name);
    for (let run = 1; run <= runs; run += 1) {
      const answers = await withRun(run, `${set.id}/${c.name}`, () => set.ask(judge, c.state));
      if (!answers) continue;
      for (const q of set.questions) {
        const per = numbers.get(q.key) ?? new Map<string, number[]>();
        per.set(c.name, [...(per.get(c.name) ?? []), q.read(answers)]);
        numbers.set(q.key, per);
      }
    }
  }
  return set.questions.map((q) => {
    const cases = set.cases
      .filter((c) => c.expect[q.key.split("/").at(-1) as string] !== undefined)
      .map((c) =>
        judgeCase(
          c.name,
          c.expect[q.key.split("/").at(-1) as string] as Side,
          numbers.get(q.key)?.get(c.name) ?? [],
          q.threshold,
          runs,
        ),
      );
    return summarise(q, cases);
  });
}

/** The process exit code: a failure where any case is wrong or unanswered. Close calls pass. */
export const exitCodeFor = (results: Pick<QuestionResult, "wrong" | "unanswered">[]): number =>
  results.some((r) => r.wrong > 0 || r.unanswered > 0) ? 1 : 0;

/** A question's calibration record (calibration.json). */
export async function calibrationRecord(
  result: QuestionResult,
  model: string,
  runs: number,
  mode: string,
  date: string,
): Promise<CalibrationRecord> {
  const round = (n: number | null) => (n === null ? null : Math.round(n * 1000) / 1000);
  return {
    hash: await questionHash(result.question, model),
    model,
    threshold: result.threshold,
    label: result.label,
    cases: result.cases.length,
    right: result.right,
    wrong: result.wrong,
    close: result.close,
    unanswered: result.unanswered,
    closeCalls: result.cases.filter((c) => c.verdict === "close").map((c) => c.name),
    highestBelow: round(result.margin.highestBelow),
    belowGap: round(result.margin.belowGap),
    lowestAbove: round(result.margin.lowestAbove),
    aboveGap: round(result.margin.aboveGap),
    runs,
    mode,
    date,
  };
}

const shown = (n: number | null) => (n === null ? "–" : n.toFixed(2));
const WORDS: Record<CaseVerdict, string> = {
  right: "right",
  wrong: "**WRONG**",
  close: "close call",
  unanswered: "**not answered**",
};

/** One question as a section of the report. */
export function questionReport(r: QuestionResult): string[] {
  const m = r.margin;
  return [
    `### ${r.title}`,
    "",
    `\`${r.key}\`, P(${r.label}) against threshold ${r.threshold}. Right ${r.right}, wrong ${r.wrong}, close calls ${r.close}, unanswered ${r.unanswered}, of ${r.cases.length}. Most spread within one case: ${r.spread.toFixed(2)}.`,
    "",
    `Gap: the highest "below" median is ${shown(m.highestBelow)} (${shown(m.belowGap)} under the threshold); the lowest "above" median is ${shown(m.lowestAbove)} (${shown(m.aboveGap)} over it).${m.separates ? "" : " **The cases do not separate: no threshold puts them all on the right side.**"}`,
    "",
    "| Case | Expect | Median | Runs | Verdict |",
    "| --- | --- | --- | --- | --- |",
    ...r.cases.map(
      (c) =>
        `| ${c.name} | ${c.expect} | ${shown(c.median)} | ${c.answers.map((a) => a.toFixed(2)).join(", ") || "–"} | ${WORDS[c.verdict]} |`,
    ),
    "",
  ];
}
