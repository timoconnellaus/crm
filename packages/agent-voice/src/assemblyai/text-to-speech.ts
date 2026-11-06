// AssemblyAI-TTS-1 over its streaming WebSocket (ADR 0349).
// https://www.assemblyai.com/docs/tts/api-reference/websocket-api
//
// One connection serves a call; each sentence is a `Generate` then a `Flush`, so it is spoken at
// once. Requests are answered in order, so sentences can queue. `Cancel` drops everything in
// flight and leaves the session open. The server closes an idle session after two minutes (a long
// quiet spell in a hands-free call), so the connection is reopened when next needed.
import type { SpokenSegment, WordTiming } from "../playout.ts";
import { pcmMs } from "../playout.ts";
import type {
  SpeechCapabilities,
  SpeechSession,
  SpeechSessionOptions,
  SpeechUsage,
  TextToSpeech,
  VoiceOption,
} from "../providers.ts";
import { openProviderSocket, type ProviderSocket, type SocketOpener } from "./socket.ts";

const DEFAULT_HOST = "tts.us.assemblyai.com";
const SAMPLE_RATE = 24_000;
/** The API's limit for one `Generate`. */
const MAX_TEXT = 2000;

/** A short list from AssemblyAI's catalogue (it has no listing API); any `voice_id` also works. */
export const ASSEMBLYAI_VOICES: readonly VoiceOption[] = [
  { id: "aai-jane", name: "Jane", description: "American" },
  { id: "aai-kyla", name: "Kyla", description: "American" },
  { id: "aai-peter", name: "Peter", description: "American" },
  { id: "aai-sara", name: "Sara", description: "American" },
  { id: "aai-steven", name: "Steven", description: "Australian" },
  { id: "aai-nancy", name: "Nancy", description: "British" },
  { id: "aai-percival", name: "Percival", description: "British" },
  { id: "aai-troy", name: "Troy", description: "Scottish" },
];

export interface AssemblyAISpeechOptions {
  apiKey: string;
  /** The `speak` role's model. */
  model: string;
  /** From the role's catalogue entry; AssemblyAI-TTS-1 has none yet. */
  supportsSpeed?: boolean;
  host?: string;
  open?: SocketOpener;
}

export class AssemblyAISpeech implements TextToSpeech {
  readonly capabilities: SpeechCapabilities;
  readonly #options: AssemblyAISpeechOptions;

  constructor(options: AssemblyAISpeechOptions) {
    this.#options = options;
    this.capabilities = { supportsSpeed: options.supportsSpeed ?? false };
  }

  voices(): readonly VoiceOption[] {
    return ASSEMBLYAI_VOICES;
  }

  open(options: SpeechSessionOptions): SpeechSession {
    return new SpeechConnection(this.#options, options);
  }
}

/** One sentence on its way through the session. */
class Sentence {
  flushId: number | null = null;
  segment: SpokenSegment | null = null;
  odd: number | null = null;
  ended = false;
  error: Error | null = null;
  #chunks: ArrayBuffer[] = [];
  #wake: (() => void) | null = null;

  constructor(readonly text: string) {}

  push(chunk: ArrayBuffer) {
    this.#chunks.push(chunk);
    this.#notify();
  }

  end(error?: Error) {
    this.ended = true;
    this.error = error ?? null;
    this.#notify();
  }

  #notify() {
    this.#wake?.();
    this.#wake = null;
  }

  async next(): Promise<ArrayBuffer | null> {
    for (;;) {
      const chunk = this.#chunks.shift();
      if (chunk) return chunk;
      if (this.ended) {
        if (this.error) throw this.error;
        return null;
      }
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }
}

class SpeechConnection implements SpeechSession {
  readonly sampleRate = SAMPLE_RATE;
  readonly #options: AssemblyAISpeechOptions;
  readonly #session: SpeechSessionOptions;
  #socket: Promise<ProviderSocket> | null = null;
  /** Sentences sent and not yet finished, oldest first. */
  #queue: Sentence[] = [];
  /** Finished sentences by flush id, for word timings that arrive after `FlushDone`. */
  #done = new Map<number, Sentence>();
  /** After a `Cancel`, audio already on the wire is dropped until `Cancelled` arrives. */
  #cancelling = false;
  #closed = false;
  #characters = 0;

  constructor(options: AssemblyAISpeechOptions, session: SpeechSessionOptions) {
    this.#options = options;
    this.#session = session;
  }

