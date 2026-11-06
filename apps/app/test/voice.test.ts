// Voice end to end in workerd (ADR 0349): a call on the person's AssistantAgent socket with the
// stand-in speech providers (AI_FAKE_VOICE) and the scripted model. A spoken turn lands in the one
// thread, the browser's played milliseconds decide what was heard, dictation only types, usage is
// logged, and erase reaches the words not heard.
import { env } from "cloudflare:workers";
import type { Principal } from "@relationship-os/auth";
import {
  type AssistantThreadState,
  fakeModels,
  invokeByName,
  resolveActingUser,
  type TranscriptItem,
  type VoicePrefs,
} from "@relationship-os/core";
import { createCrmDb } from "@relationship-os/db";
import { describe, expect, it } from "vitest";
import { type AssistantHttpEnv, handleSocket, handleState, threadStub } from "../src/server/assistant/http.ts";
import { speechProviders, voiceContextFor } from "../src/server/assistant/voice.ts";

const ORIGIN = "https://crm.test";
const appEnv = env as unknown as AssistantHttpEnv;
const db = createCrmDb(env.DB);

let n = 0;
async function member() {
  n += 1;
  const principal: Principal = {
    userId: `voice-${Date.now()}-${n}`,
    email: `voice-${Date.now()}-${n}@example.com`,
    name: `Voice tester ${n}`,
    roles: [],
  };
  const user = await resolveActingUser(db, principal);
  return { principal, user };
}

type User = Awaited<ReturnType<typeof member>>["user"];

function as(user: User) {
  return {
    actor: "human" as const,
    user,
    origin: { surface: "ui" as const },
    db,
    ...voiceContextFor(appEnv as never, db),
  };
}

interface Frame {
  type: string;
  status?: string;
  text?: string;
  turn?: number;
}

