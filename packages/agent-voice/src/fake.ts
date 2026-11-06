// Stand-in speech providers for tests and local e2e: no network and no key. The transcriber
// "hears" what a test passes to `say`, and speech is silence of a plausible length.
import type { TranscriberSessionOptions } from "agents/voice/types";
import { pcmMs, type SpokenSegment } from "./playout.ts";
import type {
  SpeechProviders,
  SpeechSession,
  SpeechSessionOptions,
  SpeechToText,
  SpeechToTextSession,
  SpeechUsage,
  TextToSpeech,
  VoiceOption,
} from "./providers.ts";

const SAMPLE_RATE = 24_000;
/** A fake voice speaks one character every 60 ms, in 100 ms chunks. */
export const FAKE_MS_PER_CHARACTER = 60;
const CHUNK_MS = 100;

export const FAKE_VOICES: readonly VoiceOption[] = [
  { id: "fake-ada", name: "Ada", description: "Test voice" },
  { id: "fake-ben", name: "Ben", description: "Test voice" },
];

export class FakeTranscriber implements SpeechToText {
  /** The newest session, so a test can speak into it. */
  last: SpeechToTextSession | null = null;

  createSession(options: TranscriberSessionOptions = {}): SpeechToTextSession {
    let held = "";
    let audioBytes = 0;
    const finish = () => {
      const text = held.trim();
      held = "";
      if (text) options.onUtterance?.(text);
    };
    const session: SpeechToTextSession = {
      feed(chunk) {
        audioBytes += chunk.byteLength;
      },
      close() {},
      endTurn: finish,
      takeUsage(): SpeechUsage {
        const audioSeconds = audioBytes / 32_000;
        audioBytes = 0;
        return { audioSeconds, characters: 0 };
      },
      say(text) {
        // Words stream in one at a time; "..." at the end keeps the turn open (push-to-talk).
        const open = text.endsWith("...");
        const words = text
          .replace(/\.\.\.$/, "")
          .split(/\s+/)
          .filter(Boolean);
        words.forEach((_, i) => {
          const partial = words.slice(0, i + 1).join(" ");
          if (i === 0) options.onSpeechStart?.(partial);
          options.onInterim?.(partial);
        });
        held = words.join(" ");
        audioBytes += words.length * 16_000;
        if (!open) finish();
      },
    };
    this.last = session;
    return session;
  }
}

export class FakeSpeech implements TextToSpeech {
  readonly capabilities;
  /** Every sentence spoken, in order. */
  readonly spoken: string[] = [];

  constructor(options: { supportsSpeed?: boolean } = {}) {
    this.capabilities = { supportsSpeed: options.supportsSpeed ?? false };
  }

  voices(): readonly VoiceOption[] {
    return FAKE_VOICES;
  }

  open(options: SpeechSessionOptions): SpeechSession {
    const spoken = this.spoken;
    let characters = 0;
    let generation = 0;
    return {
      sampleRate: SAMPLE_RATE,
      async *synthesizeStream(text, signal) {
        const mine = generation;
        spoken.push(text);
        characters += text.length;
        const totalMs = text.length * FAKE_MS_PER_CHARACTER;
        const segment: SpokenSegment = { text, audioMs: 0 };
        options.onSegment?.(segment);
        for (let at = 0; at < totalMs; at += CHUNK_MS) {
          if (signal?.aborted || mine !== generation) return;
          const ms = Math.min(CHUNK_MS, totalMs - at);
          const bytes = Math.round((ms / 1000) * SAMPLE_RATE) * 2;
          segment.audioMs += pcmMs(bytes, SAMPLE_RATE);
          yield new ArrayBuffer(bytes);
          // Yields to the event loop, so an interruption can land between chunks.
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      },
      cancel() {
        generation += 1;
      },
      close() {
        generation += 1;
      },
      takeUsage() {
        const used = characters;
        characters = 0;
        return { audioSeconds: 0, characters: used };
      },
    };
  }
}

export function fakeSpeechProviders(): SpeechProviders & {
  speechToText: FakeTranscriber;
  textToSpeech: FakeSpeech;
} {
  return { speechToText: new FakeTranscriber(), textToSpeech: new FakeSpeech() };
}
