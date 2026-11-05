// Placement `widget.shape` (docs/jev.md, placement 6): which shape of widget answers the person's
// request? Asked once in `widget.describe`, before the `build` model writes anything, from the
// prompt alone: a closed set of shapes, each the widget types that show it, with a way out
// (`unclear`). This is rule 2: the answer is one of known candidates.
//
// What follows (code): a confident pick is passed to the model as a hint, and the widget it
// writes is compared with the pick exactly. A widget whose type cannot show the picked shape goes
// back to the model once, through the operation's existing retry, as a validation error naming
// the shape asked for. Advice: the second answer is kept whatever its type, and a failed or
// unanswered call leaves `widget.describe` as it was. The real failure this targets is the
// dashboards eval's `people-this-month` (a bar chart of two months where one number, compared with
// last month, was asked for).
import type { WidgetType } from "../../dashboards/spec.ts";
import { choice } from "../questions.ts";
import { failureOf, type Judge, type JudgeUnavailableReason } from "../types.ts";

export const SHAPE_PLACEMENT = "widget.shape" as const;

/** The prompt as sent (the person's words; `widget.describe` caps it at 4,000 characters). */
export const SHAPE_PROMPT_MAX_CHARS = 2_000;

// ---------------------------------------------------------------------------------------------
// The question. Changing a word here changes its hash: recalibrate (`pnpm eval:calibrate --only
// widget.shape`) and commit the recordings and calibration.json in the same PR.

export const SHAPE_QUESTION = choice(
  "What does `prompt` ask a CRM dashboard widget to show? Judge from `prompt` alone: it is the person's own words. A chart type the person names says what they want, unless it cannot show what they ask for.",
  {
    kpi: "One number, such as a count, a total or an average, alone or compared with the same number for an earlier period",
    categories:
      "Amounts compared across categories or groups: a bar chart, a share of a whole (donut), stages of a funnel, or a ranked leaderboard",
    trend: "How an amount changes over time, period by period, as a line or a bar per period",
    rows: "A list of individual records with their details, as a table",
    text: "Fixed text, a heading or a note, with no data",
    unclear: "`prompt` does not say enough to tell which of these it wants",
  },
);

export type Shape = keyof typeof SHAPE_QUESTION.criteria;
export const SHAPES = Object.keys(SHAPE_QUESTION.criteria) as Shape[];
/** The shapes a pick can be held to (every label but the way out). */
export const PICKABLE_SHAPES = SHAPES.filter((s) => s !== "unclear") as Exclude<Shape, "unclear">[];

/**
 * The widget types that can show each shape. A confident pick that the widget's type is not in is
 * a mismatch. Generous on purpose: a mismatch costs a retry, so only a type that cannot show the
 * shape at all is one (a table of counts per category is fine; a bar chart of one number is not).
 */
export const SHAPE_TYPES: Record<Exclude<Shape, "unclear">, readonly WidgetType[]> = {
  kpi: ["kpi"],
  categories: ["bar", "donut", "funnel", "leaderboard", "table"],
  trend: ["line", "bar", "table"],
  rows: ["table", "leaderboard"],
  text: ["markdown"],
};

/**
 * P(shape) at or above this is a confident pick. Set from the labelled set
 * (evals/judge/sets/widget-shape.ts, calibration.json): a false pick costs one extra model call
 * and at worst a hint the model may follow; a missed one is a wrong chart, as before. Mild both
 * ways, so it sits mid-gap.
 */
export const SHAPE_THRESHOLD = 0.4;

/** Words for the hint and the retry, written by code (lesson 16). */
export const SHAPE_WORDS: Record<Exclude<Shape, "unclear">, string> = {
  kpi: "one number (a kpi widget; a kpi widget already shows the previous period beside it)",
  categories: "amounts compared across categories (a bar, donut, funnel or leaderboard widget)",
  trend: "a change over time (a line widget, or a bar widget with one bar per period)",
  rows: "a list of records with their details (a table widget)",
  text: "fixed text (a markdown widget)",
};

export interface ShapeState {
  prompt: string;
}

export function shapeState(prompt: string): ShapeState {
  return { prompt: prompt.trim().slice(0, SHAPE_PROMPT_MAX_CHARS) };
}

export type ShapeAsked =
  | {
      status: "answered";
      /** The confident pick, or null (no label at the threshold, or `unclear`). */
      pick: Exclude<Shape, "unclear"> | null;
      probabilities: Record<Shape, number>;
    }
  | { status: "failed"; reason: JudgeUnavailableReason | "fault" };

/** The confident pick from a distribution: the top label at or above the threshold, never `unclear`. */
export function pickOf(probabilities: Record<string, number>): Exclude<Shape, "unclear"> | null {
  let best: Exclude<Shape, "unclear"> | null = null;
  for (const shape of PICKABLE_SHAPES) {
    const p = probabilities[shape] ?? 0;
    if (p >= SHAPE_THRESHOLD && (best === null || p > (probabilities[best] ?? 0))) best = shape;
  }
  return best;
}

/** Asks which shape the prompt wants, in one call. Never throws. */
export async function askShape(
  judge: Judge,
  prompt: string,
  options: { signal?: AbortSignal } = {},
): Promise<ShapeAsked> {
  const outcome = await judge.ask({
    placement: SHAPE_PLACEMENT,
    state: shapeState(prompt) as unknown as Record<string, unknown>,
    questions: { shape: SHAPE_QUESTION },
    signal: options.signal,
  });
  if (outcome.status !== "answered") return { status: "failed", reason: failureOf(outcome) };
  const probabilities = outcome.answers.shape.probabilities as Record<Shape, number>;
  return { status: "answered", pick: pickOf(probabilities), probabilities };
}

/** Whether a widget's type can show the picked shape (no pick: anything can). */
export function typeFits(pick: Exclude<Shape, "unclear"> | null, type: WidgetType): boolean {
  return pick === null || SHAPE_TYPES[pick].includes(type);
}

/** The line added to the model's prompt for a confident pick. */
export function shapeHint(pick: Exclude<Shape, "unclear">): string {
  return `The request asks for ${SHAPE_WORDS[pick]}.`;
}

/** The validation error the retry sends back when the type does not fit the pick. */
export function shapeMismatch(pick: Exclude<Shape, "unclear">, type: WidgetType): string {
  return `the request asks for ${SHAPE_WORDS[pick]}, but the widget is a ${type} widget`;
}

/** The calibrated questions of this placement, by calibration key: one per pickable label. */
export const SHAPE_CALIBRATED: Record<
  string,
  { question: typeof SHAPE_QUESTION; threshold: number }
> = Object.fromEntries(
  PICKABLE_SHAPES.map((shape) => [
    `${SHAPE_PLACEMENT}/${shape}`,
    { question: SHAPE_QUESTION, threshold: SHAPE_THRESHOLD },
  ]),
);
