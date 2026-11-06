// Pending-line slots (ADR 0341, ADR 0342): memory lines saved since the last compaction. They are
// already in the memory store, so agents read them at once, but the memory block in the prefix is
// only rewritten at compaction (rewriting it each time would break the prompt cache). Until then
// they ride at the end of the context, in the tail. Compaction folds them into the memory block.
import type { TailBlock } from "./context.ts";

export interface PendingLine {
  id: string;
  text: string;
  /** The message the line came from: deleting that message deletes the line. */
  sourceMessageSeq?: number | undefined;
  addedAt: string;
}

/** Adds a line (replacing one with the same id). */
export function addPending(lines: readonly PendingLine[], line: PendingLine): PendingLine[] {
  return [...lines.filter((l) => l.id !== line.id), line];
}

/** Removes a line (undo, or the person deleted it). */
export function removePending(lines: readonly PendingLine[], id: string): PendingLine[] {
  return lines.filter((l) => l.id !== id);
}

/** Lines that came from a message, and the rest: deleting the message deletes the first group. */
export function pendingFromMessage(
  lines: readonly PendingLine[],
  seq: number,
): { from: PendingLine[]; rest: PendingLine[] } {
  return {
    from: lines.filter((l) => l.sourceMessageSeq === seq),
    rest: lines.filter((l) => l.sourceMessageSeq !== seq),
  };
}

/** Compaction: every line goes into the memory block and the slots empty. */
export function foldPending(lines: readonly PendingLine[]): {
  folded: PendingLine[];
  remaining: PendingLine[];
} {
  return { folded: [...lines], remaining: [] };
}

/** The tail block for the pending lines (none when there are none). */
export function pendingTailBlock(lines: readonly PendingLine[]): TailBlock | null {
  if (!lines.length) return null;
  const sorted = [...lines].sort((a, b) =>
    a.addedAt === b.addedAt ? a.id.localeCompare(b.id) : a.addedAt < b.addedAt ? -1 : 1,
  );
  return {
    kind: "pending",
    text: `Also remember (saved since the memory above):\n${sorted.map((l) => `- ${l.text.replace(/\s+/g, " ").trim()}`).join("\n")}`,
  };
}
