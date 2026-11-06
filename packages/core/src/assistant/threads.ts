// The assistant threads as operations see them (ADR 0340): each person's thread lives in their
// own AssistantAgent Durable Object, so `thread.*` operations and erase reach it through this
// port. ros-app implements it with the Durable Object namespace; inside the object, a local one.
import type { A2uiPart } from "@relationship-os/agent-a2ui";
import type { RoutineCheckView, ThreadSearchHit } from "./events.ts";
import type { ConversationScrub } from "./scrub.ts";

/** One message a routine is sending. */
export interface RoutineDelivery {
  routineId: string;
  /** The run, or null for Test on My routines. */
  runId: string | null;
  test?: boolean;
  /** The checks it passed, when there is no run to read them from. */
  checks?: readonly (RoutineCheckView & { kind: "plain" | "jev" })[];
  /** The record it is about, when there is no run to read it from. */
  record?: { object: string; id: string };
}

export type RoutineDelivered =
  | { outcome: "delivered"; seq: number }
  /** Nothing to send: a saved card came back empty and it stays quiet. */
  | { outcome: "quiet" }
  | { outcome: "failed"; error: string };

export interface AssistantThreadStore {
  /** Messages in the person's thread whose words match `query`, newest first. */
  search(userId: string, query: string, limit: number): Promise<ThreadSearchHit[]>;
  /**
   * Deletes a message from the person's thread and its search index: a message of theirs, or a
   * whole reply (its text, tool calls and results). Returns the seqs removed.
   */
  deleteMessage(userId: string, seq: number): Promise<{ deleted: number[] }>;
  /** The person has seen the thread up to `seq` (the newest message when absent). */
  markSeen(userId: string, seq?: number): Promise<{ unread: number; lastSeenSeq: number }>;
  /**
   * Posts a card in the person's thread without a turn (a saved producer run by a routine or a
   * button in the app). It waits for a running turn to finish first. Returns where it landed.
   */
  postCard(userId: string, part: A2uiPart, via?: "routine" | "agent"): Promise<{ seq: number }>;
  /**
   * Delivers a routine's message into the person's thread (ADR 0343). Idempotent per run: a
   * redelivered run posts once. It waits for a running turn, like `postCard`.
   */
  deliverRoutine(userId: string, delivery: RoutineDelivery): Promise<RoutineDelivered>;
  /** Redacts an erased subject from the person's thread. Idempotent. */
  scrub(userId: string, scrub: ConversationScrub): Promise<void>;
}
