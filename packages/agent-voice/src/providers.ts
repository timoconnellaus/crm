// The speech provider seams (ADR 0349). Speech-to-text is the Agents SDK's `Transcriber` with one
// addition (ending a turn on demand, for push-to-talk); text-to-speech is a long-lived session a
// call's sentences go through. A provider counts its own usage, because the sockets may not run
// through AI Gateway (ADR 0349's amendment): the host logs it beside other AI usage.
import type { Transcriber, TranscriberSession, TranscriberSessionOptions } from "agents/voice/types";
import type { SpokenSegment } from "./playout.ts";

/** One voice on offer. */
export interface VoiceOption {
  id: string;
  name: string;
  /** A few words for the picker: "American, warm". */
  description: string;
}

/** What a text-to-speech provider can do; the settings UI follows these flags. */
export interface SpeechCapabilities {
  /** The speaking speed can be set. The speed setting is shown only then (ADR 0349). */
  supportsSpeed: boolean;
}

/** What a session used since it was last asked. Counts only: never words or audio. */
export interface SpeechUsage {
  /** Seconds of audio sent to speech-to-text. */
  audioSeconds: number;
  /** Characters sent to text-to-speech. */
  characters: number;
}

/** A speech-to-text session. Everything the SDK needs, plus usage and an early end of turn. */
export interface SpeechToTextSession extends TranscriberSession {
  /** Ends the current turn now (the talk button was let go). */
  endTurn?(): void;
  /** Usage since the last call. */
  takeUsage(): SpeechUsage;
  /** Test providers only: behave as if the person said `text`. */
  say?(text: string): void;
}

export interface SpeechToText extends Transcriber {
  createSession(options?: TranscriberSessionOptions): SpeechToTextSession;
}

export interface SpeechSessionOptions {
  voiceId: string;
  /** Only sent when the provider supports speed. */
  speed?: number | undefined;
  /** A sentence started producing audio. The object is updated as more of it arrives. */
  onSegment?: (segment: SpokenSegment) => void;
}

/** A text-to-speech session: one per call, shared by the call's sentences. */
export interface SpeechSession {
  /** Sample rate of the 16-bit mono PCM it produces. */
  readonly sampleRate: number;
  /** Speaks one sentence, flushed on its own. Sentences are answered in the order they arrive. */
  synthesizeStream(text: string, signal?: AbortSignal): AsyncGenerator<ArrayBuffer>;
  /** Stops all speech in flight and queued (barge-in). The session stays usable. */
  cancel(): void;
  close(): void;
  takeUsage(): SpeechUsage;
}

export interface TextToSpeech {
  readonly capabilities: SpeechCapabilities;
  voices(): readonly VoiceOption[];
  open(options: SpeechSessionOptions): SpeechSession;
}

/** The speech pair a deployment uses. */
export interface SpeechProviders {
  speechToText: SpeechToText;
  textToSpeech: TextToSpeech;
}

/** Bytes of audio-to-seconds for 16 kHz 16-bit mono PCM (what the browser sends). */
export const INPUT_BYTES_PER_SECOND = 16_000 * 2;
