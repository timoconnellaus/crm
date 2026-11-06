// The wrapper over `agents/voice` (ADR 0349): `withVoice`, pinned, with the host's own turn engine
// in the middle. The SDK brings the socket protocol, the call lifecycle, sentence chunking (each
// sentence goes to speech on its own) and barge-in. This adds what it does not have: a spoken turn
// is the host's turn, not a line in the SDK's own transcript; what gets said is chosen from the
// reply; what was heard is worked out from the browser's report; dictation is a call that types
// instead of talks; usage is counted.
//
// `withVoiceInput` is not used: it cannot sit on the same class as `withVoice` (both claim the
// protocol), so dictation is a `withVoice` call whose utterances go back to the browser.
import type { Agent, Connection } from "agents";
import { withVoice } from "agents/voice";
import { type Playout, playoutFor, type SpokenSegment } from "./playout.ts";
import type { CallKind, VoiceClientFrame, VoiceFacts, VoiceServerFrame } from "./protocol.ts";
import type { SpeechProviders, SpeechSession, SpeechToTextSession, SpeechUsage } from "./providers.ts";
import { SpeechPicker, type SpeechMode, toSpeech } from "./speech-text.ts";

/** How one call runs, decided by the host when it starts. */
export interface VoiceCallPlan {
  providers: SpeechProviders;
  voiceId: string;
  speed?: number | undefined;
  /** When set, overrides the display fact: a stated preference for how much to read out. */
  readOut?: SpeechMode | undefined;
}

/** A turn the host started for a spoken message. */
export interface SpokenTurn {
  turn: number;
  /** The reply's text as it streams. Ends when the turn does. */
  text: AsyncIterable<string>;
}

/** The hooks the host implements. */
export interface VoiceHost {
  /** Who may call, and how. Null refuses the call. */
  planVoiceCall(connection: Connection, kind: CallKind): Promise<VoiceCallPlan | null>;
  /** "talk", "dictation", or null for a socket that is not a voice socket. */
  voiceCallKind(connection: Connection): CallKind | null;
  /** Runs the person's spoken words through the normal turn engine. */
  startSpokenTurn(
    connection: Connection,
    text: string,
    facts: VoiceFacts,
    mode: SpeechMode,
  ): Promise<SpokenTurn>;
  /** The person spoke over a reply that is still being written. */
  stopSpokenTurn(turn: number): void;
  /** What was heard of a turn's reply. */
  recordPlayout(turn: number, playout: Playout): void | Promise<void>;
  /** Logs usage (ADR 0349): the sockets do not go through AI Gateway. */
  recordVoiceUsage(connection: Connection, usage: SpeechUsage): void | Promise<void>;
}

interface Reply {
  turn: number;
  picker: SpeechPicker;
  segments: SpokenSegment[];
  firstAudioAt: number | null;
}

interface Call {
  kind: CallKind;
  plan: VoiceCallPlan;
  transcriber: SpeechToTextSession | null;
  speech: SpeechSession | null;
  reply: Reply | null;
}

// biome-ignore lint/suspicious/noExplicitAny: a TypeScript mixin's constructor must take any[].
type Constructor<T = object> = new (...args: any[]) => T;
type AgentLike = Constructor<Pick<Agent<Cloudflare.Env>, "sql" | "getConnections" | "keepAlive">>;

/** The audio the browser is told to expect: what AssemblyAI-TTS-1 sends, unchanged. */
const OUTPUT = { audioFormat: "pcm16", sampleRate: 24_000 } as const;

async function* spoken(source: AsyncIterable<string>, picker: SpeechPicker) {
  for await (const delta of source) {
    const out = picker.push(delta);
    if (out) yield out;
  }
  const rest = picker.end();
  if (rest) yield rest;
}

function send(connection: Connection, frame: VoiceServerFrame) {
  try {
    connection.send(JSON.stringify(frame));
  } catch {
    // The socket closed under us.
  }
}

