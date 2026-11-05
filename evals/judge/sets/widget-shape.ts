// The labelled set for `widget.shape` (docs/jev.md placement 6, ADR 0231 and 0239), written before
// its first run. Each case is a prompt as a person types it into "Describe a widget", and the side
// of each shape's threshold its answer should fall: `above` is a confident pick of that shape.
//
// The real failure is here verbatim: the dashboards eval's `people-this-month` ("The number of
// people added this month, compared with last month."), where the model drew a bar chart of two
// months and one number was expected (a kpi widget shows the previous period beside its number).
// Every other dashboards eval prompt is here too, verbatim. Around them: at least four prompts per
// shape, prompts that say too little (`unclear`), a named chart type, a comparison that is still
// one number, and an instruction planted in the prompt. Where a prompt fairly fits two shapes, the
// case leaves those shapes out and says why.
import type { Judge } from "@relationship-os/core/judge";
import {
  PICKABLE_SHAPES,
  SHAPE_PLACEMENT,
  SHAPE_QUESTION,
  SHAPE_THRESHOLD,
  type Shape,
  type ShapeState,
  shapeState,
} from "@relationship-os/core/judge-widget-shape";
import type { LabelledCase, PlacementSet, Side } from "../lib/calibrate.ts";

type Pickable = (typeof PICKABLE_SHAPES)[number];

/** `shape`: the confident pick expected (null: none, as for `unclear`); `fair`: also acceptable. */
function c(
  prompt: string,
  shape: Pickable | null,
  options: { fair?: Pickable[]; note?: string; name?: string } = {},
): LabelledCase<ShapeState> {
  const expect: Record<string, Side> = {};
  for (const s of PICKABLE_SHAPES) {
    if (options.fair?.includes(s)) continue;
    expect[s] = s === shape ? "above" : "below";
  }
  return {
    name: options.name ?? prompt.slice(0, 60),
    ...(options.note ? { note: options.note } : {}),
    state: shapeState(prompt),
    expect,
  };
}

const cases: LabelledCase<ShapeState>[] = [
  // --- One number (kpi) -----------------------------------------------------------------------
  c("The number of people added this month, compared with last month.", "kpi", {
    name: "people-this-month (the real failure, verbatim)",
    note: "dashboards eval: the model drew a bar chart; a kpi shows the previous period beside it",
  }),
  c("How many open tasks are overdue right now?", "kpi", {
    name: "overdue-tasks (eval, verbatim)",
  }),
  c("Total value of all open deals", "kpi"),
  c("Average deal size this quarter", "kpi"),
  c("Our win rate this year as a single figure", "kpi"),
  c("Number of meetings booked this week", "kpi"),
  c("Revenue this month against last month, as a bar chart", null, {
    note: "a named chart type: the person's own choice, so neither one number nor categories is held",
    fair: ["kpi", "categories", "trend"],
  }),

  // --- Comparison across categories -----------------------------------------------------------
  c("Show tasks by status as a bar chart.", "categories", {
    name: "tasks-by-status (eval, verbatim)",
  }),
  c("What share of our activities is each type (calls, emails, meetings, notes)?", "categories", {
    name: "activity-share (eval, verbatim)",
  }),
  c("Organisations by industry, as a horizontal bar chart.", "categories", {
    name: "organisations-by-industry (eval, verbatim)",
  }),
  c(
    "A pipeline-like funnel of tasks: all tasks, then those with a due date, then those completed.",
    "categories",
    { name: "task-funnel (eval, verbatim)" },
  ),
  c("The top 5 organisations by number of current people.", "categories", {
    name: "top-organisations (eval, verbatim)",
    note: "a ranked leaderboard; a table of the five is also fair",
    fair: ["rows"],
  }),
  c("Deals by stage", "categories"),
  c("Number of tasks completed by each user", "categories"),

  // --- Change over time -----------------------------------------------------------------------
  c("Show the trend of new people added over time, month by month.", "trend", {
    name: "people-trend (eval, verbatim)",
  }),
  c("Chart the activities logged each month, split by activity type.", "trend", {
    name: "activities-by-month-and-type (eval, verbatim)",
    note: "split by type as well: a series per type over months",
    fair: ["categories"],
  }),
  c("Deals won per week over the last six months", "trend"),
  c("How has the number of open tasks changed day by day this month?", "trend"),

  // --- A list of records ----------------------------------------------------------------------
  c("A table of the 10 open tasks due soonest, with their title and due date.", "rows", {
    name: "tasks-due-soon (eval, verbatim)",
  }),
  c("List the deals closing this month with their owner and value", "rows"),
  c("People added this week, with their email address and organisation", "rows"),
  c("Which tasks are overdue? Show each one with who it is assigned to.", "rows", {
    note: "which ones, with details: a list, not a count",
  }),

  // --- Fixed text -----------------------------------------------------------------------------
  c("A heading that says 'Sales targets for Q4'", "text"),
  c("Add a note explaining that the numbers refresh every hour", "text"),
  c("Put a short welcome message for new starters at the top", "text"),
  c("A text box with links to our sales playbook and pricing sheet", "text"),

  // --- Too little to tell (unclear) -----------------------------------------------------------
  c("deals", null, { note: "a topic, not a request" }),
  c("something about our customers", null),
  c("Make the dashboard better", null),
  c("Pipeline stuff for the Monday meeting", null),
];

type Answers = { probabilities: Record<Shape, number> };

export const widgetShapeSet: PlacementSet<ShapeState, Answers> = {
  id: "widget.shape",
  title: "widget.shape: which shape of widget does the prompt ask for?",
  where: "packages/core/src/judge/questions/widget-shape.ts",
  questions: PICKABLE_SHAPES.map((shape) => ({
    key: `widget.shape/${shape}`,
    title: `The prompt asks for ${shape}`,
    question: SHAPE_QUESTION,
    threshold: SHAPE_THRESHOLD,
    label: shape,
    read: (answers: Answers) => answers.probabilities[shape] ?? 0,
  })),
  cases,
  async ask(judge: Judge, state: ShapeState) {
    const outcome = await judge.ask({
      placement: SHAPE_PLACEMENT,
      state: state as unknown as Record<string, unknown>,
      questions: { shape: SHAPE_QUESTION },
    });
    return outcome.status === "answered"
      ? { probabilities: outcome.answers.shape.probabilities as Record<Shape, number> }
      : null;
  },
};
