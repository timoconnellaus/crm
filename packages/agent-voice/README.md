# @relationship-os/agent-voice

Voice for an assistant: a pinned wrapper over `agents/voice`, speech-to-text and text-to-speech
provider interfaces, the AssemblyAI providers, sentence chunking, playout truth (what was actually
heard), the dictation cleanup hook and React hooks.

Part of the assistant packages described in
[ADR 0350](../../docs/adr/0350-agent-package-boundary.md). MIT licensed (see `LICENSE`), unlike the
rest of the repository. It may import only other `@relationship-os/agent-*` packages, `zod`, `ai`,
`agents` and React (as a peer); `pnpm lint` checks this.

Status: a placeholder. Voice arrives with stage 17, W9.
