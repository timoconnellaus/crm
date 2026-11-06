// A deterministic stand-in judge for local dev and e2e only (AI_FAKE_MODEL=true, no `ai` binding
// and no Jev key), as fakeModels stands in for the model roles. It answers `authoring.intent` from
// plain keyword rules so the approval screen's intent check can be seen and tested without
// TypeSafe, and `memory.write` and `memory.condition` the same way so saving to memory can be, and
// is off for every other placement. Never used where a real key or AI exists.
import { choiceAnswer } from "./fake.ts";
import type { IntentState } from "./questions/authoring-intent.ts";
import { MEMORY_CONDITION_PLACEMENT } from "./questions/memory-condition.ts";
import { MEMORY_WRITE_PLACEMENT, type MemoryWriteState } from "./questions/memory-write.ts";
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

function devAnswers(placement: string, state: unknown): Record<string, unknown> | null {
  if (placement === "authoring.intent") return intentAnswers(state as IntentState);
  if (placement === MEMORY_WRITE_PLACEMENT) return memoryWriteAnswers(state as MemoryWriteState);
  if (placement === MEMORY_CONDITION_PLACEMENT) {
    return { matches: choiceAnswer(["as_said", "different", "unclear"], "as_said") };
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
