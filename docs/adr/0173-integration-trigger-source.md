# ADR 0173: Webhook and sync-event triggers (the integration trigger source)

Status: accepted, 2026-11-05 (stage 6b). Fills the stage 6b seam of [ADR 0130](0130-automation-runtime.md)
for the events of [ADR 0112](0112-email-calendar-sync-service.md) and
[ADR 0113](0113-inbound-webhooks-and-integration-events.md).

## Decision

- **Triggers** (SDK): `webhook { endpoint, events? }`: a verified delivery to that endpoint (and one
  of those event types); the run has no record, and `event.integration.payload.payload` is the
  sender's verified JSON. `syncEvent { event, from? }`: email/calendar sync wrote, changed or
  removed an activity (`meeting.scheduled` = the sync service's `meeting.created`); `from` (`person`,
  `organisation`, default `either`) requires a known link. The trigger record is the activity; the
  event carries ids only. Contract check: a `syncEvent` automation reads `activity`.
- **Source.** `integrationTriggerSource` (kind `integration`, trigger types `webhook`, `syncEvent`)
  is registered with `registerTriggerSource`; it is pure, like the record and approval sources.
  Idempotency key: the event row id (plus the activity id for sync events).
- **Poller.** ros-runner's minute cron reads unconsumed `core_integration_event` rows through
  `core_integration_event_unconsumed_idx` (100 per read, at most 5 reads a tick), turns each into an
  `IntegrationEventMessage` (id = row id, origin depth 0, actor `automation`, surface `system`),
  calls `dispatchAutomationMessages`, then sets `consumed_at`. If dispatch throws, the batch stays
  unconsumed and is retried next tick; runs are idempotent, so nothing doubles. An idle tick is one
  indexed read that returns nothing.
- **Disclosure.** Sync events never carry content, and restricted reads never become events (ADR
  0112). The poller also drops (consumes without dispatching) sync events whose activity is private
  (`private_to`) or missing, so content an owner hid never starts a run.
- Summary and diagram: "When the **stripe-billing** webhook receives an **invoice.paid** event",
  "When **an email is received** with a known **Person**"; `Webhook · …`, `Email and calendar
  sync · …` nodes.

## Consequences

- Webhook-triggered runs start within about a minute of the delivery (the cron), not instantly; the
  queue is not used for them, as 6a decided.
- The kill switch drops integration events like queue events (they are consumed, not kept).
- A burst of more than 500 events a minute drains over several ticks.
