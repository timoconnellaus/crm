// Placement `authoring.intent` (docs/jev.md, placement 1): does an automation a model wrote do
// exactly what the person asked? One call per automation the version adds or changes, with one
// Choice per property, each with a way out (lessons 7 and 8).
//
// Evidence (`state`), all built by code:
// - `request`: the person's own words. The assistant's Durable Object passes them from the
//   person's turns; an MCP client may pass its own report of them (labelled as the client's
//   wherever it is shown). Never the model's summary of its work, its reason, or test values.
// - `automation`: the manifest's declarations (the artifact the runtime holds `run` to, ADR 0131)
//   as plain words, numbered by code: the trigger, each condition, and each step's writes (with
//   who they are assigned to and what they are linked to, stated even where they are defaults:
//   lesson 2), notifications (recipient and message), waits and branch conditions.
// - `hostSummary`: the host's summary of the same declarations, rendered by code (not a model).
//
// What follows: a fault at or above its threshold is a `warning` check issue (`intent/<question>`)
// whose message code writes from the manifest (lesson 16). The check still passes: the author may
// disagree and a person approves anyway. If the judge cannot answer, the check fails open with an
// `intent/unchecked` info issue. Off (no key, or switched off) adds nothing.
import type {
  AutomationManifest,
  ExtensionManifest,
  ViewFilter,
  WriteIntent,
} from "@relationship-os/sdk";
import {
  automationSummary,
  conditionWords,
  durationText,
  manifestSummaryContext,
  recipientWords,
  type SummaryContext,
  triggerWords,
} from "../../automations/summary.ts";
import { choice } from "../questions.ts";
import {
  type ChoiceQuestion,
  failureOf,
  type Judge,
  type JudgeFault,
  type JudgeUnavailable,
  type JudgeUnavailableReason,
} from "../types.ts";

export const INTENT_PLACEMENT = "authoring.intent" as const;

/** Longest request kept in `state` (the person's words; an essay is cut, not refused). */
export const REQUEST_MAX_CHARS = 4_000;
/** At most this many automations are checked per version (one call each). */
export const MAX_CHECKED_AUTOMATIONS = 10;

// ---------------------------------------------------------------------------------------------
// Questions. Changing a word here changes the question's hash: recalibrate (`pnpm eval:calibrate
// --only authoring.intent`) and commit the recordings and calibration.json in the same PR.

export const INTENT_QUESTIONS = {
  trigger: choice(
    "Compare when `automation` starts (`automation.trigger`) with when `request` asks for it to happen.",
    {
      as_asked:
        "`automation.trigger` is the event or schedule `request` asks for (a different wording of the same event counts)",
      different:
        "`automation.trigger` is a different event or schedule from the one `request` asks for",
      unclear: "`request` does not say when it should happen",
    },
  ),
  unrequested_condition: choice(
    "Does `automation` have a condition that narrows when it acts, or which records it acts on, that `request` never asked for? Look at `automation.conditions` and any step of kind `continues only if`. A condition that only restates what `request` asks for (a value threshold, a stage or an object `request` names) is not unrequested.",
    {
      none: "Every condition in `automation` is one `request` asks for, or `automation` has no conditions",
      unrequested:
        "A condition in `automation` limits when it acts, or which records it acts on, in a way `request` never asked for",
    },
  ),
  recipients: choice(
    "Compare who `automation` notifies (every step of kind `notifies`) with who `request` asks to be notified.",
    {
      as_asked:
        "`automation` notifies exactly the people `request` asks to be notified, or `request` asks for no notification and `automation` sends none",
      other_people:
        "`request` asks for a notification, and `automation` notifies someone other than the people `request` names (instead of them, or as well as them), or leaves out someone `request` names",
      not_asked: "`request` asks for no notification, but `automation` sends one",
    },
  ),
  unrequested_assignment: choice(
    "Compare who the records `automation` creates or changes are assigned to (`assignedTo` on each step of kind `creates` or `updates`) with what `request` says about who they are for.",
    {
      as_asked:
        "Every `assignedTo` is `nobody`, or is exactly the person `request` says the record is for",
      unrequested: "A record is assigned to someone although `request` never says who it is for",
      other_person:
        "`request` says who a record is for, and `automation` assigns it to someone else",
    },
  ),
  missing_element: choice(
    "Is everything `request` asks for present in `automation`? Check each record it asks to create and what it should be linked to (`linkedTo`), each recipient, each wait, each due date, each title and each separate step.",
    {
      complete: "Everything `request` asks for is in `automation`",
      missing:
        "Something `request` asks for is missing from `automation`: a link to a record, a recipient, a wait, a due date, a title, a record or a step",
    },
  ),
} as const;

