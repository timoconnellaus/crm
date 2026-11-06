// Real AssemblyAI, opt-in: `ASSEMBLYAI_LIVE=1 pnpm exec vitest run test/voice-live.test.ts`. The
// key comes from .dev.vars through the test pool's env, and CI never runs this. It speaks a
// sentence, feeds that audio to speech-to-text, and checks the words come back.
import { env } from "cloudflare:workers";
import { AssemblyAISpeech, AssemblyAITranscriber, type SpokenSegment } from "@relationship-os/agent-voice";
import { describe, expect, it } from "vitest";

const { AI_KEY_ASSEMBLYAI: key = "", ASSEMBLYAI_LIVE } = env as unknown as {
  AI_KEY_ASSEMBLYAI?: string;
  ASSEMBLYAI_LIVE?: string;
};
const live = ASSEMBLYAI_LIVE === "1" && key.length > 0;

/** 24 kHz 16-bit PCM to 16 kHz (nearest sample: enough for recognition). */
function to16k(pcm: Uint8Array): ArrayBuffer {
  const input = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
  const out = new Int16Array(Math.floor((input.length * 2) / 3));
  for (let i = 0; i < out.length; i++) out[i] = input[Math.floor((i * 3) / 2)] ?? 0;
  return out.buffer;
}

async function speak(text: string) {
  const segments: SpokenSegment[] = [];
  const speech = new AssemblyAISpeech({ apiKey: key, model: "assemblyai-tts-1" });
  const session = speech.open({ voiceId: "aai-jane", onSegment: (s) => segments.push(s) });
  const chunks: Uint8Array[] = [];
  for await (const chunk of session.synthesizeStream(text)) chunks.push(new Uint8Array(chunk));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const usage = session.takeUsage();
  session.close();
  const pcm = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    pcm.set(c, at);
    at += c.byteLength;
  }
  return { pcm, segments, usage };
}

describe.skipIf(!live)("AssemblyAI, live", () => {
  it("speaks a sentence with word timings, and hears it back", { timeout: 60_000 }, async () => {
    const { pcm, segments, usage } = await speak("Please call Lena back about the renewal on Friday.");
    expect(pcm.byteLength).toBeGreaterThan(24_000);
    expect(segments).toHaveLength(1);
    console.log("speech", { audioMs: segments[0]?.audioMs, words: segments[0]?.words?.slice(0, 3), usage });
    expect(usage.characters).toBeGreaterThan(40);

    const heard: string[] = [];
    const interims: string[] = [];
    let firstWord: string | undefined;
    const stt = new AssemblyAITranscriber({ apiKey: key, model: "universal-streaming" });
    const session = stt.createSession({
      onSpeechStart: (t) => {
        firstWord ??= t;
      },
      onInterim: (t) => interims.push(t),
      onUtterance: (t) => heard.push(t),
    });
    await session.waitUntilReady?.();
    const audio = new Uint8Array(to16k(pcm));
    for (let at = 0; at < audio.byteLength; at += 3200) {
      session.feed(audio.slice(at, at + 3200).buffer);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    session.endTurn?.();
    for (let i = 0; i < 80 && !heard.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    console.log("heard", { firstWord, interims: interims.length, heard, usage: session.takeUsage() });
    session.close();
    expect(heard.join(" ").toLowerCase()).toContain("renewal");
    expect(firstWord).toBeTruthy();
  });

  it("stops on Cancel and keeps working", { timeout: 60_000 }, async () => {
    const speech = new AssemblyAISpeech({ apiKey: key, model: "assemblyai-tts-1" });
    const session = speech.open({ voiceId: "aai-jane" });
    let chunks = 0;
    for await (const _ of session.synthesizeStream(
      "This is a long sentence that will be cut off well before it has had the chance to finish, because someone spoke over it.",
    )) {
      chunks += 1;
      if (chunks === 2) session.cancel();
    }
    expect(chunks).toBeLessThanOrEqual(3);
    let after = 0;
    for await (const _ of session.synthesizeStream("Still here.")) after += 1;
    session.close();
    expect(after).toBeGreaterThan(0);
  });
});