/** Adds voice to an Agent class. The subclass implements `VoiceHost`. */
export function withAssistantVoice<TBase extends AgentLike>(Base: TBase) {
  const Voiced = withVoice(Base, OUTPUT);

  abstract class AssistantVoice extends Voiced {
    #calls = new Map<string, Call>();
    /** Each voice socket's latest display fact: it can arrive before the call has started. */
    #facts = new Map<string, VoiceFacts>();
    /** The call that is talking: speech has one voice at a time, across the person's devices. */
    #talking: { id: string; connection: Connection } | null = null;

    get #host(): VoiceHost {
      return this as unknown as VoiceHost;
    }

    override async beforeCallStart(connection: Connection): Promise<boolean> {
      const kind = this.#host.voiceCallKind(connection);
      if (!kind) return false;
      const plan = await this.#host.planVoiceCall(connection, kind);
      if (!plan) return false;
      const call: Call = {
        kind,
        plan,
        transcriber: null,
        speech: null,
        reply: null,
      };
      this.#calls.set(connection.id, call);
      if (kind === "talk") {
        // The newest device takes over.
        if (this.#talking && this.#talking.id !== connection.id) {
          this.forceEndCall(this.#talking.connection);
        }
        this.#talking = { id: connection.id, connection };
        call.speech = plan.providers.textToSpeech.open({
          voiceId: plan.voiceId,
          speed: plan.speed,
          onSegment: (segment) => {
            if (!call.reply) return;
            call.reply.firstAudioAt ??= Date.now();
            call.reply.segments.push(segment);
          },
        });
        const speech = call.speech;
        this.tts = {
          synthesizeStream: (text, signal) => speech.synthesizeStream(text, signal),
          synthesize: async () => null,
        };
      }
      return true;
    }

    override createTranscriber(connection: Connection) {
      const call = this.#calls.get(connection.id);
      if (!call) return null;
      return {
        createSession: (options?: Parameters<SpeechProviders["speechToText"]["createSession"]>[0]) => {
          const session = call.plan.providers.speechToText.createSession(options);
          call.transcriber = session;
          return session;
        },
      };
    }

    /** A dictated stretch goes back to the browser; a spoken one starts a turn, word for word. */
    override afterTranscribe(transcript: string, connection: Connection) {
      if (this.#calls.get(connection.id)?.kind !== "dictation") return transcript;
      send(connection, { type: "dictation.final", text: transcript });
      return null;
    }

    override async onTurn(transcript: string, context: Parameters<InstanceType<typeof Voiced>["onTurn"]>[1]) {
      const { connection, signal } = context;
      const call = this.#calls.get(connection.id);
      if (!call) return "";
      await this.#settleReply(connection, call);
      const facts = this.#facts.get(connection.id) ?? { canSeeCards: true };
      const mode: SpeechMode = call.plan.readOut ?? (facts.canSeeCards ? "short" : "full");
      const picker = new SpeechPicker(mode);
      const turn = await this.#host.startSpokenTurn(connection, transcript, facts, mode);
      call.reply = { turn: turn.turn, picker, segments: [], firstAudioAt: null };
      send(connection, { type: "voice.reply", turn: turn.turn });
      signal.addEventListener("abort", () => this.#host.stopSpokenTurn(turn.turn), { once: true });
      return spoken(turn.text, picker);
    }

    override beforeSynthesize(text: string) {
      return toSpeech(text) || null;
    }

    /** The SDK's own transcript is not used: the thread is the record (ADR 0349). */
    override saveMessage() {}

    override getConversationHistory() {
      return [];
    }

    /** Works out what was heard of the reply and stores it. */
    async #settleReply(connection: Connection, call: Call, playedMs?: number) {
      const reply = call.reply;
      if (!reply) return;
      call.reply = null;
      const intended = toSpeech(reply.picker.picked);
      if (!intended) return;
      // No report (the socket went): assume it played from the first audio until now.
      const played =
        playedMs ?? (reply.firstAudioAt === null ? 0 : Date.now() - reply.firstAudioAt);
      await this.#host.recordPlayout(reply.turn, playoutFor(reply.segments, played, intended));
      await this.#flushUsage(connection, call);
    }

    async #flushUsage(connection: Connection, call: Call) {
      const heard = call.transcriber?.takeUsage();
      const said = call.speech?.takeUsage();
      const usage: SpeechUsage = {
        audioSeconds: heard?.audioSeconds ?? 0,
        characters: said?.characters ?? 0,
      };
      if (usage.audioSeconds > 0 || usage.characters > 0) {
        await this.#host.recordVoiceUsage(connection, usage);
      }
    }

    async #finishCall(connection: Connection) {
      const call = this.#calls.get(connection.id);
      if (!call) return;
      this.#calls.delete(connection.id);
      await this.#settleReply(connection, call);
      await this.#flushUsage(connection, call);
      call.speech?.close();
      if (this.#talking?.id === connection.id) {
        this.#talking = null;
        this.tts = undefined;
      }
    }

    override async onCallEnd(connection: Connection) {
      await this.#finishCall(connection);
    }

    /** The SDK does not call `onCallEnd` when a socket drops mid-call. */
    onClose(connection: Connection) {
      this.#facts.delete(connection.id);
      void this.#finishCall(connection).catch((error: unknown) =>
        console.error("voice: could not finish the call", error),
      );
    }

    /** Handles this package's frames. Returns true when `message` was one. */
    handleVoiceFrame(connection: Connection, message: unknown): boolean {
      if (typeof message !== "string" || !message.startsWith('{"type":"voice.')) return false;
      let frame: VoiceClientFrame;
      try {
        frame = JSON.parse(message) as VoiceClientFrame;
      } catch {
        return false;
      }
      const call = this.#calls.get(connection.id);
      switch (frame.type) {
        case "voice.facts":
          this.#facts.set(connection.id, {
            canSeeCards: frame.canSeeCards === true,
            context: frame.context,
          });
          return true;
        case "voice.played":
          if (call?.reply?.turn === frame.turn && Number.isFinite(frame.playedMs)) {
            void this.#settleReply(connection, call, Math.max(0, frame.playedMs)).catch(
              (error: unknown) => console.error("voice: could not store the playout", error),
            );
          }
          return true;
        case "voice.release":
          call?.transcriber?.endTurn?.();
          return true;
        case "voice.fake_say":
          call?.transcriber?.say?.(String(frame.text));
          return true;
        default:
          return false;
      }
    }
  }
  return AssistantVoice;
}
