-- Stage 11, placement outbound.message (ADR 0238): the judge's check of a model-written outbound
-- message (email, chat post), stored on its pending action in the batch that already inserts it.
-- JSON: { status: "checked" | "unchecked", turnedToReview, findings: [{ part, fault, label }],
-- recipients, reason, model, checkedAt }, or NULL when the message was not checked (a person's own
-- action, notification delivery, no key, or the placement switched off). Labels, numbers and the
-- part of the message each finding is about; never the facts the message was checked against.
ALTER TABLE core_pending_action ADD COLUMN outbound_check TEXT;

UPDATE core_meta SET value = '256' WHERE key = 'schema_version';
