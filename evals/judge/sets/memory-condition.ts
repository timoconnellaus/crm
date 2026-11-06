// The labelled set for `memory.condition` (ADR 0342, ADR 0231), written before its first run. Each
// case is a conditional line as `memory.propose` would send it (the state built by the product's
// own `memoryConditionState`): the person's words, and the filter in words as `describeCondition`
// writes it. `above` means the filter picks out the records the person described.
//
// The cases cover: plain matches; a field that means the person's word; the classic slips (a
// different comparison, value, field or record type; part of the condition dropped or added; and
// against or), and words that give no condition at all.
import type { Judge } from "@relationship-os/core/judge";
import {
  MEMORY_CONDITION_PLACEMENT,
  MEMORY_CONDITION_QUESTION,
  MEMORY_CONDITION_THRESHOLD,
  type MemoryConditionLabel,
  type MemoryConditionState,
  memoryConditionState,
} from "@relationship-os/core/judge-memory-condition";
import type { LabelledCase, PlacementSet, Side } from "../lib/calibrate.ts";

interface Answers {
  probabilities: Record<MemoryConditionLabel, number>;
}

const MATCH = "above" as const;
const NO = "below" as const;

function c(
  name: string,
  said: string,
  condition: string,
  side: Side,
  line = "Start with the buying committee",
  note?: string,
): LabelledCase<MemoryConditionState> {
  return {
    name,
    ...(note ? { note } : {}),
    state: memoryConditionState({ said, condition, line }),
    expect: { as_said: side },
  };
}

const BIG =
  "When I'm on an organisation with more than 500 people, start with the buying committee.";

const cases: LabelledCase<MemoryConditionState>[] = [
  // --- Matches -----------------------------------------------------------------------------------
  c("match: the mockup's condition", BIG, "Organisations where People is more than 500", MATCH),
  c(
    "match: a field that means the word",
    "for companies with over 500 employees, start with the buying committee",
    "Organisations where Employees is more than 500",
    MATCH,
  ),
  c(
    "match: a number written out",
    "on organisations with more than a thousand people, ask who signs",
    "Organisations where People is more than 1,000",
    MATCH,
    "Ask who signs",
  ),
  c(
    "match: an industry",
    "when it's a healthcare company, mention compliance first",
    'Organisations where Industry is "Healthcare"',
    MATCH,
    "Mention compliance first",
  ),
  c(
    "match: a tag",
    "on anyone tagged VIP, keep it formal",
    'People where Tags is "VIP"',
    MATCH,
    "Keep it formal",
  ),
  c(
    "match: two conditions",
    "for healthcare companies with more than 100 people, loop in legal",
    'Organisations where Industry is "Healthcare" and People is more than 100',
    MATCH,
    "Loop in legal",
  ),
  c(
    "match: either of two",
    "for banks or insurers, check procurement rules",
    'Organisations where Industry is one of "Banking", "Insurance"',
    MATCH,
    "Check procurement rules",
  ),
  c(
    "match: at least",
    "at 500 people or more, start with the committee",
    "Organisations where People is at least 500",
    MATCH,
  ),
  c(
    "match: under",
    "for small companies under 50 people, go straight to the founder",
    "Organisations where People is less than 50",
    MATCH,
    "Go straight to the founder",
  ),
  c(
    "match: empty",
    "when a person has no job title, ask what they do",
    "People where Job title is empty",
    MATCH,
    "Ask what they do",
  ),
  c(
    "match: not",
    "for anyone not in Sales, skip the pricing talk",
    'People where Department is not "Sales"',
    MATCH,
    "Skip the pricing talk",
  ),
  c(
    "match: contains",
    "for any org with University in the name, mention the education rate",
    'Organisations where Name contains "University"',
    MATCH,
    "Mention the education rate",
  ),
  c(
    "match: domain",
    "when the company's domain ends in .gov.au, follow the public sector rules",
    'Organisations where Primary domain ends with ".gov.au"',
    MATCH,
    "Follow the public sector rules",
  ),

  // --- Does not match ----------------------------------------------------------------------------
  c("differs: another value", BIG, "Organisations where People is more than 50", NO),
  c("differs: the opposite comparison", BIG, "Organisations where People is less than 500", NO),
  c("differs: another record type", BIG, "People where People is more than 500", NO),
  c("differs: another field", BIG, 'Organisations where Name contains "500"', NO),
  c(
    "differs: a part left out",
    "for healthcare companies with more than 100 people, loop in legal",
    'Organisations where Industry is "Healthcare"',
    NO,
    "Loop in legal",
  ),
  c(
    "differs: a part added",
    "for healthcare companies, loop in legal",
    'Organisations where Industry is "Healthcare" and People is more than 100',
    NO,
    "Loop in legal",
  ),
  c(
    "differs: and for or",
    "for banks or insurers, check procurement rules",
    'Organisations where Industry is "Banking" and Industry is "Insurance"',
    NO,
    "Check procurement rules",
  ),
  c(
    "differs: or for and",
    "for healthcare companies with more than 100 people, loop in legal",
    'Organisations where Industry is "Healthcare" or People is more than 100',
    NO,
    "Loop in legal",
  ),
  c(
    "differs: another industry",
    "when it's a healthcare company, mention compliance first",
    'Organisations where Industry is "Finance"',
    NO,
    "Mention compliance first",
  ),
  c(
    "differs: is not for is",
    "for anyone not in Sales, skip the pricing talk",
    'People where Department is "Sales"',
    NO,
    "Skip the pricing talk",
  ),
  c(
    "differs: people for organisations",
    "on anyone tagged VIP, keep it formal",
    'Organisations where Tags is "VIP"',
    NO,
    "Keep it formal",
  ),

  // --- Says no condition -------------------------------------------------------------------------
  c(
    "unclear: no condition said",
    "remember this for later",
    "Organisations where People is more than 500",
    NO,
  ),
  c(
    "unclear: a vague size",
    "on the bigger ones, start with the committee",
    "Organisations where People is more than 500",
    NO,
    "Start with the committee",
    "'bigger' names no number",
  ),
  c(
    "unclear: only a pronoun",
    "do that for those",
    'Organisations where Industry is "Healthcare"',
    NO,
    "Do that",
  ),
];

export const memoryConditionSet: PlacementSet<MemoryConditionState, Answers> = {
  id: MEMORY_CONDITION_PLACEMENT,
  title: "memory.condition: does the filter pick out the records the person described?",
  where: "packages/core/src/judge/questions/memory-condition.ts",
  questions: [
    {
      key: `${MEMORY_CONDITION_PLACEMENT}/as_said`,
      title: "The filter is what the person said",
      question: MEMORY_CONDITION_QUESTION,
      threshold: MEMORY_CONDITION_THRESHOLD,
      label: "as_said",
      read: (answers: Answers) => answers.probabilities.as_said ?? 0,
    },
  ],
  cases,
  async ask(judge: Judge, state: MemoryConditionState) {
    const outcome = await judge.ask({
      placement: MEMORY_CONDITION_PLACEMENT,
      state: state as unknown as Record<string, unknown>,
      questions: { matches: MEMORY_CONDITION_QUESTION },
    });
    return outcome.status === "answered"
      ? {
          probabilities: outcome.answers.matches.probabilities as Record<
            MemoryConditionLabel,
            number
          >,
        }
      : null;
  },
};