export type IntentQuestionId = keyof typeof INTENT_QUESTIONS;
export const INTENT_QUESTION_IDS = Object.keys(INTENT_QUESTIONS) as IntentQuestionId[];

/** The label(s) that mean "this is a fault" for each question; P(fault) is their sum. */
export const INTENT_FAULT_LABELS: Record<IntentQuestionId, readonly string[]> = {
  trigger: ["different"],
  unrequested_condition: ["unrequested"],
  recipients: ["other_people", "not_asked"],
  unrequested_assignment: ["unrequested", "other_person"],
  missing_element: ["missing"],
};

/**
 * Thresholds on P(fault). Set from the labelled set (evals/judge/sets/authoring-intent.ts,
 * calibration.json). A false finding costs the author a look and maybe a needless "fix"; a missed
 * one is what an approver reads past today. Both are mild, so each threshold sits mid-gap.
 * Reasoning per question is in calibration.json's record and docs/jev.md.
 */
export const INTENT_THRESHOLDS: Record<IntentQuestionId, number> = {
  trigger: 0.5,
  unrequested_condition: 0.5,
  recipients: 0.5,
  unrequested_assignment: 0.5,
  missing_element: 0.5,
};

/** The issue code each question's finding is reported under. */
export const INTENT_CODES: Record<IntentQuestionId, string> = {
  trigger: "intent/trigger",
  unrequested_condition: "intent/unrequested-condition",
  recipients: "intent/recipients",
  unrequested_assignment: "intent/unrequested-assignment",
  missing_element: "intent/missing-element",
};
export const INTENT_UNCHECKED = "intent/unchecked";

// ---------------------------------------------------------------------------------------------
// State

export interface IntentStep {
  /** Where it is in the manifest: `steps[2]`, `steps[2].writes[0]`. */
  path: string;
  kind:
    | "creates"
    | "updates"
    | "deletes"
    | "notifies"
    | "waits"
    | "waits for"
    | "continues only if"
    | "runs";
  [key: string]: unknown;
}

export interface IntentState {
  request: string;
  automation: {
    trigger: string;
    conditions: string[];
    steps: IntentStep[];
  };
  hostSummary: string;
}

const triggerObjectOf = (spec: AutomationManifest): string | null =>
  "object" in spec.trigger && spec.trigger.type !== "approvalDecided"
    ? (spec.trigger.object ?? null)
    : null;

/** A top-level `and` split into its parts, by code (lesson 15). */
function splitConditions(filter: ViewFilter | undefined): ViewFilter[] {
  if (!filter) return [];
  return "and" in filter ? filter.and : [filter];
}

function writeStep(
  path: string,
  write: WriteIntent,
  trigger: string | null,
  ctx: SummaryContext,
): IntentStep {
  const action = write.action ?? "create";
  const object = ctx.objectLabel(write.object)?.label ?? write.object;
  const linked = write.linkedToTrigger ?? (write.object === "task" || write.object === "activity");
  const triggerLabel = trigger ? (ctx.objectLabel(trigger)?.label ?? trigger) : null;
  return {
    path,
    kind: action === "create" ? "creates" : action === "update" ? "updates" : "deletes",
    object,
    ...(write.count !== undefined ? { count: write.count } : {}),
    ...(write.titles?.length ? { titles: [...write.titles] } : {}),
    ...(action !== "delete"
      ? {
          assignedTo: write.assignTo ? recipientWords(write.assignTo, trigger, ctx) : "nobody",
        }
      : {}),
    ...(action === "create"
      ? {
          linkedTo:
            linked && triggerLabel && write.object !== trigger
              ? `the ${triggerLabel.toLowerCase()} that started it`
              : "nothing",
        }
      : {}),
  };
}

