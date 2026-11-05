// The `integration` trigger source (ADR 0130's stage 6b seam, ADR 0173): verified webhook
// deliveries and email/calendar sync events, which stage 6a records in core_integration_event.
// ros-runner's minute cron polls the unconsumed rows, turns each into an IntegrationEventMessage
// (`integrationEventMessage`) and hands them to the same dispatcher the queue consumer uses.
//
// - `webhook { endpoint, events? }` matches a webhook event whose payload names that endpoint and
//   (when `events` is given) one of those event types. The run has no record; the event (the
//   sender's verified JSON) is in `event.integration`.
// - `syncEvent { event, from? }` matches a sync event of that type (`meeting.scheduled` is the
//   sync service's `meeting.created`) linked to a known person / organisation. The trigger record
//   is the activity; the event carries ids only, never content.
//
// The idempotency key is the event row id (plus the activity id), so a re-polled event starts
// nothing twice.
import type { AutomationEvent } from "@relationship-os/sdk";
import type { EventOrigin, IntegrationEventMessage, RunCandidate, TriggerSource } from "./types.ts";

/** Sync payloads (ADR 0112): ids only. */
export interface SyncEventPayload {
  activityId?: string;
  direction?: string;
  personIds?: string[];
  organisationIds?: string[];
}

/** Webhook payloads as the integration host records them (ADR 0113). */
export interface WebhookEventPayload {
  endpointId?: string | null;
  scheme?: string | null;
  payload?: unknown;
  headers?: Record<string, string>;
}

const SYNC_ALIASES: Record<string, string> = { "meeting.scheduled": "meeting.created" };

function syncTypeMatches(declared: string, actual: string): boolean {
  return (SYNC_ALIASES[declared] ?? declared) === actual;
}

function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export const integrationTriggerSource: TriggerSource<IntegrationEventMessage> = {
  kind: "integration",
  triggerTypes: ["webhook", "syncEvent"],
  match(message, automations) {
    const out: RunCandidate[] = [];
    const integration: NonNullable<AutomationEvent["integration"]> = {
      eventId: message.id,
      source: message.source === "sync" ? "sync" : "webhook",
      type: message.eventType,
      connectionId: message.connectionId || null,
      payload: message.payload ?? null,
    };
    for (const automation of automations) {
      const trigger = automation.spec.trigger;
      if (trigger.type === "webhook") {
        if (message.source !== "webhook") continue;
        const payload = (message.payload ?? {}) as WebhookEventPayload;
        if (payload.endpointId !== trigger.endpoint) continue;
        if (trigger.events?.length && !trigger.events.includes(message.eventType)) continue;
        out.push({ automation, idempotencyKey: message.id, integration });
        continue;
      }
      if (trigger.type === "syncEvent") {
        if (message.source !== "sync") continue;
        if (!syncTypeMatches(trigger.event, message.eventType)) continue;
        const payload = (message.payload ?? {}) as SyncEventPayload;
        const people = ids(payload.personIds);
        const orgs = ids(payload.organisationIds);
        const from = trigger.from ?? "either";
        // Deletes and cancellations carry the activity id only: they match `either`.
        const linked =
          message.eventType === "email.deleted" || message.eventType === "meeting.cancelled";
        if (from === "person" && !people.length) continue;
        if (from === "organisation" && !orgs.length) continue;
        if (from === "either" && !people.length && !orgs.length && !linked) continue;
        const activityId = typeof payload.activityId === "string" ? payload.activityId : null;
        out.push({
          automation,
          idempotencyKey: activityId ? `${message.id}:${activityId}` : message.id,
          ...(activityId ? { record: { object: "activity", id: activityId } } : {}),
          integration,
        });
      }
    }
    return out;
  },
};

/** The origin of an integration event: a system event at the root of its own cascade. */
export function integrationEventOrigin(eventId: string, source: string): EventOrigin {
  return {
    actor: "automation",
    userId: "system",
    surface: "system",
    operation: source === "sync" ? "sync.ingest" : "webhook.receive",
    rootEventId: eventId,
    depth: 0,
    chain: [],
    bulk: false,
  };
}

/** A core_integration_event row as the poller reads it. */
export interface IntegrationEventRow {
  id: string;
  source: string;
  connection_id: string | null;
  type: string;
  payload: string;
  occurred_at: string;
  created_at: string;
}

export function integrationEventMessage(row: IntegrationEventRow): IntegrationEventMessage {
  let payload: unknown = null;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    payload = null;
  }
  return {
    v: 1,
    kind: "integration",
    id: row.id,
    at: row.created_at,
    source: row.source,
    connectionId: row.connection_id ?? "",
    eventType: row.type,
    payload,
    origin: integrationEventOrigin(row.id, row.source),
  };
}
