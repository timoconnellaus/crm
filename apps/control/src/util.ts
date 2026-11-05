// Small helpers: ids, hashing, encoding and HTML escaping.

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A random id: `<prefix>_<20 chars>`. */
export function newId(prefix: string, length = 20): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return `${prefix}_${Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("")}`;
}

/** A tenant id: `t` + 9 lowercase letters/digits, safe in Worker, D1 and gateway names. */
export function newTenantId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return `t${Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("")}`;
}

/** 32 random bytes, base64url: sign-in tokens and session ids. */
export function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Constant-time comparison of two strings. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function addDays(at: Date, days: number): Date {
  return new Date(at.getTime() + days * 86_400_000);
}

/** `YYYY-MM-DD` (UTC). */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Micro-dollars as `$1.23`. */
export function dollars(micros: number): string {
  const sign = micros < 0 ? "-" : "";
  return `${sign}$${(Math.abs(micros) / 1_000_000).toFixed(2)}`;
}
