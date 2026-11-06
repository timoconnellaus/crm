// @relationship-os/agent-voice (ADR 0349, ADR 0350): voice for an assistant. The wrapper over
// `agents/voice`, the speech-to-text and text-to-speech provider interfaces, the AssemblyAI
// providers, sentence chunking, playout truth and the dictation cleanup hook arrive in stage 17's
// W9. Until then this is the package's home.

/** What a message's audio playout was, as the thread stores it (ADR 0340). */
export const PLAYOUTS = ["spoken", "partly_spoken", "unspoken"] as const;
export type Playout = (typeof PLAYOUTS)[number];
