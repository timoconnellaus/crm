// The job protocol (ADR 0344): what an agent is while it runs, independent of the CRM. Pure: the
// budgets, what a slice of work leaves behind, and keeping a long job's messages inside the model's
// window. The host owns storage, tools, the alarm and what a job may do.
import type { ModelMessage } from "ai";
import type { StepUsage } from "./turn.ts";

/** A job's limits. The host charges them to whatever started it. */
export interface JobBudget {
  /** Model steps. */
  steps: number;
  /** Minutes of running, paused time not counted. */
  minutes: number;
  /** Spend in US dollars. Zero or less: no spend limit is known. */
  spendUsd: number;
}

/** What a job has used so far. */
export interface JobUsage {
  steps: number;
  runningMs: number;
  /** In millionths of a US dollar. */
  spentMicrousd: number;
}

export const EMPTY_JOB_USAGE: JobUsage = { steps: 0, runningMs: 0, spentMicrousd: 0 };

/** Prices per million tokens. */
export interface JobPricing {
  input: number;
  cachedInput: number;
  output: number;
}

/** What one model request cost, in millionths of a dollar. Unknown prices cost nothing here. */
export function stepCostMicrousd(step: StepUsage, pricing: JobPricing | null | undefined): number {
  if (!pricing) return 0;
  const prompt = step.promptTokens ?? 0;
  const cached = Math.min(step.cachedTokens ?? 0, prompt);
  // Prices are dollars per million tokens, so tokens times price is already millionths.
  const cost =
    (prompt - cached) * pricing.input +
    cached * pricing.cachedInput +
    (step.outputTokens ?? 0) * pricing.output;
  return Math.round(cost);
}

/** Why a job cannot take another step, or null when it can. */
export type JobLimit = "steps" | "time" | "spend";

/** The first budget a job has reached. */
export function reachedLimit(budget: JobBudget, usage: JobUsage): JobLimit | null {
  if (budget.spendUsd > 0 && usage.spentMicrousd >= budget.spendUsd * 1_000_000) return "spend";
  if (usage.steps >= budget.steps) return "steps";
  if (usage.runningMs >= budget.minutes * 60_000) return "time";
  return null;
}

/** Has the model finished: is its last message text with no tool calls waiting for results? */
export function finishedJob(messages: readonly ModelMessage[]): boolean {
  const last = messages.at(-1);
  if (last?.role !== "assistant") return false;
  if (typeof last.content === "string") return true;
  return !last.content.some((part) => part.type === "tool-call");
}

/** The words of a job's last message: what it reports back. */
export function jobResult(messages: readonly ModelMessage[]): string {
  const last = messages.findLast((m) => m.role === "assistant");
  if (!last) return "";
  if (typeof last.content === "string") return last.content.trim();
  return last.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
    .trim();
}

/** Tool results older than this many messages are shortened. */
const KEEP_RECENT = 24;
const SHORTENED = "(An older result, removed to save space. Read it again if you need it.)";

/**
 * A long job's history, kept inside the window: the brief and the newest messages stay whole, and
 * older tool results are replaced by a note. The tool calls stay, so the model knows what it did,
 * and each still has its result, so the request is valid. Pure and idempotent.
 */
export function trimJobMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  const cut = messages.length - KEEP_RECENT;
  return messages.map((message, index) => {
    if (index >= cut || message.role !== "tool") return message;
    return {
      ...message,
      content: message.content.map((part) =>
        part.type === "tool-result"
          ? { ...part, output: { type: "text" as const, value: SHORTENED } }
          : part,
      ),
    };
  });
}

/** The job's place in line, for "1st in line". */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  const suffix = { 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th";
  return `${n}${suffix}`;
}
