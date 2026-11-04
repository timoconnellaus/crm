// Pure helpers the sync service uses to normalise mail (ADR 0112): addresses and domains,
// thread keys from RFC 5322 headers, snippets, signatures and bounces. Shared by crm-runner's sync
// adapters (which see the provider's message) and sync.ingest (which decides what to write).

/** Webmail and personal providers: never an organisation's domain, never "internal" by default. */
export const PUBLIC_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "fastmail.com",
  "gmx.com",
  "hey.com",
]);

/** Snippets stored in D1 and the search index are at most this long (cost audit U1). */
export const SNIPPET_MAX = 2000;

export function normaliseEmail(value: string | null | undefined): string | null {
  const email = (value ?? "").trim().toLowerCase();
  if (!email || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1);
}

/** Automated senders that are never suggested as contacts. */
export function isAutomatedAddress(email: string): boolean {
  const local = email.slice(0, email.indexOf("@"));
  return /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?|notifications?|alerts?|calendar-notification|news(letter)?)([+.-].*)?$/.test(
    local,
  );
}

/** A Message-ID without angle brackets, lower-cased: the dedupe key across mailboxes. */
export function normaliseMessageId(value: string | null | undefined): string | null {
  const id = (value ?? "").trim().replace(/^<|>$/g, "").trim().toLowerCase();
  return id && id.length <= 998 ? id : null;
}

/** Message-IDs in a References or In-Reply-To header value. */
export function parseMessageIds(header: string | null | undefined): string[] {
  const out: string[] = [];
  for (const match of (header ?? "").matchAll(/<([^<>\s]+)>/g)) {
    const id = normaliseMessageId(match[1]);
    if (id) out.push(id);
  }
  return out;
}

/** The conversation key: the thread's root Message-ID (first of References, else In-Reply-To). */
export function threadKeyFor(
  messageId: string,
  references: readonly string[],
  inReplyTo: string | null | undefined,
): string {
  const root = references[0] ?? normaliseMessageId(inReplyTo) ?? messageId;
  return `thread:${root}`;
}

/** Plain text, whitespace-collapsed, cut to SNIPPET_MAX. */
export function snippetOf(text: string | null | undefined, max = SNIPPET_MAX): string | null {
  const clean = (text ?? "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (!clean) return null;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Strips HTML to text (good enough for snippets and signatures). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** The body without quoted replies (lines starting with ">" and "On … wrote:" tails). */
function withoutQuotes(text: string): string {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^On .{4,200} wrote:$/.test(line.trim())) break;
    if (/^-{2,}\s*(Original|Forwarded) Message\s*-{2,}/i.test(line.trim())) break;
    if (line.trim().startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n");
}

const SIGN_OFF =
  /^(best|best regards|kind regards|regards|warm regards|many thanks|thanks|thank you|cheers|sincerely|all the best)[,!.]?$/i;

/**
 * The signature block of a plain-text email: the lines after a `-- ` delimiter, or after a
 * sign-off ("Best regards,"), up to 6 non-empty lines. Null when there is none.
 */
export function extractSignature(text: string | null | undefined): string | null {
  if (!text) return null;
  const lines = withoutQuotes(text).split("\n");
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? "").trim();
    if (line === "--" || line === "-- ") {
      start = i + 1;
      break;
    }
    if (SIGN_OFF.test(line)) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return null;
  const block = lines
    .slice(start)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l.length <= 200)
    .slice(0, 6);
  return block.length ? block.join("\n") : null;
}

/**
 * A signature's job title and company, by position: the first line is the name, then title,
 * then company (lines that look like phone numbers, URLs or addresses are skipped).
 */
export function parseSignature(
  signature: string,
  personName?: string | null,
): { title: string | null; company: string | null } {
  const lines = signature
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) =>
        l &&
        !/^[+()\d\s.-]{6,}$/.test(l) &&
        !/^(tel|phone|mobile|m|t|e|email|w|web)\s*[:.]/i.test(l) &&
        !/https?:\/\/|www\.|@/.test(l),
    );
  // The first line is the sender's name (whether or not it matches the CRM's spelling).
  const name = personName?.trim().toLowerCase();
  const rest =
    name && lines[0]?.toLowerCase() !== name && lines.length < 3 ? lines : lines.slice(1);
  const [first, second] = rest;
  // "Title, Company" or "Title at Company" on one line.
  const combined = first?.match(/^(.{2,80}?)(?:,| at | @ | \| )\s*(.{2,80})$/i);
  if (combined && !second) {
    return { title: combined[1]?.trim() ?? null, company: combined[2]?.trim() ?? null };
  }
  return { title: first ?? null, company: second ?? null };
}

/** True for a delivery-failure report (a bounce). */
export function isBounce(from: string | null, subject: string | null | undefined): boolean {
  const local = from ? from.slice(0, from.indexOf("@")) : "";
  if (/^(mailer-daemon|postmaster)$/i.test(local)) return true;
  return /^(undeliverable|delivery status notification|mail delivery (failed|subsystem)|returned mail|failure notice|delivery failure)/i.test(
    (subject ?? "").trim(),
  );
}

/**
 * The recipients a bounce reports as failed: `X-Failed-Recipients`, the DSN's
 * `Final-Recipient: rfc822; …` lines, or addresses quoted in the text.
 */
export function failedRecipients(
  headers: Record<string, string | undefined>,
  text: string | null | undefined,
): string[] {
  const out = new Set<string>();
  const header = headers["x-failed-recipients"];
  for (const part of (header ?? "").split(",")) {
    const email = normaliseEmail(part);
    if (email) out.add(email);
  }
  for (const match of (text ?? "").matchAll(
    /(?:Final|Original)-Recipient:\s*rfc822;\s*<?([^\s>]+)>?/gi,
  )) {
    const email = normaliseEmail(match[1]);
    if (email) out.add(email);
  }
  if (!out.size) {
    for (const match of (text ?? "").matchAll(
      /(?:to|recipient|address)[^\n]{0,40}?<?([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})>?/gi,
    )) {
      const email = normaliseEmail(match[1]);
      if (email && !isAutomatedAddress(email)) out.add(email);
    }
  }
  return [...out].slice(0, 20);
}

/** A short, stable hash of a signature (FNV-1a, hex): enough to notice a change. */
export function signatureHash(text: string): string {
  let hash = 0x811c9dc5;
  const normalised = text.toLowerCase().replace(/\s+/g, " ").trim();
  for (let i = 0; i < normalised.length; i++) {
    hash ^= normalised.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
