// The providers against a stand-in for AssemblyAI's sockets, using the frames its docs show.
import { describe, expect, it } from "vitest";
import type { ProviderSocket } from "../src/assemblyai/socket.ts";
import { AssemblyAISpeech, AssemblyAITranscriber, type SpokenSegment } from "../src/index.ts";

class FakeSocket implements ProviderSocket {
  sent: (string | Uint8Array)[] = [];
  closed = false;
  #listeners = new Map<string, ((event: never) => void)[]>();

  send(data: string | ArrayBuffer | ArrayBufferView) {
    this.sent.push(typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer));
  }
  close() {
    this.closed = true;
  }
  addEventListener(type: string, listener: (event: never) => void) {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }
  emit(message: object) {
    for (const l of this.#listeners.get("message") ?? []) {
      l({ data: JSON.stringify(message) } as never);
    }
  }
  drop(code: number) {
    for (const l of this.#listeners.get("close") ?? []) l({ code, reason: "" } as never);
  }
  json() {
    return this.sent.filter((s) => typeof s === "string").map((s) => JSON.parse(s as string));
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("AssemblyAITranscriber", () => {
  async function session(model = "universal-streaming") {
    const socket = new FakeSocket();
    const urls: string[] = [];
    const log: string[] = [];
    const stt = new AssemblyAITranscriber({
      apiKey: "k",
      model,
      open: async (url) => {
        urls.push(url);
        return socket;
      },
    });
    const s = stt.createSession({
      onSpeechStart: (t) => log.push(`start:${t}`),
      onInterim: (t) => log.push(`interim:${t}`),
      onUtterance: (t) => log.push(`final:${t}`),
      onFatalError: (e) => log.push(`fatal:${e.message}`),
    });
    await tick();
    socket.emit({ type: "Begin", id: "x" });
    await s.waitUntilReady?.();
    return { socket, s, log, url: urls[0] as string };
  }

  it("never puts the key in the URL, and asks for the role's model", async () => {
    const { url } = await session();
    expect(url).not.toContain("k&");
    expect(url).toContain("speech_model=universal-streaming-english");
    expect(url).toContain("format_turns=true");
  });

  it("fires barge-in on the first word, not on silence, once per turn", async () => {
    const { socket, log } = await session();
    socket.emit({ type: "Turn", turn_order: 0, transcript: "", words: [] });
    expect(log).toEqual([]);
    socket.emit({ type: "Turn", turn_order: 0, transcript: "", words: [{ text: "call" }] });
    socket.emit({ type: "Turn", turn_order: 0, words: [{ text: "call" }, { text: "lena" }] });
    expect(log).toEqual(["start:call", "interim:call", "interim:call lena"]);
  });

  it("delivers the formatted turn once", async () => {
    const { socket, log } = await session();
    const words = [{ text: "call" }];
    socket.emit({ type: "Turn", turn_order: 1, end_of_turn: true, transcript: "call", words });
    socket.emit({
      type: "Turn",
      turn_order: 1,
      end_of_turn: true,
      turn_is_formatted: true,
      transcript: "Call.",
      words,
    });
    socket.emit({ type: "Turn", turn_order: 1, end_of_turn: true, transcript: "Call.", words });
    expect(log.filter((l) => l.startsWith("final"))).toEqual(["final:Call."]);
  });

  it("batches small chunks and counts the audio", async () => {
    const { socket, s } = await session();
    s.feed(new ArrayBuffer(1000));
    expect(socket.sent).toHaveLength(0);
    s.feed(new ArrayBuffer(2000));
    expect(socket.sent).toHaveLength(1);
    expect(s.takeUsage().audioSeconds).toBeCloseTo(3000 / 32000);
    expect(s.takeUsage().audioSeconds).toBe(0);
  });

  it("ends the turn on demand and reports a lost connection", async () => {
    const { socket, s, log } = await session();
    s.endTurn?.();
    expect(socket.json()).toContainEqual({ type: "ForceEndpoint" });
    socket.drop(1011);
    expect(log).toEqual(["fatal:Speech recognition closed (1011)"]);
  });

  it("does not report its own close as a failure", async () => {
    const { socket, s, log } = await session();
    s.close();
    socket.drop(1000);
    expect(socket.json()).toContainEqual({ type: "Terminate" });
    expect(log).toEqual([]);
  });
});

describe("AssemblyAISpeech", () => {
  function open() {
    const sockets: FakeSocket[] = [];
    const urls: string[] = [];
    const segments: SpokenSegment[] = [];
    const speech = new AssemblyAISpeech({
      apiKey: "k",
      model: "assemblyai-tts-1",
      open: async (url) => {
        urls.push(url);
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const session = speech.open({ voiceId: "aai-jane", onSegment: (s) => segments.push(s) });
    return { sockets, urls, segments, session, speech };
  }

  async function drain(stream: AsyncGenerator<ArrayBuffer>) {
    const out: ArrayBuffer[] = [];
    for await (const chunk of stream) out.push(chunk);
    return out;
  }

  const audio = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

  it("reports no speed control", () => {
    expect(open().speech.capabilities.supportsSpeed).toBe(false);
  });

  it("flushes each sentence and answers them in order, however ids skip", async () => {
    const { sockets, session, urls, segments } = open();
    const first = drain(session.synthesizeStream("One."));
    const second = drain(session.synthesizeStream("Two."));
    await tick();
    await tick();
    const socket = sockets[0] as FakeSocket;
    expect(sockets).toHaveLength(1);
    expect(urls[0]).toContain("model_id=assemblyai-tts-1");
    expect(socket.json().map((m) => m.type)).toEqual(["Generate", "Flush", "Generate", "Flush"]);
    socket.emit({ type: "Audio", flush_id: 4, audio: audio([1, 2]) });
    socket.emit({ type: "FlushDone", flush_id: 4, audio_duration_ms: 500 });
    socket.emit({ type: "Audio", flush_id: 9, audio: audio([3, 4]) });
    socket.emit({ type: "FlushDone", flush_id: 9, audio_duration_ms: 700 });
    expect((await first).length).toBe(1);
    expect((await second).length).toBe(1);
    expect(segments.map((s) => [s.text, s.audioMs])).toEqual([
      ["One.", 500],
      ["Two.", 700],
    ]);
    expect(session.takeUsage().characters).toBe(8);
  });

  it("keeps samples whole across odd chunks", async () => {
    const { sockets, session } = open();
    const out = drain(session.synthesizeStream("One."));
    await tick();
    await tick();
    const socket = sockets[0] as FakeSocket;
    socket.emit({ type: "Audio", flush_id: 0, audio: audio([1, 2, 3]) });
    socket.emit({ type: "Audio", flush_id: 0, audio: audio([4, 5, 6]) });
    socket.emit({ type: "FlushDone", flush_id: 0, audio_duration_ms: 1 });
    const chunks = await out;
    expect(chunks.map((c) => [...new Uint8Array(c)])).toEqual([
      [1, 2],
      [3, 4, 5, 6],
    ]);
  });

  it("attaches word timings that arrive after the sentence is done", async () => {
    const { sockets, session, segments } = open();
    const out = drain(session.synthesizeStream("One."));
    await tick();
    await tick();
    const socket = sockets[0] as FakeSocket;
    socket.emit({ type: "Audio", flush_id: 0, audio: audio([1, 2]) });
    socket.emit({ type: "FlushDone", flush_id: 0, audio_duration_ms: 400 });
    await out;
    socket.emit({
      type: "WordBoundaries",
      flush_id: 0,
      audio_start_ms: 0,
      words: [{ word: "One.", start: 10, end: 300, confidence: 0.9 }],
    });
    expect(segments[0]?.words).toEqual([{ word: "One.", start: 10, end: 300 }]);
  });

  it("cancels on barge-in, drops audio on the wire, and keeps working", async () => {
    const { sockets, session } = open();
    const abort = new AbortController();
    const out = drain(session.synthesizeStream("One.", abort.signal));
    await tick();
    await tick();
    const socket = sockets[0] as FakeSocket;
    abort.abort();
    await out;
    await tick();
    expect(socket.json().at(-1)).toEqual({ type: "Cancel" });
    const next = drain(session.synthesizeStream("Two."));
    await tick();
    await tick();
    socket.emit({ type: "Audio", flush_id: 0, audio: audio([9, 9]) });
    socket.emit({ type: "Cancelled", audio_duration_seconds: 0.1 });
    socket.emit({ type: "Audio", flush_id: 1, audio: audio([1, 2]) });
    socket.emit({ type: "FlushDone", flush_id: 1, audio_duration_ms: 100 });
    expect((await next).map((c) => [...new Uint8Array(c)])).toEqual([[1, 2]]);
  });

  it("reopens after the idle timeout closed the session", async () => {
    const { sockets, session } = open();
    const first = drain(session.synthesizeStream("One."));
    await tick();
    await tick();
    (sockets[0] as FakeSocket).emit({ type: "FlushDone", flush_id: 0, audio_duration_ms: 0 });
    await first;
    (sockets[0] as FakeSocket).drop(3005);
    void drain(session.synthesizeStream("Two."));
    await tick();
    await tick();
    expect(sockets).toHaveLength(2);
  });
});
