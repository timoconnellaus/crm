# @relationship-os/agent-voice

Voice for an assistant, as [ADR 0349](../../docs/adr/0349-voice-on-agents-voice.md) describes:

- `.`: `withAssistantVoice`, a wrapper over `agents/voice` (`agents` pinned) that puts the host's
  own turn engine in the middle; speech-to-text and text-to-speech provider interfaces; the
  AssemblyAI providers; playout truth (what was actually heard); choosing what gets said.
- `./client` and `./react`: the browser's call, with barge-in and played milliseconds, and the
  `useVoiceChat` and `useDictation` hooks.
- `./text`: the pure text helpers, without any audio code.
- `./fake`: stand-in providers for tests and local e2e.

Sentence chunking is the SDK's; each sentence is flushed to speech on its own.

Part of the assistant packages described in
[ADR 0350](../../docs/adr/0350-agent-package-boundary.md). MIT licensed (see `LICENSE`), unlike the
rest of the repository. It may import only other `@relationship-os/agent-*` packages, `zod`, `ai`,
`agents` and React (as a peer); `pnpm lint` checks this.
