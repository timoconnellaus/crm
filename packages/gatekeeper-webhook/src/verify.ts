// Signature verification for each scheme, with WebCrypto. `crypto.subtle.verify("HMAC", …)`
// compares in constant time, so a provided signature is never compared byte by byte here.

import type { WebhookScheme } from "./types.js";

/** How far a signed timestamp may be from now, in seconds (as Stripe and Slack recommend). */
export const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

/** At most this many `v1=` signatures are tried from one Stripe-Signature header. */
const MAX_STRIPE_SIGNATURES = 8;

/** Why a delivery was refused. Fixed strings: they are counted and shown, and quote nothing. */
export type RejectionReason =
  | "missing signature"
  | "malformed signature"
  | "bad signature"
  | "missing timestamp"
  | "stale timestamp";

export type VerifyResult = { ok: true } | { ok: false; reason: RejectionReason };

/**
 * Verifies a delivery's signature under `scheme`.
 * @param headers The request headers, lower-case names.
 * @param body The raw request body, exactly as received.
 * @param nowSeconds The current Unix time in seconds.
 */
export async function verifySignature(
  scheme: WebhookScheme,
  secret: string,
  headers: Record<string, string>,
  body: Uint8Array,
  nowSeconds: number,
): Promise<VerifyResult> {
  switch (scheme) {
    case "hmac-sha256":
      return verifyGeneric(secret, headers, body, nowSeconds);
    case "github":
      return verifyPrefixedHex(secret, headers["x-hub-signature-256"], "sha256=", body);
    case "stripe":
      return verifyStripe(secret, headers["stripe-signature"], body, nowSeconds);
    case "slack":
      return verifySlack(secret, headers, body, nowSeconds);
  }
}

async function verifyGeneric(
  secret: string,
  headers: Record<string, string>,
  body: Uint8Array,
  nowSeconds: number,
): Promise<VerifyResult> {
  const timestamp = headers["x-webhook-timestamp"];
  if (timestamp === undefined) {
    return verifyPrefixedHex(secret, headers["x-webhook-signature"], "sha256=", body);
  }
  const stale = checkTimestamp(timestamp, nowSeconds);
  if (stale) return stale;
  return verifyPrefixedHex(
    secret,
    headers["x-webhook-signature"],
    "sha256=",
    concat(`${timestamp}.`, body),
  );
}

async function verifySlack(
  secret: string,
  headers: Record<string, string>,
  body: Uint8Array,
  nowSeconds: number,
): Promise<VerifyResult> {
  const signature = headers["x-slack-signature"];
  if (signature === undefined) return { ok: false, reason: "missing signature" };
  const timestamp = headers["x-slack-request-timestamp"];
  if (timestamp === undefined) return { ok: false, reason: "missing timestamp" };
  const stale = checkTimestamp(timestamp, nowSeconds);
  if (stale) return stale;
  return verifyPrefixedHex(secret, signature, "v0=", concat(`v0:${timestamp}:`, body));
}

async function verifyStripe(
  secret: string,
  header: string | undefined,
  body: Uint8Array,
  nowSeconds: number,
): Promise<VerifyResult> {
  if (header === undefined) return { ok: false, reason: "missing signature" };
  let timestamp: string | undefined;
  const signatures: Uint8Array[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      if (timestamp !== undefined) return { ok: false, reason: "malformed signature" };
      timestamp = value;
    } else if (key === "v1" && signatures.length < MAX_STRIPE_SIGNATURES) {
      const bytes = parseSha256Hex(value);
      if (bytes) signatures.push(bytes);
    }
  }
  if (timestamp === undefined) return { ok: false, reason: "missing timestamp" };
  if (signatures.length === 0) return { ok: false, reason: "missing signature" };
  const stale = checkTimestamp(timestamp, nowSeconds);
  if (stale) return stale;
  const key = await hmacKey(secret);
  const signed = concat(`${timestamp}.`, body);
  for (const signature of signatures) {
    if (await crypto.subtle.verify("HMAC", key, signature, signed)) return { ok: true };
  }
  return { ok: false, reason: "bad signature" };
}

/** Verifies a `<prefix><64 hex digits>` HMAC-SHA256 signature of `signed`. */
async function verifyPrefixedHex(
  secret: string,
  header: string | undefined,
  prefix: string,
  signed: Uint8Array,
): Promise<VerifyResult> {
  if (header === undefined || header.trim() === "")
    return { ok: false, reason: "missing signature" };
  const value = header.trim();
  if (!value.startsWith(prefix)) return { ok: false, reason: "malformed signature" };
  const signature = parseSha256Hex(value.slice(prefix.length));
  if (!signature) return { ok: false, reason: "malformed signature" };
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), signature, signed);
  return valid ? { ok: true } : { ok: false, reason: "bad signature" };
}

/** Rejects a timestamp that is not Unix seconds or is more than the tolerance from now. */
function checkTimestamp(value: string, nowSeconds: number): VerifyResult | undefined {
  if (!/^\d{1,12}$/.test(value)) return { ok: false, reason: "stale timestamp" };
  if (Math.abs(nowSeconds - Number(value)) > TIMESTAMP_TOLERANCE_SECONDS) {
    return { ok: false, reason: "stale timestamp" };
  }
  return undefined;
}

function parseSha256Hex(value: string): Uint8Array | undefined {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) return undefined;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function concat(prefix: string, body: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(prefix);
  const out = new Uint8Array(head.byteLength + body.byteLength);
  out.set(head, 0);
  out.set(body, head.byteLength);
  return out;
}

/**
 * Signs `body` the way `scheme`'s provider does, returning the headers to send. For tests and for
 * documentation of each scheme's exact format.
 * @param timestamp Unix seconds, for the schemes that sign one.
 */
export async function signForScheme(
  scheme: WebhookScheme,
  secret: string,
  body: string,
  timestamp: number,
): Promise<Record<string, string>> {
  const key = await hmacKey(secret);
  const hex = async (data: string) =>
    [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  switch (scheme) {
    case "hmac-sha256":
      return {
        "X-Webhook-Timestamp": String(timestamp),
        "X-Webhook-Signature": `sha256=${await hex(`${timestamp}.${body}`)}`,
      };
    case "github":
      return { "X-Hub-Signature-256": `sha256=${await hex(body)}` };
    case "stripe":
      return { "Stripe-Signature": `t=${timestamp},v1=${await hex(`${timestamp}.${body}`)}` };
    case "slack":
      return {
        "X-Slack-Request-Timestamp": String(timestamp),
        "X-Slack-Signature": `v0=${await hex(`v0:${timestamp}:${body}`)}`,
      };
  }
}
