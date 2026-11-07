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
- AssemblyAI says speed control, emotion tags and a pronunciation dictionary are coming. When they
  ship: show the speed setting (capability flag), seed the pronunciation dictionary from CRM names
  (people, organisations) so they are said right, and let the model add emotion tags only from a
  small allow-list.
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

## Amendment (2026-11-06, W9 as built)

**The gateway check (decision 5): the sockets go direct, with usage logged by us.**
- AssemblyAI is not among AI Gateway's [24 listed providers](https://developers.cloudflare.com/ai-gateway/usage/providers/),
  and the [Realtime WebSockets API](https://developers.cloudflare.com/ai-gateway/usage/websockets-api/realtime-api/)
  names only OpenAI, Google AI Studio, Cartesia, ElevenLabs, Fal AI and Deepgram (Workers AI).
- [Custom providers](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/)
  are documented for HTTPS only: `base_url` must be HTTPS and the page describes `POST` requests.
  It says nothing about WebSockets.
- The non-realtime WebSocket API wraps JSON request and response calls, which is not what a
  stream of binary audio with server turn events needs, and the Universal Endpoint it belongs to is
  deprecated.
- Tested: a WebSocket upgrade to `gateway.ai.cloudflare.com` with a dummy account for `openai`,
  `assemblyai` and `custom-foo` answers 401 (code 2009) for all three, so authentication comes
  before provider routing and an unauthenticated probe cannot settle it. No gateway account or
  token was available to the build, so **an authenticated test of a `custom-` provider over `wss:`
  was not run.** The decision rests on the documentation. Both providers take a `host` option, so
  moving to the gateway later, if it gains support, is a small change.
- Direct calls from workerd to `wss://streaming.assemblyai.com/v3/ws` and
  `wss://tts.us.assemblyai.com/v1/ws` were tested with the real key (`apps/app/test/voice-live.test.ts`,
  opt-in): speech with word timings, recognition of that speech, and `Cancel`.

So this is the one exception to "all AI calls through AI Gateway". The key is the Workers secret
`AI_KEY_ASSEMBLYAI`, sent in an `Authorization` header, never in a URL. Migration 0362 adds
`core_voice_usage`: seconds of audio in and characters out, per day, person, role and provider.
`core_ai_usage` has no person and counts tokens, so speech has its own table beside it, and
`ai.usage` returns both.

**Other changes from the decisions above:**
- **`withVoice` only, not `withVoiceInput`** (decision 1). Both claim the voice protocol, so they
  cannot sit on one class. Dictation is a `withVoice` call whose utterances `afterTranscribe` sends
  back to the browser instead of starting a turn. `agents` stays pinned at 0.33.0; no upgrade was
  needed.
- **A call has its own socket** to the same object and path (`/api/assistant/socket?call=talk` or
  `?call=dictation`). The thread's socket stays as it was and thread frames are not sent to voice
  sockets. One device talks at a time: a new call ends the old one, because the SDK's `tts` is one
  per object.
- **Barge-in** (decision 7) fires on a turn's first word from AssemblyAI's `Turn` messages, not on
  its voice-activity `SpeechStarted`, and the SDK's loudness check is turned off. The browser stops
  playback itself on that word, because the SDK sends no interrupt once the server has sent all its
  audio, which is usually long before playback ends.
- **Played milliseconds**: `VoiceClient` cannot report them, so `agent-voice`'s client listens on
  the transport and keeps a clock with the same scheduling (`PlayoutClock`). If the socket drops
  before a report, the server assumes it played from the first audio until then.
- **What the model sees** (decision 7): `heardReply` in `agent-core` cuts a read-out reply where it
  stopped. In a short-version reply only the `<say>` block is cut, because the answer after it was
  on the person's screen.
- **Spoken version** (decision 8): the model writes it in a `<say>` block at the start of its reply,
  asked for in the tail so the cached prefix does not change. Saying "read me everything" makes it
  put the whole answer in the block; "Read everything out" in Settings → Voice is the lasting form.
- **Model**: the `transcribe` role's `universal-streaming` maps to AssemblyAI's
  `universal-streaming-english`, so voice is English only for now.
- **Voice list**: AssemblyAI has no listing API, so `agent-voice` carries a short list. The mockup's
  names were placeholders.
- **`voice.preview`** is a fourth operation, for the picker's Preview button.
- **A spoken approval** is a spoken turn like any other today. Checking a spoken yes needs
  `approval.decide` and `approval.intent` from W5.


## Amendment 2026-11-07: call limits

AssemblyAI bills a stream for as long as its socket is open, heard or not, so a tab left open would
keep costing. A call now ends after 5 minutes with nothing said, and after 60 minutes regardless.
