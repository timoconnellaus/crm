# ADR 0349: Voice runs on the Agents SDK voice module, with AssemblyAI for speech-to-text and speech

Status: Accepted (2026-11-06). Stage 17 spec: [`docs/stages/17-assistant.md`](../stages/17-assistant.md),
W9. Builds on [ADR 0340](0340-one-assistant-thread-per-user.md) and the model roles in
[ADR 0351](0351-assistant-model-roles.md). AI calls go through AI Gateway first
([ADR 0203](0203-gateway-first-model-registry.md)).

## Context
The user wants to talk to the assistant: hands-free on a phone, push-to-talk at a desk, and
dictation into the chat box. Spoken turns must land in the same thread as typed ones, use the same
tools and approvals, and record what the person actually heard, since a reply can be cut off.

The options looked at while writing the spec:
- **Cloudflare RealtimeKit's AI agent** can join a meeting and listen, but its agent cannot speak
  yet, so it cannot run a conversation.
- **Speech-to-speech models** (one model listens and answers) tie the assistant to one provider,
  skip our model roles, and run their own loop beside our turn engine, tools and approvals.
- **The Agents SDK voice module** (`agents/voice`: `withVoice`, `withVoiceInput`) streams audio
  over the agent's own WebSocket with pluggable speech-to-text and text-to-speech providers, so
  our turn engine stays in the middle.

## Decision
1. **`agent-voice` wraps `agents/voice`**, version pinned, on the `AssistantAgent` WebSocket. Each
   spoken turn goes through the normal turn engine into the one thread (`via: voice`); the SDK's
   separate voice transcript is not used.
2. **Speech-to-text**: model role `transcribe`, provider **AssemblyAI** streaming, using its own
   end-of-turn detection. The only provider for now.
3. **Text-to-speech**: model role `speak`, provider **AssemblyAI** (`assemblyai-tts-1`, launched
   2026-10-27: streaming WebSocket, word timestamps, a cancel message for barge-in, 4,000+ voices,
   $15 per million characters). It has no speed control yet, so the speed setting is shown only when
   the provider reports the capability.
4. **One BYOK key, `AI_KEY_ASSEMBLYAI`, for both. Voice is off until it is set.**
5. **Through AI Gateway if it can proxy the streaming sockets.** This is an open check for the
   build: whether AI Gateway can carry AssemblyAI's streaming WebSockets with our
   gateway's logging and BYOK. If it cannot, the fallback is a **direct call** to each provider,
   with the key held as a Workers secret, and usage (seconds of audio in, characters out, per
   user and role) logged by us in the same place as other AI usage. The builder records the result
   of the check, and the exception if taken, as a dated amendment to this ADR.
6. **First use** asks for a voice, a speed and a mode (push-to-talk or hands-free). Voice and speed
   are per user. **Mode is per device**: the first setup seeds every device; a change on one device
   sticks to that device.
7. **Barge-in** stops playback on the first transcribed word. The browser reports played
   milliseconds per line; the thread stores `spoken`, `partly_spoken` (with `unsaid`) or
   `unspoken`, and the model sees only what was heard.
8. **Sentence chunking.** Replies are chunked by sentence and each sentence is flushed to speech.
   When the person can see the screen the assistant speaks a short version and the full answer
   and cards go in the chat; when they cannot (a full-screen voice view on a phone) it reads the
   content. The client sends this as a display fact each turn, and a stated preference overrides
   it.
9. **Voice messages** show in italics with a mic icon, exactly as transcribed, and the model is
   told they were spoken.
10. **Dictation** (the mic in the chat box) streams words into the box. On stop a cleanup pass
    (role `dictation.cleanup`, no thinking) removes fillers, fixes punctuation and applies
    self-corrections, given the names of records on screen and recently mentioned ones. The
    cleaned text replaces the raw text with "Undo cleanup". Sent messages look typed.
11. **Settings → Voice**: voice picker, speed, the mode for this device, and the list of devices.

## Why
- The voice module keeps one turn engine, one thread and one approval path for typed and spoken
  turns.
- Separate speech-to-text and text-to-speech providers can be chosen per role, and the text model
  stays whatever the deployment uses.
- Recording what was heard keeps the model from assuming the person heard a reply they cut off.

## Consequences
- One more third-party provider, with a BYOK key. A deployment without it has no voice.
- If the gateway cannot proxy the sockets, these become the one exception to "all AI calls through
  AI Gateway", with our own usage log standing in for the gateway's.
- `agents/voice` is young; pinning and wrapping it in `agent-voice` limits the blast radius of an
  upstream change.

## Alternatives considered
- **ElevenLabs for speech.** Chosen first, then replaced on 2026-11-06 by AssemblyAI-TTS-1: one
  provider and key for both directions, and streaming built for voice agents. ElevenLabs
  stays possible later behind the `speak` provider interface.
- **RealtimeKit's agent.** Rejected for now: it cannot speak yet.
- **A speech-to-speech model.** Rejected: one provider, outside our roles, turn engine and
  approvals.
- **The browser's Web Speech API.** Rejected: quality and barge-in vary by browser, and it gives us
  no control over where audio goes.
- **A second provider for each side now.** Out of scope; the provider interfaces in `agent-voice`
  leave room for it.
