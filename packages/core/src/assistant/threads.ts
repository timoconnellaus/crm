// The assistant threads as operations see them (ADR 0340): each person's thread lives in their
// own AssistantAgent Durable Object, so `thread.*` operations and erase reach it through this
// port. ros-app implements it with the Durable Object namespace; inside the object, a local one.
import type { A2uiPart } from "@relationship-os/agent-a2ui";
import type { ThreadSearchHit } from "./events.ts";
import type { ConversationScrub } from "./scrub.ts";

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
  postCard(userId: string, part: A2uiPart): Promise<{ seq: number }>;
  /** Redacts an erased subject from the person's thread. Idempotent. */
  scrub(userId: string, scrub: ConversationScrub): Promise<void>;
}
