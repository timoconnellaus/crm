// @relationship-os/agent-voice (ADR 0349, ADR 0350): voice for an assistant. A wrapper over
// `agents/voice`, speech-to-text and text-to-speech provider interfaces, the AssemblyAI providers,
// playout truth and what gets said. No CRM imports. The browser side is `./client` and `./react`.
export { AssemblyAITranscriber } from "./assemblyai/speech-to-text.ts";
export { ASSEMBLYAI_VOICES, AssemblyAISpeech } from "./assemblyai/text-to-speech.ts";
export {
  type SpokenTurn,
  type VoiceCallPlan,
  type VoiceHost,
  withAssistantVoice,
} from "./mixin.ts";
export * from "./playout.ts";
export { PlayoutClock } from "./playout-clock.ts";
export * from "./protocol.ts";
export * from "./providers.ts";
export * from "./speech-text.ts";
export { pcmToWav } from "./wav.ts";
