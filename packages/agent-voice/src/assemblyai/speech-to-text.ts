// AssemblyAI streaming speech-to-text (ADR 0349): the v3 WebSocket, with its own end-of-turn
// detection. https://www.assemblyai.com/docs/streaming/api-spec/streaming-websocket
//
// Barge-in is "the first transcribed word" (ADR 0349, decision 7), so `onSpeechStart` fires on a
// turn's first word, not on AssemblyAI's voice-activity `SpeechStarted`, which a cough also trips.
import type { TranscriberSessionOptions } from "agents/voice/types";
import {
  INPUT_BYTES_PER_SECOND,
  type SpeechToText,
  type SpeechToTextSession,
  type SpeechUsage,
} from "../providers.ts";
import { openProviderSocket, type ProviderSocket, type SocketOpener } from "./socket.ts";

const DEFAULT_HOST = "streaming.assemblyai.com";
/** AssemblyAI takes 20 to 1000 ms per message and recommends 50 to 100. */
const MIN_CHUNK_BYTES = (INPUT_BYTES_PER_SECOND / 1000) * 80;
const MAX_BUFFERED_BYTES = INPUT_BYTES_PER_SECOND * 10;

/** The `transcribe` role's model names, as AssemblyAI spells them. */
const SPEECH_MODELS: Readonly<Record<string, string>> = {
  "universal-streaming": "universal-streaming-english",
};

export interface AssemblyAITranscriberOptions {
  apiKey: string;
  /** The `transcribe` role's model. */
  model: string;
  host?: string;
  open?: SocketOpener;
}

interface TurnMessage {
  type: "Turn";
  turn_order?: number;
  end_of_turn?: boolean;
  turn_is_formatted?: boolean;
  transcript?: string;
  utterance?: string;
  words?: { text?: string }[];
}

export class AssemblyAITranscriber implements SpeechToText {
  readonly #options: AssemblyAITranscriberOptions;

  constructor(options: AssemblyAITranscriberOptions) {
    this.#options = options;
  }

  createSession(options: TranscriberSessionOptions = {}): SpeechToTextSession {
    return new TranscriberConnection(this.#options, options);
  }
}

class TranscriberConnection implements SpeechToTextSession {
  readonly #callbacks: TranscriberSessionOptions;
  readonly #formatted: boolean;
  readonly #ready: Promise<void>;
  #socket: ProviderSocket | null = null;
  #began = false;
  #closed = false;
  #pending: Uint8Array[] = [];
  #pendingBytes = 0;
  #bytesSent = 0;
  /** The turn whose first word has been heard. */
  #startedTurn: number | null = null;
  /** The last turn delivered as an utterance. */
  #finishedTurn = -1;

  constructor(options: AssemblyAITranscriberOptions, callbacks: TranscriberSessionOptions) {
    this.#callbacks = callbacks;
    const speechModel = SPEECH_MODELS[options.model] ?? options.model;
    // Only the Universal Streaming models format a turn in a second message.
    this.#formatted = speechModel.startsWith("universal-streaming");
    const query = new URLSearchParams({
      sample_rate: "16000",
      encoding: "pcm_s16le",
      speech_model: speechModel,
      ...(this.#formatted ? { format_turns: "true" } : {}),
    });
    const url = `wss://${options.host ?? DEFAULT_HOST}/v3/ws?${query}`;
    this.#ready = this.#connect(options, url);
    // `waitUntilReady` reports a failure to start; this keeps it from going unhandled meanwhile.
    this.#ready.catch(() => {});
  }

  async #connect(options: AssemblyAITranscriberOptions, url: string): Promise<void> {
    const socket = await (options.open ?? openProviderSocket)(url, options.apiKey);
    if (this.#closed) {
      socket.close(1000);
      return;
    }
    this.#socket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        const message = parse(event.data);
        if (message?.type === "Begin") {
          this.#began = true;
          this.#flushPending(true);
          resolve();
        } else if (message?.type === "Turn") {
          this.#onTurn(message as unknown as TurnMessage);
        } else if (message?.type === "Error") {
          reject(new Error(`Speech recognition failed: ${describe(message)}`));
        }
      });
      socket.addEventListener("close", (event) => {
        const error = new Error(`Speech recognition closed (${event.code})`);
        reject(error);
        if (!this.#closed) {
          this.#closed = true;
          this.#callbacks.onFatalError?.(error);
        }
      });
      socket.addEventListener("error", () => {
        reject(new Error("Speech recognition connection failed"));
      });
    });
  }

  #onTurn(message: TurnMessage) {
    const order = message.turn_order ?? 0;
    if (order <= this.#finishedTurn) return;
    const words = message.words?.map((w) => w.text ?? "").filter(Boolean) ?? [];
    const partial = words.length ? words.join(" ") : (message.transcript ?? "");
    if (partial.trim()) {
      if (this.#startedTurn !== order) {
        this.#startedTurn = order;
        this.#callbacks.onSpeechStart?.(partial);
      }
      this.#callbacks.onInterim?.(partial);
    }
    if (!message.end_of_turn) return;
    if (this.#formatted && !message.turn_is_formatted) return;
    this.#finishedTurn = order;
    const text = (message.utterance || message.transcript || partial).trim();
    if (text) this.#callbacks.onUtterance?.(text);
  }

  feed(chunk: ArrayBuffer) {
    if (this.#closed) return;
    this.#pending.push(new Uint8Array(chunk));
    this.#pendingBytes += chunk.byteLength;
    this.#flushPending(false);
    // Before the session begins, keep only the latest audio.
    while (this.#pendingBytes > MAX_BUFFERED_BYTES) {
      this.#pendingBytes -= this.#pending.shift()?.byteLength ?? 0;
    }
  }

  #flushPending(force: boolean) {
    if (!this.#began || !this.#socket) return;
    if (this.#pendingBytes === 0 || (!force && this.#pendingBytes < MIN_CHUNK_BYTES)) return;
    // One message stays under AssemblyAI's 1000 ms limit.
    const limit = INPUT_BYTES_PER_SECOND / 2;
    const joined = new Uint8Array(this.#pendingBytes);
    let at = 0;
    for (const part of this.#pending) {
      joined.set(part, at);
      at += part.byteLength;
    }
    for (let start = 0; start < joined.byteLength; start += limit) {
      this.#socket.send(joined.slice(start, start + limit));
    }
    this.#bytesSent += joined.byteLength;
    this.#pending = [];
    this.#pendingBytes = 0;
  }

  waitUntilReady(): Promise<void> {
    return this.#ready;
  }

  updateAgentContext(text: string) {
    // Only the Universal 3 models take the agent's last words as context.
    if (this.#formatted || !this.#began) return;
    this.#json({ type: "UpdateConfiguration", agent_context: text.slice(-1750) });
  }

  endTurn() {
    this.#flushPending(true);
    this.#json({ type: "ForceEndpoint" });
  }

  #json(message: Record<string, unknown>) {
    try {
      this.#socket?.send(JSON.stringify(message));
    } catch {
      // Closed under us: the close event reports it.
    }
  }

  takeUsage(): SpeechUsage {
    const audioSeconds = this.#bytesSent / INPUT_BYTES_PER_SECOND;
    this.#bytesSent = 0;
    return { audioSeconds, characters: 0 };
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#json({ type: "Terminate" });
    try {
      this.#socket?.close(1000);
    } catch {
      // Already closed.
    }
  }
}

function parse(data: string): (Record<string, unknown> & { type?: unknown }) | null {
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function describe(message: Record<string, unknown>): string {
  return String(message.error ?? message.error_code ?? "unknown error");
}
