// The front agent's hint (ADR 0344): the judge's `orchestrator.suggest` may add a line to the tail
// when a message looks like work across many records. The model still decides, with or without it.
// A cheap check in code keeps the judge out of ordinary messages: most turns ask it nothing.
import type { TailBlock } from "@relationship-os/agent-core";
import { askOrchestrator, orchestratorState } from "../judge/questions/orchestrator-suggest.ts";
import type { Judge } from "../judge/types.ts";

const MANY =
  /\b(all|every|each|research|clean\s?up|tidy|bulk|import|enrich|draft|list)\b|\b(\d{2,}|[5-9])\s+\w+/i;

/** Could this message be longer work? Worth one judge call only if so. */
export function mightBeLongWork(text: string, selected: number): boolean {
  return selected >= 5 || MANY.test(text);
}

/** The hint, or nothing. Advice only: no judge, no answer, or no match all mean no hint. */
export async function orchestratorHint(
  judge: Judge | undefined,
  text: string,
  selected = 0,
): Promise<TailBlock | null> {
  if (!judge || !mightBeLongWork(text, selected)) return null;
  const asked = await askOrchestrator(
    judge,
    orchestratorState({ said: text, ...(selected ? { selected } : {}) }),
  );
  if (asked.status !== "answered" || !asked.longWork) return null;
  return {
    kind: "display",
    text: "This message looks like longer work. If it is, start an agent with start_agent and tell the person it is running. It is your call.",
  };
}
