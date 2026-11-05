// Post-commit events (ADR 0130). After an operation's batch commits, the pipeline turns its record
// changes into queue messages: one EventSink.send per operation, the changes chunked (at most
// EVENT_CHANGES_PER_MESSAGE per message and QUEUE_MESSAGE_MAX_BYTES per message), message ids
// `<auditId>:<chunk>` so a redelivery is recognisable, and every message tagged with its origin
// (cascade depth, chain, bulk). Reads, refusals, failures and test-mode calls emit nothing.
import type { RecordEventType } from "@relationship-os/sdk";
import { capValue } from "../approvals/caps.ts";
import { diffRecords, type FieldDiff } from "../diff.ts";
import type { RecordChange } from "../operation.ts";
import type { Actor, Origin } from "../principals.ts";
import {
  type ApprovalDecidedMessage,
  type AutomationQueueMessage,
  EVENT_CHANGES_PER_MESSAGE,
  type EventOrigin,
  type EventSink,
  QUEUE_BATCH_MESSAGES,
  QUEUE_MESSAGE_MAX_BYTES,
  type RecordEventChange,
  type RecordEventMessage,
} from "./types.ts";

/** Total bytes of one sendBatch call (the Queues limit is 256 KB). */
export const QUEUE_BATCH_MAX_BYTES = 250_000;

const ACTIONS: Partial<Record<RecordChange["action"], RecordEventType>> = {
  create: "created",
  update: "updated",
  delete: "deleted",
  restore: "restored",
  // A merge keeps the winner (updated); the loser's delete is recorded as its own change.
  merge: "updated",
  // erase: the record is gone for good; nothing can run against it.
};

/** The record event of one change, or null when it emits none. Diff values are capped. */
export function recordEventChange(change: RecordChange): RecordEventChange | null {
  let action = ACTIONS[change.action];
  if (!action) return null;
  if (action === "updated") {
    const diff = change.diff ?? diffRecords(change.before, change.after);
    // A soft delete recorded as an update of deletedAt is a delete.
    const deletedAt = diff.deletedAt;
    if (deletedAt?.after) action = "deleted";
    else if (deletedAt?.before && !deletedAt.after) action = "restored";
    const capped: FieldDiff = {};
    for (const [field, values] of Object.entries(diff)) {
      capped[field] = { before: capValue(values.before), after: capValue(values.after) };
    }
    return { object: change.object, id: change.id, action, diff: capped };
  }
  return { object: change.object, id: change.id, action };
}

/** Is this operation a bulk one (imports, *Many, backfills): its events skip most automations. */
export function isBulkOperation(name: string, bulkSize: number): boolean {
  return bulkSize > 1 || name.endsWith("Many") || name.startsWith("import.");
}

export function eventOriginOf(input: {
  actor: Actor;
  userId: string;
  origin: Origin;
  operation: string;
  auditId: string;
  bulk: boolean;
}): EventOrigin {
  const o = input.origin;
  return {
    actor: input.actor,
    userId: input.userId,
    surface: o.surface,
    operation: input.operation,
    rootEventId: o.rootEventId ?? input.auditId,
    depth: o.depth ?? 0,
    chain: o.chain ?? [],
    ...(o.automationId ? { automationId: o.automationId } : {}),
    ...(o.runId ? { runId: o.runId } : {}),
    ...(o.sessionId ? { sessionId: o.sessionId } : {}),
    bulk: input.bulk,
  };
}

/**
 * One operation's changes as record messages: at most EVENT_CHANGES_PER_MESSAGE changes and
 * QUEUE_MESSAGE_MAX_BYTES per message, in order.
 */
