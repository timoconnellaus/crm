// Trigger sources (ADR 0130): one per queue message kind, each turning a message into run
// candidates for the enabled automations whose trigger it fires. Matching is pure over the message
// and the automations; the consumer (ros-runner) then applies the rails and the conditions.
//
// Stage 6b registers a source for `integration` messages (trigger types `webhook`, `syncEvent`)
// with `registerTriggerSource`; nothing else in the consumer changes.
import type { ValueMatch } from "@relationship-os/sdk";
import { getObject } from "../fields/index.ts";
import type {
  ApprovalDecidedMessage,
  AutomationDefinition,
  AutomationQueueMessage,
  RecordEventMessage,
  RunCandidate,
  TriggerSource,
} from "./types.ts";

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Does `value` satisfy a fieldChanged `from` / `to`? Stage types compare the stage's type. */
export function valueMatches(
  match: ValueMatch | undefined,
  value: unknown,
  stageType: unknown,
): boolean {
  if (match === undefined) return true;
  if (match !== null && typeof match === "object") {
    if ("in" in match) return match.in.some((m) => same(m, value));
    return stageType === match.stageType;
  }
  return same(match, value);
}

function usesStageType(match: ValueMatch | undefined): boolean {
  return match !== null && typeof match === "object" && "stageType" in match;
}

/** Records changed: `record` and `fieldChanged` triggers. */
export const recordTriggerSource: TriggerSource<RecordEventMessage> = {
  kind: "record",
  triggerTypes: ["record", "fieldChanged"],
  match(message, automations) {
    const out: RunCandidate[] = [];
    for (const change of message.changes) {
      for (const automation of automations) {
        const trigger = automation.spec.trigger;
        if (trigger.type !== "record" && trigger.type !== "fieldChanged") continue;
        if (trigger.object !== change.object) continue;
        // One import must not start thousands of runs (cost audit U3).
        if (message.origin.bulk && !trigger.includeBulk) continue;
        const base = {
          automation,
          idempotencyKey: `${message.id}:${change.id}`,
          record: { object: change.object, id: change.id },
          change: { action: change.action, diff: change.diff ?? {} },
        };
        if (trigger.type === "record") {
          if (trigger.on.includes(change.action)) out.push(base);
          continue;
        }
        if (change.action !== "updated" || !change.diff) continue;
        const diff = change.diff;
        const stageTyped = usesStageType(trigger.from) || usesStageType(trigger.to);
        const statusField = stageTyped ? getObject(change.object)?.stages?.status : undefined;
        const status = statusField ? diff[statusField] : undefined;
        if (!(trigger.field in diff) && !status) continue;
        // A stage move within one stage type leaves the status unchanged: before = after.
        const fieldDiff = diff[trigger.field] ?? { before: undefined, after: undefined };
        if (stageTyped && !status) continue;
        if (!valueMatches(trigger.from, fieldDiff.before, status?.before)) continue;
        if (!valueMatches(trigger.to, fieldDiff.after, status?.after)) continue;
        out.push(base);
      }
    }
    return out;
  },
};

/** A pending action was decided: `approvalDecided` triggers. */
export const approvalTriggerSource: TriggerSource<ApprovalDecidedMessage> = {
  kind: "approval",
  triggerTypes: ["approvalDecided"],
  match(message, automations) {
    if (message.decision !== "approved" && message.decision !== "rejected") return [];
    const decision = message.decision;
    const out: RunCandidate[] = [];
    for (const automation of automations) {
      const trigger = automation.spec.trigger;
      if (trigger.type !== "approvalDecided") continue;
      if (trigger.decision && trigger.decision !== "any" && trigger.decision !== decision) continue;
      if (trigger.operation && trigger.operation !== message.operation) continue;
      if (trigger.object && !message.records.some((r) => r.object === trigger.object)) continue;
      const first = trigger.object
        ? message.records.find((r) => r.object === trigger.object)
        : message.records[0];
      out.push({
        automation,
        idempotencyKey: message.id,
        ...(first ? { record: first } : {}),
        approval: {
          actionId: message.actionId,
          operation: message.operation,
          decision,
          records: message.records,
        },
      });
    }
    return out;
  },
};

const sources = new Map<string, TriggerSource>([
  ["record", recordTriggerSource as TriggerSource],
  ["approval", approvalTriggerSource as TriggerSource],
]);

/** Registers (or replaces) the source for a message kind. Stage 6b: `integration`. */
export function registerTriggerSource<M extends AutomationQueueMessage>(
  source: TriggerSource<M>,
): void {
  sources.set(source.kind, source as unknown as TriggerSource);
}

/** The source for a message kind, if one is registered. */
export function triggerSourceFor(kind: string): TriggerSource | undefined {
  return sources.get(kind);
}

/** The objects a message touches (to narrow the automations loaded for it). */
export function messageObjects(message: AutomationQueueMessage): string[] | undefined {
  if (message.kind === "record") return [...new Set(message.changes.map((c) => c.object))];
  return undefined;
}

/** Matches one message: its source's candidates, or none when no source handles its kind. */
export function matchMessage(
  message: AutomationQueueMessage,
  automations: readonly AutomationDefinition[],
): RunCandidate[] {
  const source = triggerSourceFor(message.kind);
  return source ? source.match(message, automations) : [];
}
