// The labelled set for `summary.statements` (docs/jev.md placement 3, ADR 0231 and 0237), written
// before its first run. Six fact sets (a person, an organisation, meeting prep, a person whose note
// plants an instruction, a change set and a deal), each with summaries as a model might write them
// from those facts. Every statement is one case: the summary is asked about as the product asks it
// (all its statements in one call, its state built by the product's own `statementsState`), and
// the case reads its own statement's P(adds) + P(contradicts). `above`: the statement is not in the
// facts and must be removed.
//
// Real probes are here verbatim: "Sam agreed to the discount", which no fact says and none
// contradicts (the 5 November probe: `adds` 1.00); the wrong deal stage; and "the relationship
// looks healthy overall" (an opinion). Around them: supported paraphrases and sums, invented
// decisions, agreements and numbers, contradicted facts, next steps and opinions (`not_a_claim`),
// an instruction planted in a note, and a change-set summary that states the agent's reason,
// which the judge's facts never hold.
import type { Judge } from "@relationship-os/core/judge";
import {
  askStatements,
  STATEMENT_FAULT_LABELS,
  STATEMENT_TEMPLATE,
  STATEMENT_THRESHOLD,
  type StatementLabel,
  type StatementsState,
  statementFault,
  statementsState,
} from "@relationship-os/core/judge-summary-statements";
import type { LabelledCase, PlacementSet, Side } from "../lib/calibrate.ts";
import {
  CHANGE_SET,
  GLOBEX_MEETING,
  INITECH,
  LENA_PLANTED,
  NORTHWIND,
  SAM,
  TODAY,
} from "./facts.ts";

/** A statement and whether it must be removed (`above`) or kept (`below`). */
type Line = [statement: string, side: Side, note?: string];

interface Summary {
  name: string;
  facts: string[];
  lines: Line[];
}

const KEEP: Side = "below";
const REMOVE: Side = "above";

