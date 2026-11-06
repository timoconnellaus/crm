// React hooks over `VoiceCall`: a voice chat, and dictation into a text box.
import { useCallback, useEffect, useRef, useState } from "react";
import { VoiceCall, type VoiceCallOptions, type VoiceStatus } from "./client.ts";
import type { VoiceFacts } from "./protocol.ts";

export interface UseVoiceChat {
  active: boolean;
  status: VoiceStatus;
  /** What the person is saying, as it is heard. */
  interim: string;
  muted: boolean;
  error: string | null;
  /** True for a moment after the person spoke over a reply. */
  interrupted: boolean;
  start: (options: { pushToTalk: boolean }) => Promise<void>;
  end: () => void;
  hold: () => void;
  release: () => void;
  setMuted: (muted: boolean) => void;
  sendFacts: () => void;
  /** Test providers only. */
  fakeSay: (text: string) => void;
}

export function useVoiceChat(options: {
  url: () => string;
  facts: () => VoiceFacts;
}): UseVoiceChat {
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [interim, setInterim] = useState("");
  const [muted, setMutedState] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [interrupted, setInterrupted] = useState(false);
  const call = useRef<VoiceCall | null>(null);
  const latest = useRef(options);
  latest.current = options;

  const end = useCallback(() => {
    call.current?.end();
    call.current = null;
    setActive(false);
    setStatus("idle");
    setInterim("");
  }, []);

  const start = useCallback(
    async ({ pushToTalk }: { pushToTalk: boolean }) => {
      call.current?.end();
      setError(null);
      setActive(true);
      setMutedState(pushToTalk);
      const voice = new VoiceCall({
        url: latest.current.url(),
        kind: "talk",
        facts: () => latest.current.facts(),
        events: {
          status: setStatus,
          interim: setInterim,
          error: setError,
          muted: setMutedState,
          interrupted: () => {
            setInterrupted(true);
            setTimeout(() => setInterrupted(false), 2500);
          },
          closed: () => {
            if (call.current === voice) end();
          },
        },
      } satisfies VoiceCallOptions);
      call.current = voice;
      await voice.start({ muted: pushToTalk });
    },
    [end],
  );

  useEffect(() => () => call.current?.end(), []);

  return {
    active,
    status,
    interim,
    muted,
    error,
    interrupted,
    start,
    end,
    hold: useCallback(() => call.current?.hold(), []),
    release: useCallback(() => call.current?.release(), []),
    setMuted: useCallback((value: boolean) => call.current?.setMuted(value), []),
    sendFacts: useCallback(() => call.current?.sendFacts(), []),
    fakeSay: useCallback((text: string) => call.current?.fakeSay(text), []),
  };
}

/** How long to wait for the last words after dictation stops. */
const LAST_WORDS_MS = 2500;

export interface UseDictation {
  listening: boolean;
  /** Finished stretches and what is being heard now: what the box shows. */
  text: string;
  error: string | null;
  start: () => Promise<void>;
  /** Stops listening and resolves with everything said. */
  stop: () => Promise<string>;
  cancel: () => void;
  /** Test providers only. */
  fakeSay: (text: string) => void;
}

export function useDictation(options: { url: () => string }): UseDictation {
  const [listening, setListening] = useState(false);
  const [finals, setFinals] = useState("");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const call = useRef<VoiceCall | null>(null);
  const said = useRef("");
  const heard = useRef("");
  const onFinal = useRef<(() => void) | null>(null);
  const latest = useRef(options);
  latest.current = options;

  const close = useCallback(() => {
    call.current?.end();
    call.current = null;
    setListening(false);
    setInterim("");
    heard.current = "";
  }, []);

  const start = useCallback(async () => {
    said.current = "";
    heard.current = "";
    setFinals("");
    setInterim("");
    setError(null);
    setListening(true);
    const voice = new VoiceCall({
      url: latest.current.url(),
      kind: "dictation",
      events: {
        interim: (text) => {
          heard.current = text;
          setInterim(text);
        },
        final: (text) => {
          said.current = [said.current, text].filter(Boolean).join(" ");
          heard.current = "";
          setFinals(said.current);
          setInterim("");
          onFinal.current?.();
        },
        error: setError,
        closed: () => {
          if (call.current === voice) close();
        },
      },
    });
    call.current = voice;
    await voice.start();
  }, [close]);

  const stop = useCallback(async () => {
    const voice = call.current;
    if (voice) {
      if (heard.current) {
        // The last words are still in flight: end the turn and give them a moment.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, LAST_WORDS_MS);
          onFinal.current = () => {
            clearTimeout(timer);
            resolve();
          };
          voice.finishSpeaking();
        });
        onFinal.current = null;
      }
    }
    const text = [said.current, heard.current].filter(Boolean).join(" ");
    close();
    return text;
  }, [close]);

  useEffect(() => () => call.current?.end(), []);

  return {
    listening,
    text: [finals, interim].filter(Boolean).join(" "),
    error,
    start,
    stop,
    cancel: close,
    fakeSay: useCallback((text: string) => call.current?.fakeSay(text), []),
  };
}