/** A voice socket, collecting what the server sends. */
async function voiceSocket(principal: Principal, kind: "talk" | "dictation") {
  const response = await handleSocket(
    new Request(`${ORIGIN}/api/assistant/socket?call=${kind}`, {
      headers: { upgrade: "websocket", origin: ORIGIN },
    }),
    appEnv,
    principal,
  );
  expect(response.status).toBe(101);
  const ws = response.webSocket;
  if (!ws) throw new Error("no WebSocket");
  ws.accept();
  const frames: Frame[] = [];
  let audioBytes = 0;
  ws.addEventListener("message", (message) => {
    if (typeof message.data === "string") frames.push(JSON.parse(message.data) as Frame);
    else audioBytes += (message.data as unknown as Blob).size;
  });
  const until = async (test: (f: Frame) => boolean, from = 0) => {
    for (let i = 0; i < 1000; i++) {
      const found = frames.slice(from).find(test);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out: ${JSON.stringify(frames.slice(-5))}`);
  };
  const send = (frame: unknown) => ws.send(JSON.stringify(frame));
  send({ type: "start_call" });
  await until((f) => f.type === "status" && f.status === "listening");
  return { ws, frames, until, send, audio: () => audioBytes };
}

async function state(principal: Principal): Promise<AssistantThreadState> {
  const response = await handleState(new Request(`${ORIGIN}/api/assistant/thread`), appEnv, principal);
  return (await response.json()) as AssistantThreadState;
}

async function settled(principal: Principal, test: (items: TranscriptItem[]) => boolean) {
  for (let i = 0; i < 500; i++) {
    const { items, running } = await state(principal);
    if (!running && test(items)) return items;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`thread never settled: ${JSON.stringify((await state(principal)).items)}`);
}

const replyOf = (items: TranscriptItem[]) =>
  items.findLast((i) => i.kind === "assistant") as Extract<TranscriptItem, { kind: "assistant" }>;

/** Speaks and waits until the server has sent all the reply's audio. */
async function speak(call: Awaited<ReturnType<typeof voiceSocket>>, text: string) {
  const from = call.frames.length;
  call.send({ type: "voice.fake_say", text });
  const reply = await call.until((f) => f.type === "voice.reply", from);
  await call.until((f) => f.type === "status" && f.status === "listening", from);
  return reply.turn as number;
}

describe("voice chat", () => {
  it("puts a spoken turn in the one thread, marked as voice, exactly as transcribed", async () => {
    const { principal } = await member();
    const call = await voiceSocket(principal, "talk");
    call.send({ type: "voice.facts", canSeeCards: true });
    const turn = await speak(call, "um so whats overdue today");
    expect(call.audio()).toBeGreaterThan(0);
    call.send({ type: "voice.played", turn, playedMs: 600_000 });
    const items = await settled(principal, (i) => Boolean(replyOf(i)?.playout));
    const user = items.find((i) => i.kind === "user");
    expect(user).toMatchObject({ text: "um so whats overdue today", via: "voice" });
    const reply = replyOf(items);
    expect(reply.spoken).toBe(true);
    expect(reply.playout).toEqual({ state: "spoken" });
    // The model was told it was spoken, and that the screen is visible: a short version first.
    expect(reply.text).toContain("<say>Here is the short version.</say>");
    call.ws.close();
  });

  it("speaks only the short version when the person can see the chat", async () => {
    const { principal } = await member();
    const call = await voiceSocket(principal, "talk");
    call.send({ type: "voice.facts", canSeeCards: true });
    await speak(call, "hello");
    const shortBytes = call.audio();
    const other = await member();
    const hidden = await voiceSocket(other.principal, "talk");
    hidden.send({ type: "voice.facts", canSeeCards: false });
    await speak(hidden, "hello");
    expect(hidden.audio()).toBeGreaterThan(shortBytes * 2);
    const items = await settled(other.principal, (i) => Boolean(replyOf(i)));
    expect(replyOf(items).text).not.toContain("<say>");
    call.ws.close();
    hidden.ws.close();
  });

  it("records partly_spoken from the browser's played milliseconds", async () => {
    const { principal } = await member();
    const call = await voiceSocket(principal, "talk");
    call.send({ type: "voice.facts", canSeeCards: false });
    const turn = await speak(call, "hello");
    call.send({ type: "voice.played", turn, playedMs: 2000 });
    const items = await settled(principal, (i) => Boolean(replyOf(i)?.playout));
    const playout = replyOf(items).playout;
    expect(playout?.state).toBe("partly_spoken");
    if (playout?.state !== "partly_spoken") throw new Error("not partly spoken");
    expect(playout.unsaid.length).toBeGreaterThan(20);
    expect(replyOf(items).text.endsWith(playout.unsaid.slice(-20))).toBe(true);
    call.ws.close();
  });

  it("stores unspoken when the person spoke before anything played", async () => {
    const { principal } = await member();
    const call = await voiceSocket(principal, "talk");
    call.send({ type: "voice.facts", canSeeCards: false });
    const turn = await speak(call, "hello");
    call.send({ type: "voice.played", turn, playedMs: 0 });
    const items = await settled(principal, (i) => Boolean(replyOf(i)?.playout));
    expect(replyOf(items).playout).toEqual({ state: "unspoken" });
    call.ws.close();
  });

  it("works out what was heard when the socket drops before the browser reported", async () => {
    const { principal } = await member();
    const call = await voiceSocket(principal, "talk");
    call.send({ type: "voice.facts", canSeeCards: false });
    await speak(call, "hello");
    call.ws.close();
    const items = await settled(principal, (i) => Boolean(replyOf(i)?.playout));
    expect(replyOf(items).playout?.state).not.toBe("spoken");
  });

  it("logs usage per person and role, counts only", async () => {
    const { principal, user } = await member();
    const call = await voiceSocket(principal, "talk");
    const turn = await speak(call, "hello there");
    call.send({ type: "voice.played", turn, playedMs: 600_000 });
    await settled(principal, (i) => Boolean(replyOf(i)?.playout));
    call.ws.close();
    let rows: { role: string; audio_seconds: number; characters: number }[] = [];
    for (let i = 0; i < 200 && rows.length < 2; i++) {
      rows = await db.query
        .selectFrom("core_voice_usage")
        .select(["role", "audio_seconds", "characters"])
        .where("user_id", "=", user.id)
        .execute();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(rows.find((r) => r.role === "transcribe")?.audio_seconds).toBeGreaterThan(0);
    expect(rows.find((r) => r.role === "speak")?.characters).toBeGreaterThan(0);
  });

  it("erases the words not heard along with the message", async () => {
    const { principal, user } = await member();
    const call = await voiceSocket(principal, "talk");
    call.send({ type: "voice.facts", canSeeCards: false });
    const turn = await speak(call, "hello");
    call.send({ type: "voice.played", turn, playedMs: 2000 });
    const items = await settled(principal, (i) => Boolean(replyOf(i)?.playout));
    const playout = replyOf(items).playout as { unsaid: string };
    const word = playout.unsaid.split(" ").find((w) => /^[a-z]{5,}$/i.test(w)) as string;
    const stub = await threadStub(appEnv.ASSISTANT as never, user.id);
    await stub.scrub({ terms: [], names: [word] });
    const after = await settled(principal, (i) => Boolean(replyOf(i)));
    expect(JSON.stringify(replyOf(after).playout)).not.toContain(word);
    call.ws.close();
  });
});

describe("dictation", () => {
  it("sends words back to the box and starts no turn", async () => {
    const { principal } = await member();
    const call = await voiceSocket(principal, "dictation");
    call.send({ type: "voice.fake_say", text: "add a task to call Lena" });
    const final = await call.until((f) => f.type === "dictation.final");
    expect(final.text).toBe("add a task to call Lena");
    await call.until((f) => f.type === "transcript_interim");
    expect((await state(principal)).items).toEqual([]);
    call.ws.close();
  });

  it("ends a stretch early when the person stops", async () => {
    const { principal } = await member();
    const call = await voiceSocket(principal, "dictation");
    call.send({ type: "voice.fake_say", text: "still talking..." });
    await call.until((f) => f.type === "transcript_interim" && Boolean(f.text));
    call.send({ type: "voice.release" });
    const final = await call.until((f) => f.type === "dictation.final");
    expect(final.text).toBe("still talking");
    call.ws.close();
  });

  it("cleans up with the role, and keeps the words when the model answers instead", async () => {
    const { user } = await member();
    const fake = fakeModels();
    const context = {
      ...as(user),
      models: {
        run: async (role: never, messages: never) => ({
          text: await fake.run(role, messages),
          model: "fake",
        }),
      } as never,
    };
    const cleaned = (await invokeByName(
      "dictation.cleanup",
      { text: "um add a task for Lena", names: ["Lena Fischer"] },
      context,
    )) as { text: string; changed: boolean };
    expect(cleaned).toEqual({ text: "add a task for Lena", changed: true });
    const noisy = {
      ...context,
      models: { run: async () => ({ text: "x".repeat(400), model: "m" }) } as never,
    };
    const kept = (await invokeByName(
      "dictation.cleanup",
      { text: "short words", names: [] },
      noisy,
    )) as { text: string; changed: boolean };
    expect(kept).toEqual({ text: "short words", changed: false });
  });
});

describe("voice settings", () => {
  const desk = "desk-device-1";
  const phone = "phone-device-1";
  const prefs = (user: User, deviceId: string) =>
    invokeByName("voice.prefs.get", { deviceId }, as(user)) as Promise<VoicePrefs>;

  it("needs a voice and mode at first setup", async () => {
    const { user } = await member();
    await expect(
      invokeByName("voice.prefs.update", { deviceId: desk, deviceLabel: "Mac" }, as(user)),
    ).rejects.toThrow("First setup");
  });

  it("seeds every device from first setup; a later change sticks to its device", async () => {
    const { user } = await member();
    expect((await prefs(user, desk)).configured).toBe(false);
    const voiceId = (await prefs(user, desk)).voices[0]?.id as string;
    await invokeByName(
      "voice.prefs.update",
      { deviceId: desk, deviceLabel: "Mac", voiceId, mode: "hands_free" },
      as(user),
    );
    expect(await prefs(user, phone)).toMatchObject({ configured: true, mode: "hands_free" });
    await invokeByName(
      "voice.prefs.update",
      { deviceId: phone, deviceLabel: "iPhone", mode: "push_to_talk" },
      as(user),
    );
    expect((await prefs(user, phone)).mode).toBe("push_to_talk");
    const desktop = await prefs(user, desk);
    expect(desktop.mode).toBe("hands_free");
    expect(desktop.defaultMode).toBe("hands_free");
    expect(desktop.devices.map((d) => [d.label, d.mode, d.thisDevice]).sort()).toEqual([
      ["Mac", "hands_free", true],
      ["iPhone", "push_to_talk", false],
    ]);
    expect((await prefs(user, "new-device-9")).mode).toBe("hands_free");
  });

  it("refuses a speed the provider cannot do, and says so in its capability flag", async () => {
    const { user } = await member();
    const before = await prefs(user, desk);
    expect(before.supportsSpeed).toBe(false);
    await expect(
      invokeByName(
        "voice.prefs.update",
        { deviceId: desk, deviceLabel: "Mac", speed: 1.2 },
        as(user),
      ),
    ).rejects.toThrow("no speed");
  });

  it("is off until AI_KEY_ASSEMBLYAI is set", async () => {
    expect(speechProviders({})).toBeNull();
    expect(voiceContextFor({}, db)).toEqual({});
    expect(speechProviders({ AI_KEY_ASSEMBLYAI: "k" })).not.toBeNull();
    const { user } = await member();
    const off = { ...as(user), voice: undefined };
    expect(
      ((await invokeByName("voice.prefs.get", { deviceId: desk }, off)) as VoicePrefs).available,
    ).toBe(false);
    await expect(
      invokeByName("voice.prefs.update", { deviceId: desk, deviceLabel: "Mac" }, off),
    ).rejects.toThrow("not switched on");
  });

  it("previews a voice as a WAV file", async () => {
    const { user } = await member();
    const voiceId = (await prefs(user, desk)).voices[0]?.id as string;
    const out = (await invokeByName("voice.preview", { voiceId }, as(user))) as { audio: string };
    expect(atob(out.audio).startsWith("RIFF")).toBe(true);
  });
});