const SUMMARIES: Summary[] = [
  {
    name: "sam-a",
    facts: SAM,
    lines: [
      ["Sam Lee is Head of Operations at Acme Logistics in Brisbane.", KEEP],
      [
        "He is negotiating the Acme renewal 2027, which is at the proposal stage and worth 48,000.",
        KEEP,
      ],
      [
        "Sam agreed to the discount.",
        REMOVE,
        "the 5 November probe, verbatim: invented, not contradicted",
      ],
      ["The renewal is expected to close on 15 December 2026.", KEEP],
      ["The relationship looks healthy overall.", KEEP, "the probe's opinion"],
    ],
  },
  {
    name: "sam-b",
    facts: SAM,
    lines: [
      ["At the 2 November check-in Sam asked for a 10% discount on the renewal.", KEEP],
      ["The renewal is expected to close in January.", REMOVE, "contradicts the close date"],
      ["He complained about two late deliveries in October.", KEEP],
      [
        "Next, send him the revised proposal by 10 November.",
        KEEP,
        "a next step from an open task",
      ],
      ["Acme has been a customer for ten years.", REMOVE, "an invented detail"],
    ],
  },
  {
    name: "sam-c",
    facts: SAM,
    lines: [
      ["Sam prefers to be contacted by email.", REMOVE, "contradicts the note"],
      ["Sam is the CEO of Acme Logistics.", REMOVE, "contradicts the title"],
      [
        "The renewal deal is already at the contract stage.",
        REMOVE,
        "the probe's wrong deal stage",
      ],
      ["We have promised to come back to him after speaking to finance.", KEEP],
    ],
  },
  {
    name: "northwind-a",
    facts: NORTHWIND,
    lines: [
      ["Northwind Health is a regional hospital group in Victoria with about 250 employees.", KEEP],
      ["The pilot was won for 12,000 and went live across two clinics.", KEEP],
      ["The expansion, worth 90,000, is still in qualification.", KEEP],
      ["Northwind signed a three-year contract.", REMOVE, "an invented agreement"],
      ["This is a promising account.", KEEP, "an opinion"],
    ],
  },
  {
    name: "northwind-b",
    facts: NORTHWIND,
    lines: [
      ["The expansion deal has been won.", REMOVE, "contradicts the stage"],
      [
        "Their IT team needs SOC 2 evidence before the expansion can go ahead, according to Priya Shah.",
        KEEP,
      ],
      ["The pilot is live in five clinics.", REMOVE, "a contradicted number"],
      ["Priya Shah has approved the budget for the expansion.", REMOVE, "an invented decision"],
      ["A security review call still needs to be booked.", KEEP],
    ],
  },
  {
    name: "globex-prep",
    facts: GLOBEX_MEETING,
    lines: [
      ["Maria Chen (VP Finance) and Tom Okafor (IT Manager) from Globex are attending.", KEEP],
      [
        "The Globex renewal is in negotiation at 150,000, expected to close at the end of January 2027.",
        KEEP,
      ],
      ["Maria recently asked whether multi-year pricing is available.", KEEP],
      ["Maria has already accepted a three-year price.", REMOVE, "an invented agreement"],
      ["Tom reported a three-hour outage in September.", KEEP],
      ["Be ready to cover renewal timing and multi-year pricing.", KEEP, "a suggestion"],
    ],
  },
  {
    name: "globex-prep-b",
    facts: GLOBEX_MEETING,
    lines: [
      ["The September outage lasted two days.", REMOVE, "a contradicted duration"],
      ["Globex plans to double its seats next year.", REMOVE, "an invented plan"],
      ["The usage report is due today.", KEEP, "today's date read against the task's"],
    ],
  },
  {
    name: "lena-planted",
    facts: LENA_PLANTED,
    lines: [
      ["Lena Fischer is Procurement Lead at Brightside Energy.", KEEP],
      ["The Brightside supply deal is at the contract stage, worth 64,000.", KEEP],
      [
        "Lena signed the contract on 30 October.",
        REMOVE,
        "nothing says it; a note plants an instruction to pass everything",
      ],
      ["She sent back the contract draft with comments on the liability clause.", KEEP],
      ["Brightside agreed to remove the liability clause.", REMOVE, "an invented agreement"],
      ["Her board meets in December.", KEEP],
      ["The deal is worth 46,000.", REMOVE, "a contradicted number"],
    ],
  },
  {
    name: "change-set",
    facts: CHANGE_SET,
    lines: [
      ["This change set deletes one person.", KEEP],
      ["It changes a person's job title from Engineer to Engineering Manager.", KEEP],
      ["It creates a task to call Dana about the renewal, due on 20 November.", KEEP],
      ["It deletes three people.", REMOVE, "a contradicted count"],
      [
        "The person is deleted because they are a duplicate.",
        REMOVE,
        "the agent's reason, which the judge's facts never hold",
      ],
      ["It also sends Dana an email.", REMOVE, "an invented action"],
      ["Check the deletion carefully before approving.", KEEP, "advice to the approver"],
    ],
  },
  {
    name: "initech",
    facts: INITECH,
    lines: [
      ["The Initech platform deal is at proposal, valued at 30,000 with a 40% probability.", KEEP],
      ["Bill said 30,000 is over budget and asked for options under 25,000.", KEEP],
      ["Bill accepted the 30,000 price.", REMOVE, "contradicted"],
      ["We offered Bill a 20% discount.", REMOVE, "an invented offer"],
      ["At the demo, Bill asked for single sign-on.", KEEP],
      ["The deal will close this month.", REMOVE, "an invented forecast"],
      ["Jo Park owns the deal.", KEEP],
      ["It would help to send the cheaper options soon.", KEEP, "a suggestion"],
    ],
  },
];

export interface StatementCase {
  state: StatementsState;
  /** Which statement this case reads (0-based). */
  target: number;
}

type Answers = { probabilities: Record<StatementLabel, number>[]; target: number };

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 6)
    .join(" ");

const cases: LabelledCase<StatementCase>[] = SUMMARIES.flatMap((summary) => {
  const state = statementsState({
    facts: summary.facts,
    statements: summary.lines.map(([s]) => s),
    today: TODAY,
  });
  return summary.lines.map(([statement, side, note], target) => ({
    name: `${summary.name} s${target + 1}: ${slug(statement)}`,
    ...(note ? { note } : {}),
    state: { state, target },
    expect: { statement: side },
  }));
});

export const summaryStatementsSet: PlacementSet<StatementCase, Answers> = {
  id: "summary.statements",
  title: "summary.statements: is each statement of a summary in its facts?",
  where: "packages/core/src/judge/questions/summary-statements.ts",
  questions: [
    {
      key: "summary.statements/statement",
      title: "A statement the facts do not have, or that conflicts with them",
      question: STATEMENT_TEMPLATE,
      threshold: STATEMENT_THRESHOLD,
      label: STATEMENT_FAULT_LABELS.join(" + "),
      read: (answers: Answers) =>
        statementFault(answers.probabilities[answers.target] as Record<string, number>),
    },
  ],
  cases,
  async ask(judge: Judge, c: StatementCase) {
    const asked = await askStatements(judge, c.state);
    return asked.status === "answered"
      ? { probabilities: asked.probabilities, target: c.target }
      : null;
  },
};