/** The `state` for one automation: the request, its declarations in words, the host summary. */
export function intentState(input: {
  request: string;
  automation: AutomationManifest;
  manifest: Pick<ExtensionManifest, "id" | "objects" | "fields"> | null;
  timezone?: string;
}): IntentState {
  const ctx = manifestSummaryContext(input.manifest, input.timezone ?? "UTC");
  const spec = input.automation;
  const trigger = triggerObjectOf(spec);
  const steps: IntentStep[] = [];
  spec.steps.forEach((step, i) => {
    const at = `steps[${i}]`;
    switch (step.kind) {
      case "sleep":
        steps.push({ path: at, kind: "waits", duration: durationText(step.duration) });
        return;
      case "waitForEvent":
        steps.push({
          path: at,
          kind: "waits for",
          event: step.event,
          atMost: durationText(step.timeout ?? "7 days"),
        });
        return;
      case "condition":
        steps.push({
          path: at,
          kind: "continues only if",
          condition: step.clause ?? step.label,
        });
        return;
      default: {
        const before = steps.length;
        (step.writes ?? []).forEach((write, j) => {
          steps.push(writeStep(`${at}.writes[${j}]`, write, trigger, ctx));
        });
        (step.notifies ?? []).forEach((notify, j) => {
          steps.push({
            path: `${at}.notifies[${j}]`,
            kind: "notifies",
            to: recipientWords(notify.to, trigger, ctx),
            message: notify.message,
          });
        });
        if (steps.length === before) {
          steps.push({
            path: at,
            kind: "runs",
            ...(step.reads?.length ? { reads: [...step.reads] } : {}),
          });
        }
      }
    }
  });
  return {
    request: input.request.trim().slice(0, REQUEST_MAX_CHARS),
    automation: {
      trigger: triggerWords(spec.trigger, ctx),
      conditions: trigger
        ? splitConditions(spec.conditions).map((c) => conditionWords(c, trigger, ctx))
        : [],
      steps,
    },
    hostSummary: automationSummary(spec, ctx).text,
  };
}

// ---------------------------------------------------------------------------------------------
// Asking and composing

export interface IntentVerdict {
  /** P(fault) per question, the number held to its threshold. */
  faults: Record<IntentQuestionId, number>;
  /** Raw distributions, for the log and the proposal row. */
  probabilities: Record<IntentQuestionId, Record<string, number>>;
  /** Questions at or above their threshold. */
  findings: IntentQuestionId[];
}

/** P(fault) from a choice's distribution. */
export function faultOf(question: IntentQuestionId, probabilities: Record<string, number>): number {
  const sum = INTENT_FAULT_LABELS[question].reduce((s, l) => s + (probabilities[l] ?? 0), 0);
  return Math.min(1, Math.max(0, sum));
}

export type IntentAsked =
  | { status: "answered"; verdict: IntentVerdict; model: string; inputTokens: number }
  | { status: "failed"; reason: JudgeUnavailableReason | "fault"; detail?: string | undefined };

