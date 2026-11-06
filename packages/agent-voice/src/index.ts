// @relationship-os/agent-voice (ADR 0349, ADR 0350): voice for an assistant. A wrapper over
// `agents/voice`, speech-to-text and text-to-speech provider interfaces, the AssemblyAI providers,
// playout truth and what gets said. No CRM imports. The browser side is `./client` and `./react`.
export { AssemblyAITranscriber } from "./assemblyai/speech-to-text.ts";
export { ASSEMBLYAI_VOICES, AssemblyAISpeech } from "./assemblyai/text-to-speech.ts";
export * from "./playout.ts";
export * from "./providers.ts";
export * from "./speech-text.ts";

/** What a message's audio playout was, as the thread stores it (ADR 0340). */
export const PLAYOUTS = ["spoken", "partly_spoken", "unspoken"] as const;
