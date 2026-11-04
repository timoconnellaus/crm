// Hand-written guards for every RPC input. (No capnweb-validate decorators: the CRM's Vite dev
// server, which runs this Worker as an auxiliary worker, cannot transform them.)

import type { WebhookScheme } from "./types.js";

export const SCHEMES: readonly WebhookScheme[] = ["hmac-sha256", "github", "stripe", "slack"];

/** The resource URL pattern of an endpoint. */
export const ENDPOINT_URL_PATTERN = "webhook://endpoint/:endpointId";

const ENDPOINT_ID = /^[a-z0-9-]{3,64}$/;
/** A secret given by the admin (such as Stripe's `whsec_…`): printable ASCII, 8 to 512 characters. */
const SECRET = /^[\x21-\x7e]{8,512}$/;

export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;

export function isEndpointId(value: unknown): value is string {
  return typeof value === "string" && ENDPOINT_ID.test(value);
}

export function assertEndpointId(value: unknown): string {
  if (!isEndpointId(value)) {
    throw new TypeError("endpointId must be 3 to 64 lower-case letters, digits or hyphens.");
  }
  return value;
}

export function assertScheme(value: unknown): WebhookScheme {
  if (typeof value !== "string" || !(SCHEMES as readonly string[]).includes(value)) {
    throw new TypeError(`scheme must be one of ${SCHEMES.join(", ")}.`);
  }
  return value as WebhookScheme;
}

export function assertSecret(value: unknown): string {
  if (typeof value !== "string" || !SECRET.test(value)) {
    throw new TypeError("secret must be 8 to 512 printable ASCII characters without spaces.");
  }
  return value;
}

/** The endpoint id of `webhook://endpoint/<id>`, or a TypeError. */
export function endpointIdFromUrl(url: unknown): string {
  if (typeof url !== "string" || url.length > 200)
    throw new TypeError("Not a webhook endpoint URL.");
  const match = /^webhook:\/\/endpoint\/([^/?#]+)$/.exec(url);
  if (!match?.[1] || !isEndpointId(match[1])) {
    throw new TypeError(`Not a webhook endpoint URL (expected webhook://endpoint/<id>): ${url}`);
  }
  return match[1];
}

export function endpointUrl(endpointId: string): string {
  return `webhook://endpoint/${endpointId}`;
}

export type ConfigureInput = { endpointId: string; scheme: WebhookScheme; secret?: string };

export function parseConfigureInput(input: unknown): ConfigureInput {
  if (typeof input !== "object" || input === null)
    throw new TypeError("configure() takes an object.");
  const record = input as Record<string, unknown>;
  const parsed: ConfigureInput = {
    endpointId: assertEndpointId(record.endpointId),
    scheme: assertScheme(record.scheme),
  };
  if (record.secret !== undefined && record.secret !== null && record.secret !== "") {
    parsed.secret = assertSecret(record.secret);
  }
  return parsed;
}

export function parseListLimit(options: unknown): number {
  if (options === undefined || options === null) return DEFAULT_LIST_LIMIT;
  if (typeof options !== "object") throw new TypeError("listEvents() options must be an object.");
  const limit = (options as { limit?: unknown }).limit;
  if (limit === undefined) return DEFAULT_LIST_LIMIT;
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_LIST_LIMIT
  ) {
    throw new TypeError(`limit must be an integer from 1 to ${MAX_LIST_LIMIT}.`);
  }
  return limit;
}
