// Voice wiring for ros-app (ADR 0349): which speech providers a deployment has, what a call runs
// with, the speech part of the operations' context, and the usage log. Voice is off until
// AI_KEY_ASSEMBLYAI is set. The sockets go straight to AssemblyAI with the key as a Workers secret
// (AI Gateway cannot carry them: ADR 0349's amendment), so usage is counted here.
import {
  AssemblyAISpeech,
  AssemblyAITranscriber,
  pcmToWav,
  type SpeechProviders,
  type SpeechUsage,
  type VoiceCallPlan,
} from "@relationship-os/agent-voice";
import { fakeSpeechProviders } from "@relationship-os/agent-voice/fake";
import {
  type ActingUser,
  invokeByName,
  type ModelRunner,
  PROVIDER_INFO,
  recordVoiceUsage,
  type VoicePrefs,
  type VoiceRuntime,
} from "@relationship-os/core";
import { type CrmDb, createCrmDb } from "@relationship-os/db";
import { aiContextFor } from "../ai.ts";
import type { OperationsEnv } from "../operations.ts";

export interface VoiceEnv {
  AI_KEY_ASSEMBLYAI?: string;
  AI_FAKE_VOICE?: string;
}

const PREVIEW_TEXT = "Hi, this is how I sound. Let me know what you need.";

/** The stand-ins are one set per isolate, so a test can reach what they heard. */
let fakes: ReturnType<typeof fakeSpeechProviders> | null = null;

/** The deployment's speech providers, or null when voice is off. */
export function speechProviders(
  env: VoiceEnv,
  models: { transcribe: string; speak: string } = {
    transcribe: "universal-streaming",
    speak: "assemblyai-tts-1",
  },
): SpeechProviders | null {
  if (env.AI_FAKE_VOICE === "true") {
    fakes ??= fakeSpeechProviders();
    return fakes;
  }
  const apiKey = env.AI_KEY_ASSEMBLYAI?.trim();
  if (!apiKey) return null;
  return {
    speechToText: new AssemblyAITranscriber({ apiKey, model: models.transcribe }),
    textToSpeech: new AssemblyAISpeech({ apiKey, model: models.speak }),
  };
}

/** The models the `transcribe` and `speak` roles resolve to. */
async function speechModels(models: ModelRunner | undefined) {
  const roles = await models?.roles?.();
  return roles?.transcribe && roles.speak
    ? { transcribe: roles.transcribe.model, speak: roles.speak.model }
    : undefined;
}

/** What a call runs with: the person's settings, or null when voice is off. */
export async function voiceCallPlan(
  env: OperationsEnv & VoiceEnv,
  user: ActingUser,
): Promise<VoiceCallPlan | null> {
  const db = createCrmDb(env.DB);
  const ai = aiContextFor(env, db);
  const providers = speechProviders(env, await speechModels(ai.models));
  if (!providers) return null;
  const prefs = (await invokeByName(
    "voice.prefs.get",
    {},
    { actor: "human", user, origin: { surface: "ui" }, db, ...ai },
  )) as VoicePrefs;
  const { textToSpeech } = providers;
  return {
    providers,
    voiceId: prefs.voiceId ?? textToSpeech.voices()[0]?.id ?? "",
    ...(textToSpeech.capabilities.supportsSpeed ? { speed: prefs.speed } : {}),
    // Reading everything out is a stated preference; the short version is the default.
    ...(prefs.readOut === "full" ? { readOut: "full" as const } : {}),
  };
}

export async function recordSpeechUsage(
  env: OperationsEnv,
  userId: string,
  usage: SpeechUsage,
): Promise<void> {
  await recordVoiceUsage(createCrmDb(env.DB).query, {
    userId,
    provider: PROVIDER_INFO.assemblyai.id,
    ...usage,
  });
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** The speech part of the operations' context. Absent while voice is off. */
export function voiceContextFor(env: VoiceEnv, db: CrmDb): { voice?: VoiceRuntime } {
  const providers = speechProviders(env);
  if (!providers) return {};
  const { textToSpeech } = providers;
  return {
    voice: {
      supportsSpeed: textToSpeech.capabilities.supportsSpeed,
      voices: textToSpeech.voices(),
      async preview(voiceId, userId) {
        const session = textToSpeech.open({ voiceId });
        const chunks: Uint8Array[] = [];
        try {
          for await (const chunk of session.synthesizeStream(PREVIEW_TEXT)) {
            chunks.push(new Uint8Array(chunk));
          }
          const usage = session.takeUsage();
          await recordVoiceUsage(db.query, {
            userId,
            provider: PROVIDER_INFO.assemblyai.id,
            ...usage,
          });
        } finally {
          session.close();
        }
        const pcm = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
        let at = 0;
        for (const chunk of chunks) {
          pcm.set(chunk, at);
          at += chunk.byteLength;
        }
        return toBase64(pcmToWav(pcm, session.sampleRate));
      },
    },
  };
}
