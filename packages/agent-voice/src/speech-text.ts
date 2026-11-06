// What gets said aloud (ADR 0349, decision 8). A reply in voice chat has two audiences: the ear
// and, when the person can see the screen, the chat. The model writes its short spoken version in
// a `<say>…</say>` block at the start of the reply and the full answer after it; when the person
// cannot see the screen it writes no block and the whole reply is read out.
//
// Everything here is pure, so the browser (to show "Said: …") and the server (to choose what to
// send to speech) share it.

/** How the reply is spoken: a short version (the person can see the chat) or all of it. */
export type SpeechMode = "short" | "full";

const OPEN = "<say>";
const CLOSE = "</say>";

/** A reply split into what was meant to be said and what is shown in the chat. */
export interface SpokenSplit {
  /** The `<say>` block's words, or null when the reply has none. */
  say: string | null;
  /** The reply without its `<say>` block (what the chat shows). */
  shown: string;
}

/**
 * Splits a reply into its `<say>` block and the rest. Tolerates a reply that is still streaming:
 * an unclosed block counts as the spoken version so far, and a half-written opening tag at the
 * end is hidden.
 */
export function splitSpoken(text: string): SpokenSplit {
  const start = text.indexOf(OPEN);
  if (start < 0) {
    return { say: null, shown: hidePartialTag(text) };
  }
  const end = text.indexOf(CLOSE, start + OPEN.length);
  const say = text.slice(start + OPEN.length, end < 0 ? undefined : end);
  const rest = end < 0 ? "" : text.slice(end + CLOSE.length);
  const shown = `${text.slice(0, start)}${rest}`.replace(/^\s+/, "");
  return { say: hidePartialTag(say).trim(), shown: hidePartialTag(shown) };
}

/** Hides a tag cut off at the end of streamed text ("<sa", "</sa"). */
function hidePartialTag(text: string): string {
  const lt = text.lastIndexOf("<");
  if (lt < 0) return text;
  const tail = text.slice(lt);
  if (OPEN.startsWith(tail) || CLOSE.startsWith(tail)) return text.slice(0, lt);
  return text;
}

/**
 * Markdown and symbols turned into words a voice can say: links keep their label, emphasis,
 * code marks, headings, bullets and table pipes go, and an arrow becomes "to".
 */
export function toSpeech(text: string): string {
  return text
    .replace(/<\/?say>/g, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?;:]|$)/g, "$1$2")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\|/g, ", ")
    .replace(/\s*(?:→|->)\s*/g, " to ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/**
 * Picks the words to speak out of a streamed reply. Feed it the reply's text deltas in order; it
 * returns the part of each delta to send to speech.
 *
 * - `short`: only the `<say>` block. A reply that turns out to have none falls back, at `end()`,
 *   to its first sentence or two (at most about 220 characters).
 * - `full`: everything except a `<say>` block (the model was asked for none, but if it writes one
 *   the full answer still gets read).
 */
export class SpeechPicker {
  #mode: SpeechMode;
  #raw = "";
  #emitted = 0;
  #spokeAny = false;

  constructor(mode: SpeechMode) {
    this.#mode = mode;
  }

  /** The text to speak from this delta (may be empty). */
  push(delta: string): string {
    this.#raw += delta;
    const target = this.#target(false);
    if (target.length <= this.#emitted) return "";
    const out = target.slice(this.#emitted);
    this.#emitted = target.length;
    if (out.trim()) this.#spokeAny = true;
    return out;
  }

  /** Whatever is left to speak once the reply is complete. */
  end(): string {
    const target = this.#target(true);
    const out = target.length > this.#emitted ? target.slice(this.#emitted) : "";
    this.#emitted = Math.max(this.#emitted, target.length);
    if (out.trim()) this.#spokeAny = true;
    return out;
  }

  /** Everything picked so far: the text meant to be heard. */
  get picked(): string {
    return this.#target(true).slice(0, this.#emitted);
  }

  get spokeAny(): boolean {
    return this.#spokeAny;
  }

  #target(final: boolean): string {
    const raw = this.#raw;
    const start = raw.indexOf(OPEN);
    if (this.#mode === "short") {
      if (start >= 0) {
        const end = raw.indexOf(CLOSE, start);
        const body = raw.slice(start + OPEN.length, end < 0 ? undefined : end);
        return end < 0 && !final ? hidePartialTag(body) : body;
      }
      // No block (yet). Wait while the start could still become one.
      if (!final) return "";
      return firstSentences(raw, 220);
    }
    // Full: the reply without a <say> block.
    if (start < 0) return final ? raw : hidePartialTag(raw);
    const end = raw.indexOf(CLOSE, start);
    if (end < 0) return raw.slice(0, start);
    return `${raw.slice(0, start)}${raw.slice(end + CLOSE.length)}`;
  }
}

/** The first sentences of `text`, up to about `max` characters (at least one sentence). */
export function firstSentences(text: string, max: number): string {
  const flat = text.trim();
  const sentences = flat.match(/[^.!?\n]+(?:[.!?]+|\n|$)/g) ?? [flat];
  let out = "";
  for (const s of sentences) {
    if (out && out.length + s.length > max) break;
    out += s;
  }
  return out.trim();
}
