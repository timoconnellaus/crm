// A deterministic stand-in judge for local dev and e2e only (AI_FAKE_MODEL=true, no `ai` binding
// and no Jev key), as fakeModels stands in for the model roles. It answers `authoring.intent` from
// plain keyword rules so the approval screen's intent check can be seen and tested without
// TypeSafe, `memory.write` and `memory.condition` the same way so saving to memory can be, and
// `approval.intent`, `grant.leastPrivilege` and `orchestrator.suggest` so typed approvals and
// agents can be. It is off for every other placement. Never used where a real key or AI exists.
import { choiceAnswer } from "./fake.ts";
import {
  APPROVAL_INTENT_PLACEMENT,
  type ApprovalIntentState,
  type ApprovalPhraseState,
} from "./questions/approval-intent.ts";
import type { IntentState } from "./questions/authoring-intent.ts";
import { GRANT_PLACEMENT, type GrantState } from "./questions/grant-least-privilege.ts";
import { MEMORY_CONDITION_PLACEMENT } from "./questions/memory-condition.ts";
import { MEMORY_WRITE_PLACEMENT, type MemoryWriteState } from "./questions/memory-write.ts";
import {
  ORCHESTRATOR_PLACEMENT,
  type OrchestratorState,
} from "./questions/orchestrator-suggest.ts";
import { ROUTINE_GATE_PLACEMENT, type RoutineGateState } from "./questions/routine-gate.ts";
import type { Judge, JudgeOutcome, JudgeRequest, Questions } from "./types.ts";

const NOTIFY = /\b(notif\w*|tell|alert|remind\w*|message)\b/i;
const NARROWS = /\b(if|only|over|under|more than|less than|worth|above|below|at least)\b/i;

function intentAnswers(state: IntentState): Record<string, unknown> {
  const request = state.request.toLowerCase();
  const steps = state.automation.steps;
  const conditions = [
    ...state.automation.conditions,
    ...steps.filter((s) => s.kind === "continues only if").map((s) => String(s.condition)),
  ];
  const recipients = steps.filter((s) => s.kind === "notifies").map((s) => String(s.to));
  const named = (to: string) =>
    (/admin/.test(to) && /admin/.test(request)) ||
    (/manager/.test(to) && /manager/.test(request)) ||
    (/owner/.test(to) && !/manager/.test(to) && /owner/.test(request)) ||
    (/person who started/.test(to) && /\b(me|i)\b/.test(request));
  const recipient = !recipients.length
    ? NOTIFY.test(request)
      ? "other_people"
      : "as_asked"
    : !NOTIFY.test(request)
      ? "not_asked"
      : recipients.every(named)
        ? "as_asked"
        : "other_people";
  const assigned = steps.filter(
    (s) => (s.kind === "creates" || s.kind === "updates") && s.assignedTo !== "nobody",
  );
  const assignment = assigned.length && !/\bfor (the |its |their |his |her )?\w+/.test(request);
  const unlinked = steps.some((s) => s.kind === "creates" && s.linkedTo === "nothing");
  return {
    trigger: choiceAnswer(["as_asked", "different", "unclear"], "as_asked"),
    unrequested_condition: choiceAnswer(
      ["none", "unrequested"],
      conditions.length && !NARROWS.test(request) ? "unrequested" : "none",
    ),
    recipients: choiceAnswer(["as_asked", "other_people", "not_asked"], recipient),
    unrequested_assignment: choiceAnswer(
      ["as_asked", "unrequested", "other_person"],
      assignment ? "unrequested" : "as_asked",
    ),
    missing_element: choiceAnswer(
      ["complete", "missing"],
      unlinked && /linked to/.test(request) ? "missing" : "complete",
    ),
  };
}

/** The dev / e2e stand-in judge. */
/** "Ade is leaving": a name and then what they are doing. Anything else is about the person. */
const ABOUT_SOMEONE = /^(?!I\b)\p{Lu}\p{L}+ (is|are|has|was|will|wants|prefers)\b/u;

function memoryWriteAnswers(state: MemoryWriteState): Record<string, unknown> {
  const already = state.memory.some((l) => l.toLowerCase() === state.line.toLowerCase());
  return {
    about: choiceAnswer(
      ["the_person", "customer", "unclear"],
      ABOUT_SOMEONE.test(state.line.trim()) ? "customer" : "the_person",
    ),
    already: choiceAnswer(["new", "already", "changes"], already ? "already" : "new"),
    source: choiceAnswer(["said", "not_said"], "said"),
  };
}