export function recordEventMessages(
  auditId: string,
  at: string,
  origin: EventOrigin,
  changes: readonly RecordChange[],
): RecordEventMessage[] {
  const events = changes.map(recordEventChange).filter((c): c is RecordEventChange => c !== null);
  const messages: RecordEventMessage[] = [];
  const base = JSON.stringify({ v: 1, kind: "record", id: `${auditId}:000`, at, origin }).length;
  let chunk: RecordEventChange[] = [];
  let bytes = base;
  const flush = () => {
    if (!chunk.length) return;
    messages.push({
      v: 1,
      kind: "record",
      id: `${auditId}:${messages.length}`,
      at,
      origin,
      changes: chunk,
    });
    chunk = [];
    bytes = base;
  };
  for (const event of events) {
    const size = JSON.stringify(event).length + 1;
    if (
      chunk.length >= EVENT_CHANGES_PER_MESSAGE ||
      (chunk.length && bytes + size > QUEUE_MESSAGE_MAX_BYTES)
    ) {
      flush();
    }
    // A single change larger than a message keeps only what matters for matching: the fields.
    chunk.push(
      size > QUEUE_MESSAGE_MAX_BYTES
        ? {
            ...event,
            diff: Object.fromEntries(
              Object.keys(event.diff ?? {}).map((f) => [f, { before: null, after: null }]),
            ),
          }
        : event,
    );
    bytes += Math.min(size, QUEUE_MESSAGE_MAX_BYTES);
  }
  flush();
  return messages;
}

/** Approval decision messages, one per decided action. */
export function approvalDecidedMessages(
  at: string,
  origin: EventOrigin,
  decisions: readonly {
    actionId: string;
    changeSetId: string;
    operation: string;
    decision: ApprovalDecidedMessage["decision"];
    decidedBy: string | null;
    records: { object: string; id: string }[];
    actionOrigin: Origin;
  }[],
): ApprovalDecidedMessage[] {
  return decisions.map((d) => ({
    v: 1,
    kind: "approval",
    id: `${d.actionId}:${d.decision}`,
    at,
    actionId: d.actionId,
    changeSetId: d.changeSetId,
    operation: d.operation,
    decision: d.decision,
    decidedBy: d.decidedBy,
    records: d.records.slice(0, 100),
    actionOrigin: d.actionOrigin,
    origin,
  }));
}

/** The producer side of a Queue, as far as the sink needs it. */
export interface QueueProducer {
  sendBatch(
    messages: Iterable<{ body: unknown; contentType?: "json"; delaySeconds?: number }>,
    options?: { delaySeconds?: number },
  ): Promise<unknown>;
}

/**
 * An EventSink over a Queue producer: sendBatch calls of at most QUEUE_BATCH_MESSAGES messages
 * and QUEUE_BATCH_MAX_BYTES each.
 */
export function queueEventSink(queue: QueueProducer): EventSink {
  return {
    async send(messages, options = {}) {
      let batch: AutomationQueueMessage[] = [];
      let bytes = 0;
      const flush = async () => {
        if (!batch.length) return;
        await queue.sendBatch(
          batch.map((body) => ({ body, contentType: "json" as const })),
          options.delaySeconds ? { delaySeconds: options.delaySeconds } : {},
        );
        batch = [];
        bytes = 0;
      };
      for (const message of messages) {
        const size = JSON.stringify(message).length;
        if (
          batch.length >= QUEUE_BATCH_MESSAGES ||
          (batch.length && bytes + size > QUEUE_BATCH_MAX_BYTES)
        ) {
          await flush();
        }
        batch.push(message);
        bytes += size;
      }
      await flush();
    },
  };
}

/** An in-memory sink for tests and scripts: keeps every message and counts send calls. */
export function memoryEventSink(): EventSink & {
  messages: AutomationQueueMessage[];
  sends: number;
} {
  const sink = {
    messages: [] as AutomationQueueMessage[],
    sends: 0,
    async send(messages: AutomationQueueMessage[]) {
      sink.sends += 1;
      sink.messages.push(...messages);
    },
  };
  return sink;
}

/** Sends without failing the caller: the change is committed; a lost event is logged. */
export async function emitEvents(
  sink: EventSink | undefined,
  messages: AutomationQueueMessage[],
): Promise<void> {
  if (!sink || !messages.length) return;
  try {
    await sink.send(messages);
  } catch (error) {
    console.error("automation events: send failed", messages[0]?.id, error);
  }
}
