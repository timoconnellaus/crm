// The browser side of a voice call. `VoiceClient` from `agents/voice/client` does the microphone,
// the playback and the protocol; this gives it our socket and listens on the way through, because
// it cannot say how much it played. Reporting that is what makes the thread's playout true.
//
// Barge-in is the first transcribed word (ADR 0349): the SDK's own loudness check is switched off,
// so a cough does not cut a reply off, and playback stops here when the first word arrives, even
// after the server has sent all its audio and has nothing left to interrupt.
import {
  VoiceClient,
  type VoiceStatus,
  type VoiceTransport,
  type VoiceTransportCloseInfo,
} from "agents/voice/client";
import { pcmMs } from "./playout.ts";
import { PlayoutClock } from "./playout-clock.ts";
import type { CallKind, VoiceClientFrame, VoiceFacts, VoiceServerFrame } from "./protocol.ts";

const SAMPLE_RATE = 24_000;
/** Above any real microphone level: turns the SDK's loudness barge-in off. */
const NEVER = 2;

class CallTransport implements VoiceTransport {
  onopen: (() => void) | null = null;
  onclose: ((info?: VoiceTransportCloseInfo) => void) | null = null;
  onerror: ((error?: unknown) => void) | null = null;
  onmessage: ((data: string | ArrayBuffer | Blob) => void) | null = null;
  #socket: WebSocket | null = null;

  constructor(
    private readonly url: string,
    private readonly tap: (data: string | ArrayBuffer) => boolean,
  ) {}

