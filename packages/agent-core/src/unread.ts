// The unread state (ADR 0340, stage 17 W4): how many replies and deliveries the person has not
// seen. The thread remembers the last seq the person saw; everything the assistant wrote after it
// is unread. A reply counts once however many messages (tool steps) it took. Sending a message
// means the person has seen everything before it.
import { messageText, type ThreadMessage } from "./thread.ts";

export interface UnreadState {
  /** The newest seq the person has seen. */
  lastSeenSeq: number;
}

/** Replies the person has not seen: turns with assistant words or notices after `lastSeenSeq`. */
export function unreadCount(messages: readonly ThreadMessage[], lastSeenSeq: number): number {
  const turns = new Set<number>();
  for (const m of messages) {
    if (m.seq <= lastSeenSeq || m.deletedAt) continue;
    if (m.role !== "assistant" && m.role !== "notice") continue;
    if (m.role === "assistant" && !messageText(m)) continue;
    turns.add(m.turn);
  }
  return turns.size;
}

/** The state after the person has seen up to `seq` (never moves back). */
export function markSeen(state: UnreadState, seq: number): UnreadState {
  return { lastSeenSeq: Math.max(state.lastSeenSeq, seq) };
}