/** Asks the five questions about one automation in one call. Never throws. */
export async function askIntent(
  judge: Judge,
  state: IntentState,
  options: { signal?: AbortSignal; placement?: "authoring.intent" | "eval.automations" } = {},
): Promise<IntentAsked> {
  const outcome = await judge.ask({
    placement: options.placement ?? INTENT_PLACEMENT,
    state: state as unknown as Record<string, unknown>,
    questions: INTENT_QUESTIONS,
    signal: options.signal,
  });
  if (outcome.status !== "answered") {
    const failed = outcome as JudgeUnavailable | JudgeFault;
    return { status: "failed", reason: failureOf(failed), detail: failed.detail };
  }
  const faults = {} as Record<IntentQuestionId, number>;
  const probabilities = {} as Record<IntentQuestionId, Record<string, number>>;
  const findings: IntentQuestionId[] = [];
  for (const id of INTENT_QUESTION_IDS) {
    const answer = outcome.answers[id];
    const dist = answer.probabilities as Record<string, number>;
    probabilities[id] = dist;
    faults[id] = faultOf(id, dist);
    if (faults[id] >= INTENT_THRESHOLDS[id]) findings.push(id);
  }
  return {
    status: "answered",
    verdict: { faults, probabilities, findings },
    model: outcome.model,
    inputTokens: outcome.inputTokens,
  };
}

/** Where the request came from: the person's own words, or an MCP client's report of them. */
export type RequestSource = "person" | "client";

/** What is stored on the proposal (`core_extension_proposals.intent_check`) and shown to approvers. */
export interface IntentCheck {
  status: "checked" | "unchecked";
  requestSource: RequestSource;
  /** The request as checked (the person's words, capped). */
  request: string;
  /** `unchecked`: why the judge could not answer. */
  reason?: JudgeUnavailableReason | "fault" | undefined;
  automations: {
    id: string;
    /** Per finding, a sentence code wrote from the manifest. */
    findings: { question: IntentQuestionId; code: string; message: string }[];
    faults: Record<IntentQuestionId, number> | null;
  }[];
  model?: string | undefined;
  checkedAt: string;
}

/** A check issue as extension.check and extension.propose report it. */
export interface IntentIssue {
  stage: "intent";
  severity: "warning" | "info";
  code: string;
  path: string;
  message: string;
  suggestion?: string;
}

/** The sentence for one finding, written by code from the manifest (lesson 16). */
export function findingMessage(question: IntentQuestionId, state: IntentState): string {
  const { automation } = state;
  const list = (items: string[]) => items.join("; ");
  switch (question) {
    case "trigger":
      return `It starts ${automation.trigger.replace(/^When/, "when")}, which may not be the event the request asks for.`;
    case "unrequested_condition": {
      const branch = automation.steps
        .filter((s) => s.kind === "continues only if")
        .map((s) => String(s.condition));
      const all = [...automation.conditions, ...branch];
      return all.length
        ? `A condition the request did not ask for: ${list(all)}.`
        : "A condition the request did not ask for.";
    }
    case "recipients": {
      const to = automation.steps.filter((s) => s.kind === "notifies").map((s) => String(s.to));
      return to.length
        ? `It notifies ${list([...new Set(to)])}, which may not be who the request asks to notify.`
        : "It notifies no one, though the request may ask for a notification.";
    }
    case "unrequested_assignment": {
      const to = automation.steps
        .filter((s) => (s.kind === "creates" || s.kind === "updates") && s.assignedTo !== "nobody")
        .map((s) => `${String(s.object).toLowerCase()} for ${String(s.assignedTo)}`);
      return to.length
        ? `An assignment the request did not ask for: ${list(to)}.`
        : "An assignment the request did not ask for.";
    }
    case "missing_element": {
      const unlinked = automation.steps
        .filter((s) => s.kind === "creates" && s.linkedTo === "nothing")
        .map((s) => String(s.object).toLowerCase());
      return unlinked.length
        ? `Something the request asks for is missing (the ${list(unlinked)} it creates is linked to nothing).`
        : "Something the request asks for is missing (a link, a recipient, a wait, a due date or a step).";
    }
  }
}

const UNCHECKED_WORDS: Record<JudgeUnavailableReason | "fault", string> = {
  off: "the judge is off",
  "no-key": "the judge has no key",
  unreachable: "the judge could not be reached",
  timeout: "the judge did not answer in time",
  "rate-limited": "the judge was rate-limited",
  "no-credit": "the judge's account has no credit",
  "key-refused": "the judge's key was refused",
  "server-error": "the judge had a server error",
  "incomplete-answer": "the judge's answer was incomplete",
  fault: "the request to the judge was malformed",
};