  #connect(): Promise<ProviderSocket> {
    if (this.#socket) return this.#socket;
    const query = new URLSearchParams({
      voice_id: this.#session.voiceId,
      model_id: this.#options.model,
      sample_rate: String(SAMPLE_RATE),
      encoding: "pcm_s16le",
      word_boundaries: "true",
      inactivity_timeout: "120",
    });
    const url = `wss://${this.#options.host ?? DEFAULT_HOST}/v1/ws?${query}`;
    const opening = (this.#options.open ?? openProviderSocket)(url, this.#options.apiKey).then(
      (socket) => {
        socket.addEventListener("message", (event) => {
          if (typeof event.data === "string") this.#onMessage(event.data);
        });
        socket.addEventListener("close", (event) => {
          this.#socket = null;
          this.#cancelling = false;
          this.#failAll(new Error(`Speech closed (${event.code})`));
        });
        return socket;
      },
    );
    this.#socket = opening;
    opening.catch(() => {
      if (this.#socket === opening) this.#socket = null;
    });
    return opening;
  }

  #failAll(error: Error) {
    for (const sentence of this.#queue.splice(0)) sentence.end(error);
  }

  #onMessage(data: string) {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (message.type) {
      case "Audio":
        if (!this.#cancelling) this.#onAudio(String(message.audio), Number(message.flush_id));
        return;
      case "FlushDone":
        if (!this.#cancelling) {
          this.#onDone(Number(message.flush_id), Number(message.audio_duration_ms));
        }
        return;
      case "WordBoundaries":
        this.#onWords(message);
        return;
      case "Cancelled":
        this.#cancelling = false;
        return;
      case "Error":
        this.#failAll(new Error(`Speech failed: ${String(message.error ?? message.error_code)}`));
        return;
      default:
        return;
    }
  }

  /** The sentence a flush id belongs to: ids are answered in order and may skip numbers. */
  #sentenceFor(flushId: number): Sentence | null {
    const known = this.#queue.find((s) => s.flushId === flushId);
    if (known) return known;
    const next = this.#queue.find((s) => s.flushId === null);
    if (next) next.flushId = flushId;
    return next ?? null;
  }

  #onAudio(base64: string, flushId: number) {
    const sentence = this.#sentenceFor(flushId);
    if (!sentence) return;
    const bytes = decodeBase64(base64);
    // Chunks are not sample-aligned: carry an odd byte to the next one.
    const carried = sentence.odd === null ? 0 : 1;
    const usable = (bytes.byteLength + carried) & ~1;
    if (usable === 0) {
      if (bytes.byteLength) sentence.odd = bytes[0] ?? null;
      return;
    }
    const out = new Uint8Array(usable);
    if (sentence.odd !== null) out[0] = sentence.odd;
    out.set(bytes.subarray(0, usable - carried), carried);
    sentence.odd = bytes.byteLength + carried > usable ? (bytes.at(-1) ?? null) : null;
    if (!sentence.segment) {
      sentence.segment = { text: sentence.text, audioMs: 0 };
      this.#session.onSegment?.(sentence.segment);
    }
    sentence.segment.audioMs += pcmMs(usable, SAMPLE_RATE);
    sentence.push(out.buffer);
  }

  #onDone(flushId: number, audioMs: number) {
    const sentence = this.#sentenceFor(flushId);
    if (!sentence) return;
    if (sentence.segment && Number.isFinite(audioMs)) sentence.segment.audioMs = audioMs;
    this.#queue.splice(this.#queue.indexOf(sentence), 1);
    this.#done.set(flushId, sentence);
    // Word timings come soon after, or not at all (best effort).
    for (const id of this.#done.keys()) {
      if (this.#done.size <= 8) break;
      this.#done.delete(id);
    }
    sentence.end();
  }

  #onWords(message: Record<string, unknown>) {
    const flushId = Number(message.flush_id);
    const sentence = this.#done.get(flushId) ?? this.#queue.find((s) => s.flushId === flushId);
    if (!sentence?.segment || !Array.isArray(message.words)) return;
    const offset = Number(message.audio_start_ms) || 0;
    const words = (message.words as WordTiming[]).map((w) => ({
      word: w.word,
      start: Number(w.start) - offset,
      end: Number(w.end) - offset,
    }));
    sentence.segment.words = [...(sentence.segment.words ?? []), ...words];
  }

  async *synthesizeStream(text: string, signal?: AbortSignal): AsyncGenerator<ArrayBuffer> {
    if (this.#closed || signal?.aborted) return;
    const sentence = new Sentence(text);
    this.#queue.push(sentence);
    const onAbort = () => this.cancel();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const socket = await this.#connect();
      if (sentence.ended) return;
      const spoken = text.slice(0, MAX_TEXT);
      this.#characters += spoken.length;
      socket.send(JSON.stringify({ type: "Generate", text: spoken }));
      socket.send(JSON.stringify({ type: "Flush" }));
      for (;;) {
        const chunk = await sentence.next();
        if (!chunk) return;
        yield chunk;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  cancel() {
    const live = this.#queue.splice(0);
    for (const sentence of live) sentence.end();
    if (!live.length) return;
    const socket = this.#socket;
    this.#cancelling = true;
    void socket?.then((s) => s.send(JSON.stringify({ type: "Cancel" }))).catch(() => {});
  }

  takeUsage(): SpeechUsage {
    const characters = this.#characters;
    this.#characters = 0;
    return { audioSeconds: 0, characters };
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.cancel();
    const socket = this.#socket;
    this.#socket = null;
    void socket
      ?.then((s) => {
        s.send(JSON.stringify({ type: "Terminate" }));
        s.close(1000);
      })
      .catch(() => {});
  }
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
