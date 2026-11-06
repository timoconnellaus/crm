// Placement `memory.write` (ADR 0342, stage 17 W3): before the assistant saves a memory line, is it
// about the person (or their team) rather than a customer, and is it already in memory? Asked
// once in `memory.propose` (and `teamMemory.propose` from the assistant), from the person's words
// this turn, the line and the lines already remembered. No record content is sent, so the
// placement is on by default, also on hosted deployments.
//
// What follows (code): a confident `customer` refuses the line for memory, and the assistant
// proposes a note on the record instead (a change set the person approves). A confident
// `already` saves nothing and says which line holds it. Otherwise the line is saved at once and
// shows "Saved to memory · undo". When the judge is off or cannot answer, the deterministic checks
// (no record ids, emails or customer names in the line; no duplicate text) decide what they can
// and every save is read back for the person to confirm (fails closed: nothing unseen is saved).
//
// Record notes are not sent: a line that repeats a record note is a fact about a customer, and the
// first question refuses it as one. Sending notes would make this a record-content placement,
// off by default and on hosted deployments (ADR 0342 amendment, 2026-11-06).
import { choice } from "../questions.ts";
import { failureOf, type Judge, type JudgeUnavailableReason } from "../types.ts";

export const MEMORY_WRITE_PLACEMENT = "memory.write" as const;

/** The person's words as sent (their message this turn). */
export const MEMORY_SAID_MAX_CHARS = 1_000;
/** Lines of memory sent for the duplicate check, newest first. */
export const MEMORY_LINES_MAX = 40;
export const MEMORY_LINE_MAX_CHARS = 300;

// ---------------------------------------------------------------------------------------------
// The questions. Changing a word here changes their hash: recalibrate (`pnpm eval:calibrate --only
// memory.write`) and commit the recordings and calibration.json in the same PR.

export const MEMORY_ABOUT_QUESTION = choice(
  "`line` is something a CRM assistant wants to remember for the person it works for, from what the person just said (`said`). The assistant's memory is only for the person and their team. Facts about customers belong on the customer's record. Who or what is `line` about?",
  {
    the_person:
      "The person or their team: how they like to work, their own preferences, habits, schedule, tools or writing style, what they mean by a word or phrase, or a rule for how the assistant should help them",
    customer:
      "Someone or something the person deals with: a contact, customer, company, deal or other record. A fact about them, such as their plans, role, situation, preferences or history, which belongs on that record",
    unclear: "`line` does not say enough to tell who it is about",
  },
);

export const MEMORY_ALREADY_QUESTION = choice(
  "`memory` lists what the assistant already remembers for the person. Does `memory` already hold what `line` says?",
  {
    new: "No line in `memory` says what `line` says",
    already: "A line in `memory` already says what `line` says, in the same or other words, or says more",
    changes:
      "A line in `memory` is about the same thing but says something different, which `line` would change",
  },
);

export type MemoryAboutLabel = keyof typeof MEMORY_ABOUT_QUESTION.criteria;
export type MemoryAlreadyLabel = keyof typeof MEMORY_ALREADY_QUESTION.criteria;

/**
 * P(customer) at or above this refuses the line for memory. Set from the labelled set
 * (evals/judge/sets/memory-write.ts, calibration.json). A false refusal costs the person a
 * proposed note they decline and a line they can save from the memory page; a missed one puts a
 * customer fact where visibility and erase do not reach it. Erring towards refusing, below the
 * middle of the gap.
 */
export const MEMORY_CUSTOMER_THRESHOLD = 0.5;

/**
 * P(already) at or above this saves nothing. A false "already" loses a line the person can say
 * again; a missed one is a duplicate line they can delete. Mild both ways: mid-gap.
 */
export const MEMORY_ALREADY_THRESHOLD = 0.5;

/** What the judge reads. */
export interface MemoryWriteState {
  said: string;
  line: string;
  /** What kind of line the assistant wants to save, in words. */
  kind: string;
  memory: string[];
}

const KIND_WORDS: Record<string, string> = {
  personal: "a preference or fact about the person",
  shortcut: "what the person means by a word or phrase",
  style: "how the person likes their writing",
  conditional: "something to remember on some records only",
  team: "how the person's team works",
};

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

export function memoryWriteState(input: {
  said: string;
  line: string;
  kind: string;
  memory: readonly string[];
}): MemoryWriteState {
  return {
    said: clip(input.said, MEMORY_SAID_MAX_CHARS),
    line: clip(input.line, MEMORY_LINE_MAX_CHARS),
    kind: KIND_WORDS[input.kind] ?? input.kind,
    memory: input.memory.slice(0, MEMORY_LINES_MAX).map((l) => clip(l, MEMORY_LINE_MAX_CHARS)),
  };
}

export type MemoryWriteAsked =
  | {
      status: "answered";
      about: Record<MemoryAboutLabel, number>;
      already: Record<MemoryAlreadyLabel, number>;
      /** P(customer) at or above its threshold. */
      customer: boolean;
      /** P(already) at or above its threshold. */
      duplicate: boolean;
      model: string;
      inputTokens: number;
    }
  | { status: "failed"; reason: JudgeUnavailableReason | "fault" };

/** Asks both questions about one line, in one call. Never throws. */
export async function askMemoryWrite(
  judge: Judge,
  state: MemoryWriteState,
  options: { signal?: AbortSignal } = {},
): Promise<MemoryWriteAsked> {
  const outcome = await judge.ask({
    placement: MEMORY_WRITE_PLACEMENT,
    state: state as unknown as Record<string, unknown>,
    questions: { about: MEMORY_ABOUT_QUESTION, already: MEMORY_ALREADY_QUESTION },
    signal: options.signal,
  });
  if (outcome.status !== "answered") return { status: "failed", reason: failureOf(outcome) };
  const about = outcome.answers.about.probabilities as Record<MemoryAboutLabel, number>;
  const already = outcome.answers.already.probabilities as Record<MemoryAlreadyLabel, number>;
  return {
    status: "answered",
    about,
    already,
    customer: (about.customer ?? 0) >= MEMORY_CUSTOMER_THRESHOLD,
    duplicate: (already.already ?? 0) >= MEMORY_ALREADY_THRESHOLD,
    model: outcome.model,
    inputTokens: outcome.inputTokens,
  };
}

/** The calibrated questions of this placement, by calibration key. */
export const MEMORY_WRITE_CALIBRATED: Record<
  string,
  {
    question: typeof MEMORY_ABOUT_QUESTION | typeof MEMORY_ALREADY_QUESTION;
    threshold: number;
  }
> = {
  [`${MEMORY_WRITE_PLACEMENT}/customer`]: {
    question: MEMORY_ABOUT_QUESTION,
    threshold: MEMORY_CUSTOMER_THRESHOLD,
  },
  [`${MEMORY_WRITE_PLACEMENT}/already`]: {
    question: MEMORY_ALREADY_QUESTION,
    threshold: MEMORY_ALREADY_THRESHOLD,
  },
};
