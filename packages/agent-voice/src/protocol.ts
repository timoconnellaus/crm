// The frames agent-voice adds to the Agents SDK's voice protocol, on the same socket. Browser-safe.

/** What a call is for: a conversation, or words typed into a box. */
export type CallKind = "talk" | "dictation";

/** The display fact the client sends each turn (ADR 0349, decision 8). */
export interface VoiceFacts {
  /** Can the person see the chat and its cards? Then a short version is spoken. */
  canSeeCards: boolean;
  /** Host-defined context for the turn (the page they are on). */
  context?: unknown;
}

export type VoiceClientFrame =
  | ({ type: "voice.facts" } & VoiceFacts)
  /** Playback of a reply ended, finished or cut off, after this much audio. */
  | { type: "voice.played"; turn: number; playedMs: number }
  /** The talk button was let go, or dictation stopped: end the turn now. */
  | { type: "voice.release" }
  /** Test providers only: behave as if the person said this. */
  | { type: "voice.fake_say"; text: string };

export type VoiceServerFrame =
  /** Audio from here on belongs to this reply. */
  | { type: "voice.reply"; turn: number }
  /** A finished stretch of dictation. */
  | { type: "dictation.final"; text: string };

/** The `call` query parameter of a voice socket, or null for a plain thread socket. */
export function callKindOf(url: string): CallKind | null {
  const kind = new URL(url).searchParams.get("call");
  return kind === "talk" || kind === "dictation" ? kind : null;
}
