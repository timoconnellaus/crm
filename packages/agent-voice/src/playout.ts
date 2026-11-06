// Playout truth (ADR 0349, decision 7): what the person actually heard of a spoken reply. The
// server knows each sentence it sent to speech, how much audio that sentence made and, when the
// provider reports them, when each word starts in that audio. The browser knows how many
// milliseconds it played before it stopped (the reply ended, or the person spoke over it). From
// the two the thread stores `spoken`, `partly_spoken` with the words not heard, or `unspoken`.

/** The thread's record of a spoken reply (the same shape agent-core stores). */
export type Playout =
  | { state: "spoken" }
  | { state: "partly_spoken"; unsaid: string }
  | { state: "unspoken" };

/** A word's place in its sentence's audio, in milliseconds from the sentence's start. */
export interface WordTiming {
  word: string;
  start: number;
  end: number;
}

/** One sentence sent to speech, in the order its audio was sent. */
export interface SpokenSegment {
  text: string;
  /** Milliseconds of audio this sentence produced and the server sent. */
  audioMs: number;
  /** Word timings when the provider reported them (best effort). */
  words?: readonly WordTiming[] | undefined;
}

/** Played time within this many milliseconds of the end counts as all of it. */
const END_SLACK_MS = 120;
/** Less than this played counts as nothing heard (a click, a buffer). */
const NOTHING_MS = 150;

/**
 * The playout of a reply. `intended` is everything that was meant to be said (all sentences,
 * including any the person cut off before they reached speech); `segments` are those that were
 * synthesised, in order; `playedMs` is what the browser played.
 */
export function playoutFor(
  segments: readonly SpokenSegment[],
  playedMs: number,
  intended: string = segments.map((s) => s.text).join(" "),
): Playout {
  const intendedText = squash(intended);
  const total = segments.reduce((n, s) => n + Math.max(0, s.audioMs), 0);
  if (!intendedText) return { state: "spoken" };
  if (playedMs < NOTHING_MS || total === 0) return { state: "unspoken" };
  const heard = heardText(segments, playedMs);
  const allSynthesised = squash(segments.map((s) => s.text).join(" ")).length >= intendedText.length;
  if (playedMs >= total - END_SLACK_MS && allSynthesised) return { state: "spoken" };
  const unsaid = unsaidAfter(intendedText, heard);
  if (!unsaid) return { state: "spoken" };
  if (!squash(heard)) return { state: "unspoken" };
  return { state: "partly_spoken", unsaid };
}

/** The words heard within `playedMs` of the segments' audio. */
export function heardText(segments: readonly SpokenSegment[], playedMs: number): string {
  const out: string[] = [];
  let offset = 0;
  for (const segment of segments) {
    const length = Math.max(0, segment.audioMs);
    if (playedMs >= offset + length - END_SLACK_MS / 2) {
      out.push(segment.text);
      offset += length;
      continue;
    }
    const into = playedMs - offset;
    if (into > 0) out.push(partOfSegment(segment, into));
    break;
  }
  return squash(out.join(" "));
}

/** The part of one segment heard in its first `into` milliseconds. */
function partOfSegment(segment: SpokenSegment, into: number): string {
  const words = segment.words?.filter((w) => w.word.trim());
  if (words?.length) {
    // A word counts as heard once most of it played.
    const heard = words.filter((w) => w.start + (w.end - w.start) * 0.6 <= into);
    return wordsPrefix(segment.text, heard.length);
  }
  // No timings: share the audio out by characters.
  const fraction = segment.audioMs > 0 ? Math.min(1, into / segment.audioMs) : 0;
  const text = squash(segment.text);
  const cut = Math.floor(text.length * fraction);
  const prefix = text.slice(0, cut);
  // Only whole words count as heard.
  const boundary = text[cut] === undefined || text[cut] === " " ? cut : prefix.lastIndexOf(" ");
  return boundary > 0 ? text.slice(0, boundary) : "";
}

/** The first `count` words of `text`, with its punctuation. */
function wordsPrefix(text: string, count: number): string {
  if (count <= 0) return "";
  const tokens = squash(text).split(" ");
  return tokens.slice(0, count).join(" ");
}

/** What of `intended` comes after the `heard` prefix (compared word by word, loosely). */
export function unsaidAfter(intended: string, heard: string): string {
  const all = squash(intended).split(" ").filter(Boolean);
  const heardWords = squash(heard).split(" ").filter(Boolean);
  let i = 0;
  let j = 0;
  while (i < all.length && j < heardWords.length) {
    if (loose(all[i] as string) === loose(heardWords[j] as string)) {
      i += 1;
      j += 1;
    } else {
      // Providers may split or join tokens differently; skip the heard word.
      j += 1;
    }
  }
  return all.slice(i).join(" ");
}

function loose(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Milliseconds of 16-bit mono PCM in `bytes` at `sampleRate`. */
export function pcmMs(bytes: number, sampleRate: number): number {
  return (bytes / 2 / sampleRate) * 1000;
}