export function uncheckedMessage(reason: JudgeUnavailableReason | "fault"): string {
  return `Not checked against the request: ${UNCHECKED_WORDS[reason]}.`;
}

/**
 * Automations a version adds or changes, against the installed manifest (all of them when none is
 * installed). Unchanged automations are not asked about again.
 */
export function changedAutomations(
  manifest: Pick<ExtensionManifest, "automations">,
  previous: Pick<ExtensionManifest, "automations"> | null,
): string[] {
  const before = previous?.automations ?? {};
  return Object.entries(manifest.automations ?? {})
    .filter(([name, spec]) => JSON.stringify(before[name]) !== JSON.stringify(spec))
    .map(([name]) => name)
    .slice(0, MAX_CHECKED_AUTOMATIONS);
}

/**
 * The intent check of one extension version: one call per added or changed automation. Returns
 * null when there is nothing to check (no request, no automation changed, or the judge is off),
 * so nothing is stored or shown.
 */
export async function checkIntent(input: {
  judge: Judge | undefined;
  request: string | undefined;
  requestSource: RequestSource;
  manifest: ExtensionManifest;
  previous: ExtensionManifest | null;
  now: string;
  timezone?: string;
}): Promise<IntentCheck | null> {
  const request = input.request?.trim();
  if (!input.judge || !request) return null;
  const names = changedAutomations(input.manifest, input.previous);
  if (!names.length) return null;
  const automations: IntentCheck["automations"] = [];
  let model: string | undefined;
  for (const name of names) {
    const spec = input.manifest.automations[name] as AutomationManifest;
    const state = intentState({
      request,
      automation: spec,
      manifest: input.manifest,
      ...(input.timezone ? { timezone: input.timezone } : {}),
    });
    const asked = await askIntent(input.judge, state);
    if (asked.status === "failed") {
      // Off is not a failure: nothing is stored and nothing is shown.
      if (asked.reason === "off") return null;
      return {
        status: "unchecked",
        requestSource: input.requestSource,
        request: state.request,
        reason: asked.reason,
        automations: [],
        checkedAt: input.now,
      };
    }
    model = asked.model;
    automations.push({
      id: `${input.manifest.id}.${name}`,
      findings: asked.verdict.findings.map((question) => ({
        question,
        code: INTENT_CODES[question],
        message: findingMessage(question, state),
      })),
      faults: asked.verdict.faults,
    });
  }
  return {
    status: "checked",
    requestSource: input.requestSource,
    request,
    automations,
    ...(model ? { model } : {}),
    checkedAt: input.now,
  };
}

/** The check issues an intent check adds: warnings for findings, info when it could not run. */
export function intentIssues(check: IntentCheck | null): IntentIssue[] {
  if (!check) return [];
  if (check.status === "unchecked") {
    return [
      {
        stage: "intent",
        severity: "info",
        code: INTENT_UNCHECKED,
        path: "automations",
        message: uncheckedMessage(check.reason ?? "server-error"),
      },
    ];
  }
  return check.automations.flatMap((a) =>
    a.findings.map((f) => ({
      stage: "intent" as const,
      severity: "warning" as const,
      code: f.code,
      path: `automations.${a.id.split(".").slice(1).join(".")}`,
      message: f.message,
      suggestion:
        "Check this against what the person asked for. Change the automation only if they did " +
        "not ask for it; the check still passes, and an approver sees this note.",
    })),
  );
}

/** The calibrated questions of this placement, by calibration key. */
export const CALIBRATED_QUESTIONS: Record<string, ChoiceQuestion> = Object.fromEntries(
  INTENT_QUESTION_IDS.map((id) => [`${INTENT_PLACEMENT}/${id}`, INTENT_QUESTIONS[id]]),
);