const DECLINES = /\b(no|nope|don'?t|stop|cancel)\b/i;
const HEDGES = /\b(maybe|later|after lunch|not sure|perhaps)\b|\?/i;
const YES = /\b(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|approved?|send it)\b/i;
/** Words that say nothing about which item is meant. */
const NOT_NAMING = new Set(
  "a an and the to of for on in at my our it do go send yes ok approve this that".split(" "),
);

const wordsOf = (text: string) =>
  (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1);

function approvalIntentAnswer(state: ApprovalIntentState) {
  const said = new Set(wordsOf(state.said));
  const named = wordsOf(state.item).some((w) => !NOT_NAMING.has(w) && said.has(w));
  const label = DECLINES.test(state.said)
    ? "declines"
    : HEDGES.test(state.said)
      ? "hedged"
      : !YES.test(state.said) && !named
        ? "unrelated"
        : state.others.length && !named
          ? "ambiguous"
          : "approves_this";
  return choiceAnswer(["approves_this", "ambiguous", "hedged", "declines", "unrelated"], label);
}

/** Lower case, no punctuation, and "q 3" or "quarter 3" as "q3". */
const normalPhrase = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\b(?:q|quarter)\s*(\d)\b/g, "q$1")
    .replace(/\s+/g, " ")
    .trim();

function approvalPhraseAnswer(state: ApprovalPhraseState) {
  const said = normalPhrase(state.said);
  return choiceAnswer(
    ["same_phrase", "different", "not_a_phrase"],
    !said ? "not_a_phrase" : said === normalPhrase(state.phrase) ? "same_phrase" : "different",
  );
}

const WIDE_OPERATION = /^person\.erase$|mail|\.delete$/i;

function grantAnswer(state: GrantState) {
  const wideOperation =
    state.operations.some((o) => WIDE_OPERATION.test(o.name)) &&
    !/\b(delete|e-?mail)/i.test(state.brief);
  return choiceAnswer(
    ["fits", "too_wide", "unclear"],
    wideOperation || /\bevery\b/i.test(state.target) ? "too_wide" : "fits",
  );
}

const LONG_WORDS = /\b(research|every|all of)\b/i;
const COUNTED = /\b(\d+)\s+(?:\w+\s+)?(?:accounts?|records?|people|organi[sz]ations?)\b/gi;

function orchestratorAnswer(state: OrchestratorState) {
  const counted = [...state.said.matchAll(COUNTED)].some((m) => Number(m[1]) >= 5);
  return choiceAnswer(
    ["single_lookup", "short_work", "long_work", "unclear"],
    counted || LONG_WORDS.test(state.said) ? "long_work" : "single_lookup",
  );
}

function devAnswers(placement: string, state: unknown): Record<string, unknown> | null {
  if (placement === "authoring.intent") return intentAnswers(state as IntentState);
  if (placement === MEMORY_WRITE_PLACEMENT) return memoryWriteAnswers(state as MemoryWriteState);
  if (placement === MEMORY_CONDITION_PLACEMENT) {
    return { matches: choiceAnswer(["as_said", "different", "unclear"], "as_said") };
  }
  if (placement === APPROVAL_INTENT_PLACEMENT) {
    return "phrase" in (state as object)
      ? { phrase: approvalPhraseAnswer(state as ApprovalPhraseState) }
      : { intent: approvalIntentAnswer(state as ApprovalIntentState) };
  }
  if (placement === GRANT_PLACEMENT) return { grant: grantAnswer(state as GrantState) };
  if (placement === ORCHESTRATOR_PLACEMENT) {
    return { size: orchestratorAnswer(state as OrchestratorState) };
  }
  if (placement === ROUTINE_GATE_PLACEMENT) {
    const { event } = state as RoutineGateState;
    return {
      check: choiceAnswer(
        ["meets", "does_not", "unclear"],
        /keen|excited|happy|interested/i.test(event) ? "meets" : "does_not",
      ),
    };
  }
  return null;
}

export const devJudge: Judge = {
  provider: "dev",
  async ask<const Q extends Questions>(request: JudgeRequest<Q>): Promise<JudgeOutcome<Q>> {
    const answers = devAnswers(request.placement, request.state);
    if (!answers) return { status: "unavailable", reason: "off" };
    return {
      status: "answered",
      model: "dev-stand-in",
      answers: answers as never,
      inputTokens: 0,
      latencyMs: 0,
      source: "fake",
    };
  },
};
