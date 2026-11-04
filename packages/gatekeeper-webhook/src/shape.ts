// Shapes a verified delivery into a typed WebhookEvent.

import type { WebhookEvent, WebhookScheme } from "./types.js";

/** Request headers kept on an event. Signatures, auth and cookies are never among them. */
export const EVENT_HEADER_ALLOWLIST: readonly string[] = [
  "content-type",
  "user-agent",
  "x-github-event",
  "x-github-delivery",
  "x-github-hook-id",
  "x-github-hook-installation-target-id",
  "x-github-hook-installation-target-type",
  "x-slack-request-timestamp",
  "x-slack-retry-num",
  "x-slack-retry-reason",
  "x-webhook-event",
  "x-webhook-id",
  "x-webhook-timestamp",
];

/** The longest event id or type kept; a longer provider value is replaced or truncated. */
const MAX_TOKEN_LENGTH = 200;
/** The longest header value kept on an event. */
const MAX_HEADER_LENGTH = 1024;

export type ShapedDelivery =
  | { kind: "event"; event: WebhookEvent }
  /** A Slack `url_verification` request: answer with the challenge, store nothing. */
  | { kind: "slack-challenge"; challenge: string };

/**
 * Shapes a delivery whose signature has been verified.
 * @param headers The request headers, lower-case names.
 * @param body The raw body.
 */
export function shapeDelivery(input: {
  endpointId: string;
  scheme: WebhookScheme;
  headers: Record<string, string>;
  body: Uint8Array;
  receivedAt: Date;
}): ShapedDelivery {
  const { endpointId, scheme, headers } = input;
  const text = new TextDecoder().decode(input.body);
  const payload = parsePayload(text);
  const record = isRecord(payload) ? payload : {};

  if (scheme === "slack" && record.type === "url_verification") {
    return { kind: "slack-challenge", challenge: stringField(record, "challenge") ?? "" };
  }

  let providerId: string | undefined;
  let type: string;
  switch (scheme) {
    case "github": {
      providerId = token(headers["x-github-delivery"]);
      const event = token(headers["x-github-event"]) ?? "unknown";
      const action = token(stringField(record, "action"));
      type = action ? `github.${event}.${action}` : `github.${event}`;
      break;
    }
    case "stripe":
      providerId = token(stringField(record, "id"));
      type = token(stringField(record, "type")) ?? "stripe";
      break;
    case "slack": {
      providerId = token(stringField(record, "event_id"));
      const event = isRecord(record.event) ? token(stringField(record.event, "type")) : undefined;
      type = `slack.${event ?? token(stringField(record, "type")) ?? "unknown"}`;
      break;
    }
    case "hmac-sha256":
      providerId = token(headers["x-webhook-id"]);
      type = token(headers["x-webhook-event"]) ?? token(stringField(record, "type")) ?? "webhook";
      break;
  }

  return {
    kind: "event",
    event: {
      id: providerId ?? crypto.randomUUID(),
      endpointId,
      scheme,
      type: type.slice(0, MAX_TOKEN_LENGTH),
      receivedAt: input.receivedAt.toISOString(),
      payload,
      headers: safeHeaders(headers),
    },
  };
}

function parsePayload(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function safeHeaders(headers: Record<string, string>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const name of EVENT_HEADER_ALLOWLIST) {
    const value = headers[name];
    if (value !== undefined) kept[name] = value.slice(0, MAX_HEADER_LENGTH);
  }
  return kept;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/** A printable, space-free identifier of bounded length, or undefined. */
function token(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > MAX_TOKEN_LENGTH) return undefined;
  return /^[\x21-\x7e]+$/.test(trimmed) ? trimmed : undefined;
}