  get connected() {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  connect() {
    const socket = new WebSocket(this.url);
    socket.binaryType = "arraybuffer";
    socket.onopen = () => this.onopen?.();
    socket.onclose = (e) =>
      this.onclose?.({ code: e.code, reason: e.reason, wasClean: e.wasClean });
    socket.onerror = (e) => this.onerror?.(e);
    socket.onmessage = (e) => {
      const data = e.data as string | ArrayBuffer;
      if (this.tap(data)) this.onmessage?.(data);
    };
    this.#socket = socket;
  }

  disconnect() {
    this.#socket?.close();
    this.#socket = null;
  }

  sendJSON(data: Record<string, unknown>) {
    if (this.connected) this.#socket?.send(JSON.stringify(data));
  }

  sendBinary(data: ArrayBuffer) {
    if (this.connected) this.#socket?.send(data);
  }

  /** Hands a message to `VoiceClient` as if the server had sent it. */
  inject(message: Record<string, unknown>) {
    this.onmessage?.(JSON.stringify(message));
  }
}

export interface VoiceCallEvents {
  status?: (status: VoiceStatus) => void;
  /** The words so far of what the person is saying ("" when there are none). */
  interim?: (text: string) => void;
  /** A finished stretch of dictation. */
  final?: (text: string) => void;
  /** The person spoke over a reply. */
  interrupted?: () => void;
  error?: (message: string | null) => void;
  muted?: (muted: boolean) => void;
  /** The socket went away, so the call is over. */
  closed?: () => void;
}

export interface VoiceCallOptions {
  /** The voice socket's URL, without `call`. */
  url: string;
  kind: CallKind;
  /** Asked each turn, and when the socket opens. */
  facts?: () => VoiceFacts;
  events?: VoiceCallEvents;
  now?: () => number;
}

export class VoiceCall {
  readonly #options: VoiceCallOptions;
  readonly #transport: CallTransport;
  readonly #client: VoiceClient;
  readonly #clock = new PlayoutClock();
  readonly #now: () => number;
  /** The reply audio belongs to, until its playout is reported. */
  #turn: number | null = null;
  /** Audio still in flight when the person spoke over it. */
  #dropping = false;
  #inTurnWords = false;
  #reportTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: VoiceCallOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => performance.now());
    const url = new URL(options.url);
    url.searchParams.set("call", options.kind);
    this.#transport = new CallTransport(url.toString(), (data) => this.#tap(data));
    this.#client = new VoiceClient({
      agent: "assistant",
      transport: this.#transport,
      preferredFormat: "pcm16",
      interruptThreshold: NEVER,
    });
    const events = options.events;
    this.#client.addEventListener("statuschange", (status) => {
      events?.status?.(status);
      this.#onStatus(status);
    });
    this.#client.addEventListener("error", (message) => events?.error?.(message));
    this.#client.addEventListener("mutechange", (muted) => events?.muted?.(muted));
    this.#client.addEventListener("connectionchange", (connected) => {
      if (connected) this.sendFacts();
      else if (this.#started) events?.closed?.();
    });
  }

  #started = false;

  /** Connects and starts the microphone. Resolves once asked for; `status` follows. */
  async start(options: { muted?: boolean } = {}): Promise<void> {
    this.#started = true;
    await new Promise<void>((resolve) => {
      const opened = (connected: boolean) => {
        if (!connected) return;
        this.#client.removeEventListener("connectionchange", opened);
        resolve();
      };
      this.#client.addEventListener("connectionchange", opened);
      this.#client.connect();
    });
    await this.#client.startCall();
    if (options.muted && !this.#client.isMuted) this.#client.toggleMute();
  }

  end() {
    this.#started = false;
    this.#report();
    this.#client.disconnect();
  }

  get muted() {
    return this.#client.isMuted;
  }

  setMuted(muted: boolean) {
    if (this.#client.isMuted !== muted) this.#client.toggleMute();
  }

  /** The talk button went down. */
  hold() {
    this.setMuted(false);
  }

  /** The talk button came up: the turn is over. */
  release() {
    this.setMuted(true);
    this.#frame({ type: "voice.release" });
  }

  /** Ends the current stretch of speech (dictation stopping). */
  finishSpeaking() {
    this.#frame({ type: "voice.release" });
  }

  sendFacts() {
    const facts = this.#options.facts?.();
    if (facts) this.#frame({ type: "voice.facts", ...facts });
  }

  /** Test providers only. */
  fakeSay(text: string) {
    this.#frame({ type: "voice.fake_say", text });
  }

  #frame(frame: VoiceClientFrame) {
    this.#transport.sendJSON(frame as unknown as Record<string, unknown>);
  }

  /** Sees everything the server sends; false keeps it from `VoiceClient`. */
  #tap(data: string | ArrayBuffer): boolean {
    if (typeof data !== "string") {
      if (this.#dropping) return false;
      this.#clock.add(this.#now(), pcmMs(data.byteLength, SAMPLE_RATE));
      return true;
    }
    let message: { type?: string; text?: string; turn?: number };
    try {
      message = JSON.parse(data) as typeof message;
    } catch {
      return true;
    }
    switch (message.type) {
      case "voice.reply":
        this.#report();
        this.#turn = (message as Extract<VoiceServerFrame, { type: "voice.reply" }>).turn;
        this.#dropping = false;
        this.#clock.reset();
        return false;
      case "dictation.final":
        this.#options.events?.final?.(String(message.text));
        return false;
      case "transcript_interim":
        this.#onWords(String(message.text ?? ""));
        return true;
      default:
        return true;
    }
  }

  #onWords(text: string) {
    this.#options.events?.interim?.(text);
    if (!text) {
      this.#inTurnWords = false;
      return;
    }
    if (this.#inTurnWords) return;
    // The first word of a turn: fresh facts for it, and it stops any reply playing.
    this.#inTurnWords = true;
    this.sendFacts();
    if (this.#clock.isPlaying(this.#now())) {
      this.#report();
      this.#dropping = true;
      this.#transport.inject({ type: "playback_interrupt" });
      this.#options.events?.interrupted?.();
    }
  }

  /** The server has sent all its audio: report when the last of it has played. */
  #onStatus(status: VoiceStatus) {
    if (status !== "listening" || this.#turn === null) return;
    if (this.#reportTimer) clearTimeout(this.#reportTimer);
    const wait = Math.max(0, this.#clock.endsAt - this.#now());
    this.#reportTimer = setTimeout(() => this.#report(), wait + 50);
  }

  /** Tells the server how much of the reply played. Once per reply. */
  #report() {
    if (this.#reportTimer) clearTimeout(this.#reportTimer);
    this.#reportTimer = null;
    const turn = this.#turn;
    if (turn === null) return;
    this.#turn = null;
    this.#frame({
      type: "voice.played",
      turn,
      playedMs: Math.round(this.#clock.played(this.#now())),
    });
  }
}

export type { VoiceStatus };
export { splitSpoken } from "./speech-text.ts";
export type { CallKind, VoiceFacts } from "./protocol.ts";
export type { Playout } from "./playout.ts";
