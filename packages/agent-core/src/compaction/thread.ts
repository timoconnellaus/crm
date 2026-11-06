// The thread side of compaction (ADR 0341): where a compaction cuts the thread, how the summary
// call is asked for, and turning each response's usage into cache observations and actual cost.
// Pure helpers; the host stores the state and makes the calls.
import type { ThreadMessage } from "../thread.ts";
import type { StepUsage } from "../turn.ts";
import type { CacheObservation } from "./cache-lifetime.ts";
import type { ModelPrices } from "./types.ts";

/** Exchanges (turns that start with the person's message) kept word for word after compaction. */
export const KEEP_EXCHANGES = 10;

/** The output budget of the "where we left off" note, in tokens (the planner's `s`). */
export const NOTE_TOKENS = 600;

/** What the summary call asks for. The fake model in tests recognises the first words. */
export const NOTE_REQUEST =
  "Write the where-we-left-off note for this conversation so far, for yourself to read later " +
  "instead of the messages above. Cover what the person is working on, what was decided, open " +
  "questions, and anything you said you would do, with the names and ids of the records " +
  "involved. Keep the still relevant points of any earlier note. Plain sentences, at most 200 " +
  "words, no headings. Do not call tools; answer with the note only.";

/**
 * The sequence number to compact up to: everything at or before it goes into the note, and the
 * newest `keep` exchanges stay as they are. Null when there is nothing older than them.
 * `messages` are the live (not deleted) messages since the last compaction, oldest first.
 */
export function compactionBoundary(
  messages: readonly ThreadMessage[],
  keep: number = KEEP_EXCHANGES,
): number | null {
  const turns: number[] = [];
  for (const m of messages) {
    if (m.role === "user" && m.turn !== turns.at(-1)) turns.push(m.turn);
  }
  if (turns.length <= keep) return null;
  const firstKept = turns[turns.length - Math.max(1, keep)] ?? 0;
  let boundary: number | null = null;
  for (const m of messages) {
    if (m.turn < firstKept) boundary = Math.max(boundary ?? 0, m.seq);
  }
  return boundary;
}

/** The last request made on a prefix: what the next request's cache observation compares with. */
export interface LastRequest {
  provider: string;
  modelId: string;
  prefixHash: string;
  /** When it was sent (epoch ms). */
  at: number;
  /** Its prompt tokens: the part the next request may find cached. */
  promptTokens: number | null;
}

/** An observation with the model it is about. */
export interface ModelObservation extends CacheObservation {
  provider: string;
  modelId: string;
}

/**
 * Cache observations from a turn's requests (ADR 0341): the gap since the previous request in
 * this thread, whether the prefix (system and tools) was unchanged, and how much was cached. The
 * reusable prefix is the previous request's prompt. Requests the provider gave no counts for, and
 * the very first request of a thread, give none.
 */
export function cacheObservations(
  steps: readonly StepUsage[],
  prefixHash: string,
  last: LastRequest | null,
): { observations: ModelObservation[]; last: LastRequest | null } {
  const observations: ModelObservation[] = [];
  let previous = last;
  for (const step of steps) {
    if (
      previous &&
      step.promptTokens !== null &&
      step.cachedTokens !== null &&
      step.startedAt >= previous.at
    ) {
      observations.push({
        provider: step.provider,
        modelId: step.modelId,
        at: step.startedAt,
        gapSeconds: (step.startedAt - previous.at) / 1000,
        prefixUnchanged:
          previous.prefixHash === prefixHash &&
          previous.provider === step.provider &&
          previous.modelId === step.modelId,
        cachedTokens: step.cachedTokens,
        promptTokens: step.promptTokens,
        prefixTokens: previous.promptTokens,
      });
    }
    previous = {
      provider: step.provider,
      modelId: step.modelId,
      prefixHash,
      at: step.startedAt,
      promptTokens: step.promptTokens,
    };
  }
  return { observations, last: previous };
}

/**
 * What a request cost, in the prices' currency: cached input at the cached price, the rest of the
 * input at the cache-write price (it is written to the cache), output at the output price. Null
 * when the prices or the counts are unknown.
 */
export function stepCost(step: StepUsage, prices: ModelPrices | null): number | null {
  if (!prices || prices.input === null || prices.output === null) return null;
  if (step.promptTokens === null || step.outputTokens === null) return null;
  const cached = Math.min(step.cachedTokens ?? 0, step.promptTokens);
  const write = prices.cacheWrite ?? prices.input;
  const read = prices.cachedInput ?? prices.input;
  return (
    (cached * read + (step.promptTokens - cached) * write + step.outputTokens * prices.output) / 1e6
  );
}

/** The sum of `stepCost` over a turn's requests; null when any is unknown. */
export function turnCost(steps: readonly StepUsage[], prices: ModelPrices | null): number | null {
  let total = 0;
  for (const step of steps) {
    const cost = stepCost(step, prices);
    if (cost === null) return null;
    total += cost;
  }
  return total;
}

/**
 * The context's size in tokens after a turn (the planner's `C`): the last request's prompt plus
 * its answer, which the next request sends back. Null when the provider gave no counts.
 */
export function contextTokensAfter(steps: readonly StepUsage[]): number | null {
  const last = steps.at(-1);
  if (!last || last.promptTokens === null) return null;
  return last.promptTokens + (last.outputTokens ?? 0);
}

/**
 * The context's size right after compacting (the planner's `C′`), scaled from the measured size:
 * the share of characters that stays (the prefix and the kept messages) of the measured
 * `contextTokens`, plus the note's budget.
 */
export function compactedTokens(input: {
  contextTokens: number;
  prefixChars: number;
  historyChars: number;
  keptChars: number;
  noteTokens?: number;
}): number {
  const total = input.prefixChars + input.historyChars;
  const share = total > 0 ? (input.prefixChars + input.keptChars) / total : 1;
  return Math.round(input.contextTokens * Math.min(1, share)) + (input.noteTokens ?? NOTE_TOKENS);
}

/** Characters of a message as the model is sent it (for `compactedTokens`). */
export function messageChars(message: ThreadMessage): number {
  return JSON.stringify(message.parts).length;
}
