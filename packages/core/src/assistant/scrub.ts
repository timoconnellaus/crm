// Erasing a person or organisation from assistant threads (ADR 0019 and ADR 0200 amendments,
// ADR 0340). A thread lives in its user's Durable Object, so D1 keeps an index of the records each
// thread referenced (`core_assistant_thread_refs`), written with the once-per-turn
// `thread.finishTurn`. An erase looks the subject up there and has each thread redact its stored
// messages the way the audit log is redacted: a tool call or tool result that mentions the subject
// loses its whole input or output, and free text (what the person and the assistant wrote, the
// tail blocks and reasoning) has each mention replaced with "[erased]".
import type { MessagePart } from "@relationship-os/agent-core";
import type { ModelMessage } from "ai";

export const ERASED = "[erased]";

/** What identifies the subject in a conversation. Sent to each conversation object to redact. */
export interface ConversationScrub {
  /** Ids, emails and phone numbers, matched case-insensitively anywhere in text. */
  terms: string[];
  /** Names (a person's full and given/family names, an organisation's name), matched as words. */
  names: string[];
}

const MIN_TERM = 6;
const MIN_NAME = 3;
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A phone number in any formatting: its digits with optional separators between them. */
function phonePattern(term: string): string | null {
  if (/[a-z@_]/i.test(term)) return null;
  const digits = term.replace(/\D/g, "");
  if (digits.length < MIN_TERM) return null;
  return digits.split("").join("[\\s().-]{0,3}");
}

/** The subject's identifying strings as one pattern (null when there is nothing to match). */
export function scrubPattern(scrub: ConversationScrub): RegExp | null {
  const exact = [...new Set(scrub.terms.map((t) => t.trim()).filter((t) => t.length >= MIN_TERM))];
  const parts = [
    ...exact.sort((a, b) => b.length - a.length).map(escapeRegExp),
    ...exact.map(phonePattern).filter((p): p is string => p !== null),
  ];
  const names = [...new Set(scrub.names.map((n) => n.trim()).filter((n) => n.length >= MIN_NAME))]
    .sort((a, b) => b.length - a.length)
    .map((n) => escapeRegExp(n).replace(/\s+/g, "\\s+"));
  if (names.length) parts.push(`(?<![\\p{L}\\p{N}])(?:${names.join("|")})(?![\\p{L}\\p{N}])`);
  return parts.length ? new RegExp(parts.join("|"), "giu") : null;
}

/** Replaces each mention of the subject in `text` with "[erased]". */
export function scrubText(text: string, pattern: RegExp | null): string {
  return pattern ? text.replace(pattern, ERASED) : text;
}

/** Does `value` (any JSON) mention the subject? */
export function mentions(value: unknown, pattern: RegExp | null): boolean {
  if (!pattern) return false;
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  pattern.lastIndex = 0;
  return pattern.test(text);
}

/** Every string inside `value` with the subject's mentions replaced; structure is kept. */
export function scrubValue<T>(value: T, pattern: RegExp | null): T {
  if (!pattern) return value;
  if (typeof value === "string") return scrubText(value, pattern) as T;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, pattern)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, scrubValue(v, pattern)]),
    ) as T;
  }
  return value;
}

/** A tool call's input once it is erased (an object, as providers expect for arguments). */
export const ERASED_TOOL_INPUT = { erased: true } as const;

/**
 * One stored message with the subject removed: whole tool inputs and outputs that mention them,
 * and mentions in text and reasoning. Returns the same object when nothing matched.
 */
export function scrubMessage(message: ModelMessage, pattern: RegExp | null): ModelMessage {
  if (!pattern || !mentions(message, pattern)) return message;
  if (typeof message.content === "string") {
    return { ...message, content: scrubText(message.content, pattern) } as ModelMessage;
  }
  const content = (message.content as unknown[]).map((part) => {
    const p = part as Record<string, unknown> & { type?: string };
    if (p.type === "tool-call") {
      return mentions(p.input, pattern) ? { ...p, input: ERASED_TOOL_INPUT } : p;
    }
    if (p.type === "tool-result") {
      return mentions(p.output, pattern) ? { ...p, output: { type: "text", value: ERASED } } : p;
    }
    if (p.type === "text" || p.type === "reasoning") {
      return typeof p.text === "string" ? { ...p, text: scrubText(p.text, pattern) } : p;
    }
    return scrubValue(p, pattern);
  });
  return { ...message, content } as ModelMessage;
}

/**
 * A thread message's parts with the subject removed: whole tool inputs, outputs and cards that
 * mention them, and mentions in text, tail blocks, reasoning, notices and cards' text fallbacks.
 * Returns the same array when nothing matched.
 */
export function scrubParts(parts: MessagePart[], pattern: RegExp | null): MessagePart[] {
  if (!pattern || !mentions(parts, pattern)) return parts;
  return parts.map((part): MessagePart => {
    switch (part.type) {
      case "tool-call":
        return mentions(part.input, pattern) ? { ...part, input: ERASED_TOOL_INPUT } : part;
      case "tool-result":
        return mentions(part.output, pattern)
          ? { ...part, output: { type: "text", value: ERASED } }
          : part;
      case "text":
      case "context":
      case "reasoning":
        return { ...part, text: scrubText(part.text, pattern) };
      case "a2ui":
        // A card that mentions the subject goes as a whole; its text stays, with them removed.
        return mentions(part, pattern)
          ? {
              type: "a2ui",
              source: part.source,
              document: null,
              fallback: scrubText(part.fallback, pattern),
            }
          : part;
      default:
        return scrubValue(part, pattern);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// The index: what a conversation referenced

/** Ids of the records an erase can remove (people and organisations). */
const ERASABLE_ID = /\b(?:per|org)_[0-9A-HJKMNP-TV-Z]{26}\b/g;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
/** At most this many refs are indexed per turn. */
export const MAX_REFS_PER_TURN = 500;

/** An email as the index holds it: `email:` and the SHA-256 of the lower-cased address. */
export async function emailRef(email: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(email.trim().toLowerCase()),
  );
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `email:${hex}`;
}

/** Whether a string is a ref the index accepts. */
export const conversationRefPattern = /^(?:(?:per|org)_[0-9A-HJKMNP-TV-Z]{26}|email:[0-9a-f]{64})$/;

/**
 * The refs to index for some of a conversation's content (messages, the page context): the
 * person and organisation ids it mentions, and its email addresses as hashes (so a conversation
 * that names someone only by email is found too, without storing the address).
 */
export async function conversationRefs(content: unknown): Promise<string[]> {
  const text = JSON.stringify(content ?? null);
  const ids = new Set(text.match(ERASABLE_ID) ?? []);
  const emails = new Set((text.match(EMAIL) ?? []).map((e) => e.toLowerCase()));
  const hashed = await Promise.all([...emails].map(emailRef));
  return [...ids, ...hashed].slice(0, MAX_REFS_PER_TURN);
}
