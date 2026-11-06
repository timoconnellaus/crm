// Voice in the app (ADR 0349): the call, its first-use setup, the bar above the chat box, the
// full-screen view on a phone, and dictation into the chat box. A call survives moving between
// pages, because it lives here, above the routes. What is said lands in the one thread, so the
// transcript needs nothing from here.
import type { VoiceFacts } from "@relationship-os/agent-voice/client";
import { type UseVoiceChat, useDictation, useVoiceChat } from "@relationship-os/agent-voice/react";
import { splitSpoken } from "@relationship-os/agent-voice/text";
import type { CoreOutput } from "@relationship-os/core";
import type { AssistantContext, TranscriptItem } from "@relationship-os/core/client";
import { Button } from "@relationship-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@relationship-os/ui/components/dialog";
import { Label } from "@relationship-os/ui/components/label";
import { cn } from "@relationship-os/ui/lib/utils";
import {
  AudioLinesIcon,
  HandIcon,
  LoaderCircleIcon,
  MaximizeIcon,
  MicIcon,
  MicOffIcon,
  MinimizeIcon,
  PhoneOffIcon,
  PlayIcon,
  SquareIcon,
  Undo2Icon,
} from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { callOp } from "#/lib/operations";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";
import { useAssistant } from "./assistant-provider.tsx";
import { useThread } from "./thread-provider.tsx";

type VoicePrefs = CoreOutput<"voice.prefs.get">;
export type VoiceMode = VoicePrefs["mode"];

const DEVICE_KEY = "ros.voice.device";

/** This browser's id in the device list. */
export function voiceDeviceId(): string {
  try {
    const known = localStorage.getItem(DEVICE_KEY);
    if (known) return known;
    const id = crypto.randomUUID().replaceAll("-", "");
    localStorage.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    // No storage (a private window): this visit counts as its own device.
    return "unsaved-device";
  }
}

/** "Mac · Chrome": enough to tell devices apart in Settings → Voice. */
export function voiceDeviceLabel(): string {
  const agent = navigator.userAgent;
  const device = /iPhone/.test(agent)
    ? "iPhone"
    : /iPad/.test(agent)
      ? "iPad"
      : /Android/.test(agent)
        ? "Android"
        : /Mac/.test(agent)
          ? "Mac"
          : /Windows/.test(agent)
            ? "Windows"
            : "Linux";
  const browser = /Edg\//.test(agent)
    ? "Edge"
    : /Firefox\//.test(agent)
      ? "Firefox"
      : /Chrome\//.test(agent)
        ? "Chrome"
        : /Safari\//.test(agent)
          ? "Safari"
          : "Browser";
  return `${device} · ${browser}`;
}

function socketUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/api/assistant/socket`;
}

interface VoiceView {
  prefs: VoicePrefs | undefined;
  chat: UseVoiceChat;
  mode: VoiceMode;
  /** The chat is hidden behind the full-screen view, so everything is read out. */
  fullScreen: boolean;
  setFullScreen: (on: boolean) => void;
  /** Starts a call, or the first-use setup when there are no settings yet. */
  begin: () => void;
  switchMode: (mode: VoiceMode) => Promise<void>;
  setupOpen: boolean;
  setSetupOpen: (open: boolean) => void;
}

const VoiceContext = createContext<VoiceView | null>(null);

function useVoice(): VoiceView {
  const view = useContext(VoiceContext);
  if (!view) throw new Error("useVoice needs a VoiceProvider");
  return view;
}

export function VoiceProvider({ children }: { children: ReactNode }) {
  const assistant = useAssistant();
  const deviceId = useMemo(voiceDeviceId, []);
  const prefs = useOp("voice.prefs.get", { deviceId }, { staleTime: 5 * 60_000 });
  const update = useOpMutation("voice.prefs.update", { invalidates: ["voice."] });
  const [fullScreen, setFullScreen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);

  const chatShown = assistant.open || assistant.path.startsWith("/assistant");
  const facts = useRef<() => VoiceFacts>(() => ({ canSeeCards: true }));
  facts.current = () => ({
    // Cards are in the chat: the panel or /assistant, unless the full-screen view covers them.
    canSeeCards: !fullScreen && chatShown && document.visibilityState === "visible",
    context: assistant.pageContext(),
  });
  const chat = useVoiceChat({ url: socketUrl, facts: () => facts.current() });
  const { sendFacts, active } = chat;

  // The display fact changes mid-call when the panel closes or the view goes full screen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each of these changes what is seen.
  useEffect(() => {
    if (active) sendFacts();
  }, [active, sendFacts, fullScreen, assistant.open, assistant.path]);

  const data = prefs.data;
  const mode = data?.mode ?? "push_to_talk";

  const startWith = useCallback(
    async (pushToTalk: boolean) => {
      // Keeps this device in the list, with its last use.
      await update.mutateAsync({ deviceId, deviceLabel: voiceDeviceLabel() });
      await chat.start({ pushToTalk });
    },
    [chat.start, deviceId, update.mutateAsync],
  );

  const begin = useCallback(() => {
    if (!data?.configured) {
      setSetupOpen(true);
      return;
    }
    startWith(data.mode === "push_to_talk").catch((error: unknown) =>
      toast.error(errorMessage(error)),
    );
  }, [data, startWith]);

  const switchMode = useCallback(
    async (next: VoiceMode) => {
      await update.mutateAsync({ deviceId, deviceLabel: voiceDeviceLabel(), mode: next });
      chat.setMuted(next === "push_to_talk");
    },
    [chat.setMuted, deviceId, update.mutateAsync],
  );

  const view = useMemo<VoiceView>(
    () => ({
      prefs: data,
      chat,
      mode,
      fullScreen,
      setFullScreen,
      begin,
      switchMode,
      setupOpen,
      setSetupOpen,
    }),
    [data, chat, mode, fullScreen, begin, switchMode, setupOpen],
  );

  return (
    <VoiceContext.Provider value={view}>
      {children}
      <VoiceFullScreen />
      {/* The chat box holds the bar; with the chat closed, the call still needs its controls. */}
      {chat.active && !chatShown && !fullScreen && (
        <div className="fixed right-4 bottom-4 z-40 w-80 max-w-[calc(100vw-2rem)] bg-background">
          <VoiceBar />
        </div>
      )}
      {data?.available && (
        <VoiceSetup
          open={setupOpen}
          onOpenChange={setSetupOpen}
          prefs={data}
          deviceId={deviceId}
          onDone={(next) => {
            startWith(next === "push_to_talk").catch((error: unknown) =>
              toast.error(errorMessage(error)),
            );
          }}
        />
      )}
    </VoiceContext.Provider>
  );
}

/** Plays a voice's sample. */
export function useVoicePreview() {
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const play = useCallback(async (voiceId: string) => {
    audio.current?.pause();
    setPlaying(voiceId);
    try {
      const sample = await callOp("voice.preview", { voiceId });
      const element = new Audio(`data:audio/wav;base64,${sample.audio}`);
      audio.current = element;
      element.onended = () => setPlaying(null);
      await element.play();
    } catch (error) {
      setPlaying(null);
      toast.error(errorMessage(error));
    }
  }, []);
  return { playing, play };
}

export function VoiceList({
  prefs,
  value,
  onChange,
}: {
  prefs: VoicePrefs;
  value: string | null;
  onChange: (voiceId: string) => void;
}) {
  const preview = useVoicePreview();
  return (
    <ul className="divide-y rounded-md border" data-testid="voice-list">
      {prefs.voices.map((voice) => (
        <li key={voice.id} className="flex items-center gap-2 p-2">
          <label className="flex flex-1 cursor-pointer items-center gap-2 text-sm">
            <input
              type="radio"
              name="voice"
              checked={value === voice.id}
              onChange={() => onChange(voice.id)}
              data-testid={`voice-${voice.id}`}
            />
            <span className="font-medium">{voice.name}</span>
            <span className="text-muted-foreground">{voice.description}</span>
          </label>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void preview.play(voice.id)}
            aria-label={`Preview ${voice.name}`}
          >
            {preview.playing === voice.id ? (
              <LoaderCircleIcon className="animate-spin" />
            ) : (
              <PlayIcon />
            )}
            Preview
          </Button>
        </li>
      ))}
    </ul>
  );
}

export function ModeChoice({
  value,
  onChange,
}: {
  value: VoiceMode;
  onChange: (mode: VoiceMode) => void;
}) {
  const options: { id: VoiceMode; title: string; body: string }[] = [
    {
      id: "push_to_talk",
      title: "Push to talk",
      body: "Hold Space or the talk button while you speak. Good for open offices.",
    },
    {
      id: "hands_free",
      title: "Hands-free",
      body: "I listen until you end the chat. Start talking any time to interrupt me.",
    },
  ];
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {options.map((option) => (
        <label
          key={option.id}
          className={cn(
            "cursor-pointer rounded-md border p-3 text-sm",
            value === option.id && "border-primary bg-primary/5",
          )}
        >
          <input
            type="radio"
            name="voice-mode"
            className="sr-only"
            checked={value === option.id}
            onChange={() => onChange(option.id)}
            data-testid={`voice-mode-${option.id}`}
          />
          <span className="block font-medium">{option.title}</span>
          <span className="block text-muted-foreground">{option.body}</span>
        </label>
      ))}
    </div>
  );
}

export function SpeedSlider({
  value,
  onChange,
}: {
  value: number;
  onChange: (speed: number) => void;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor="voice-speed">Speed {value.toFixed(1)}×</Label>
      <input
        id="voice-speed"
        type="range"
        className="w-full"
        min={0.8}
        max={1.4}
        step={0.1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

function VoiceSetup({
  open,
  onOpenChange,
  prefs,
  deviceId,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prefs: VoicePrefs;
  deviceId: string;
  onDone: (mode: VoiceMode) => void;
}) {
  const update = useOpMutation("voice.prefs.update", { invalidates: ["voice."] });
  const [voiceId, setVoiceId] = useState<string | null>(null);
  const [speed, setSpeed] = useState(prefs.speed);
  const [mode, setMode] = useState<VoiceMode>(prefs.mode);
  const chosen = voiceId ?? prefs.voiceId ?? prefs.voices[0]?.id ?? null;

  async function finish() {
    if (!chosen) return;
    try {
      await update.mutateAsync({
        deviceId,
        deviceLabel: voiceDeviceLabel(),
        voiceId: chosen,
        mode,
        ...(prefs.supportsSpeed ? { speed } : {}),
      });
      onOpenChange(false);
      onDone(mode);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="voice-setup">
        <DialogHeader>
          <DialogTitle>Set up voice chat</DialogTitle>
          <DialogDescription>
            Pick how I sound and how you'd like to talk. You can change any of this later in
            Settings.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1">
            <Label>Voice</Label>
            <VoiceList prefs={prefs} value={chosen} onChange={setVoiceId} />
          </div>
          {prefs.supportsSpeed && <SpeedSlider value={speed} onChange={setSpeed} />}
          <div className="space-y-1">
            <Label>How you'll talk</Label>
            <ModeChoice value={mode} onChange={setMode} />
            <p className="text-xs text-muted-foreground">
              This choice starts the same on all your devices. If you change it later on one device,
              only that device changes.
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            Your browser will ask to use the microphone.
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Not now
          </Button>
          <Button
            onClick={() => void finish()}
            disabled={update.isPending}
            data-testid="voice-start"
          >
            <AudioLinesIcon />
            Start voice chat
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Run voice setup again" in Settings → Voice. */
export function useVoiceSetup(): () => void {
  const { setSetupOpen } = useVoice();
  return useCallback(() => setSetupOpen(true), [setSetupOpen]);
}

/** Starts voice chat. Shown only when the deployment has voice. */
export function VoiceStartButton() {
  const { prefs, chat, begin } = useVoice();
  if (!prefs?.available || chat.active) return null;
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Start voice chat"
      title="Start voice chat"
      onClick={begin}
      data-testid="voice-chat-start"
    >
      <AudioLinesIcon />
    </Button>
  );
}

function statusLine(chat: UseVoiceChat, mode: VoiceMode): string {
  if (chat.interrupted) return "Stopped speaking. Listening";
  if (chat.interim) return chat.interim;
  switch (chat.status) {
    case "thinking":
      return "Thinking";
    case "speaking":
      return mode === "push_to_talk"
        ? "Speaking. Hold to interrupt"
        : "Speaking. Talk to interrupt";
    case "listening":
      if (mode === "hands_free") return chat.muted ? "Muted. I'm not listening." : "Listening";
      return "Hold Space or the button to talk";
    default:
      return "Connecting";
  }
}

/** Hold to talk: the button, and Space when the focus is not in a text field. */
function useHoldToTalk(enabled: boolean, chat: UseVoiceChat) {
  const [held, setHeld] = useState(false);
  const { hold, release } = chat;
  const press = useCallback(() => {
    setHeld(true);
    hold();
  }, [hold]);
  const lift = useCallback(() => {
    setHeld(false);
    release();
  }, [release]);
  useEffect(() => {
    if (!enabled) return;
    const typing = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    const down = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat || typing(event.target)) return;
      event.preventDefault();
      press();
    };
    const up = (event: KeyboardEvent) => {
      if (event.code !== "Space" || typing(event.target)) return;
      event.preventDefault();
      lift();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [enabled, press, lift]);
  return { held, press, lift };
}

function CallControls({ large }: { large?: boolean }) {
  const { chat, mode, switchMode, setFullScreen, fullScreen } = useVoice();
  const pushToTalk = mode === "push_to_talk";
  const talk = useHoldToTalk(chat.active && pushToTalk, chat);
  return (
    <div className={cn("flex flex-wrap items-center gap-2", large && "justify-center")}>
      {pushToTalk ? (
        <Button
          type="button"
          className="touch-none select-none"
          variant={talk.held ? "default" : "outline"}
          onPointerDown={talk.press}
          onPointerUp={talk.lift}
          onPointerCancel={talk.lift}
          data-testid="voice-hold"
        >
          <HandIcon />
          {talk.held ? "Release to send" : "Hold to talk"}
        </Button>
      ) : (
        <Button
          type="button"
          size="icon"
          variant="outline"
          onClick={() => chat.setMuted(!chat.muted)}
          aria-label={chat.muted ? "Unmute" : "Mute"}
          data-testid="voice-mute"
        >
          {chat.muted ? <MicOffIcon /> : <MicIcon />}
        </Button>
      )}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => void switchMode(pushToTalk ? "hands_free" : "push_to_talk")}
        data-testid="voice-switch-mode"
      >
        {pushToTalk ? "Switch to hands-free" : "Switch to push to talk"}
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="md:hidden"
        onClick={() => setFullScreen(!fullScreen)}
        aria-label={fullScreen ? "Show the chat" : "Full screen"}
        data-testid="voice-fullscreen"
      >
        {fullScreen ? <MinimizeIcon /> : <MaximizeIcon />}
      </Button>
      <Button
        type="button"
        size="icon"
        variant="destructive"
        onClick={() => {
          setFullScreen(false);
          chat.end();
        }}
        aria-label="End voice chat"
        data-testid="voice-end"
      >
        <PhoneOffIcon />
      </Button>
    </div>
  );
}

/** Test hook: lets e2e speak into the stand-in transcriber. */
function useFakeSay(chat: UseVoiceChat) {
  useEffect(() => {
    const target = window as unknown as { __voiceSay?: (text: string) => void };
    target.__voiceSay = chat.fakeSay;
    return () => {
      target.__voiceSay = undefined;
    };
  }, [chat.fakeSay]);
}

/** Above the chat box during a call. */
export function VoiceBar() {
  const { chat, mode, prefs } = useVoice();
  useFakeSay(chat);
  if (!prefs?.available || !chat.active) return null;
  return (
    <div
      className="space-y-2 rounded-md border bg-muted/40 p-2"
      data-testid="voice-bar"
      data-status={chat.status}
      data-mode={mode}
    >
      <p className="truncate text-sm" aria-live="polite" data-testid="voice-status">
        {statusLine(chat, mode)}
      </p>
      {chat.error && <p className="text-xs text-destructive">{chat.error}</p>}
      <CallControls />
    </div>
  );
}

/** The newest reply's words, for the view with no chat. */
function lastReply(items: TranscriptItem[]): string {
  const item = items.findLast((i) => i.kind === "assistant");
  if (item?.kind !== "assistant") return "";
  const { say, shown } = splitSpoken(item.text);
  return shown || say || "";
}

/** A phone's voice view: the chat is hidden, so replies are read out in full (ADR 0349). */
function VoiceFullScreen() {
  const { chat, mode, fullScreen, setFullScreen } = useVoice();
  const thread = useThread();
  const active = chat.active && fullScreen;
  useEffect(() => {
    if (!chat.active) setFullScreen(false);
  }, [chat.active, setFullScreen]);
  if (!active) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex flex-col gap-6 bg-background p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
      data-testid="voice-fullscreen-view"
    >
      <p className="text-xs text-muted-foreground">
        Cards aren't shown here, so I'll read them out.
      </p>
      <p className="min-h-0 flex-1 overflow-y-auto text-lg">{lastReply(thread.items)}</p>
      <p className="text-center text-sm" aria-live="polite">
        {statusLine(chat, mode)}
      </p>
      <CallControls large />
    </div>
  );
}

// --- Dictation -----------------------------------------------------------------------------------

export interface ComposerDictation {
  available: boolean;
  listening: boolean;
  cleaning: boolean;
  seconds: number;
  /** What the box shows while listening. */
  shown: string;
  /** The box holds dictated words: the message counts as dictated when sent. */
  dictated: boolean;
  /** The words as heard, for "Undo cleanup". */
  canUndo: boolean;
  error: string | null;
  toggle: () => void;
  cancel: () => void;
  undo: () => void;
  clear: () => void;
}

/** The names on screen, for spelling them right in the cleanup pass. */
function namesIn(context: AssistantContext): string[] {
  return [context.record?.label, ...(context.selection?.labels ?? [])].filter(
    (name): name is string => Boolean(name),
  );
}

export function useComposerDictation({
  draft,
  onDraftChange,
  context,
}: {
  draft: string;
  onDraftChange: (text: string) => void;
  context: AssistantContext;
}): ComposerDictation {
  const { prefs, chat } = useVoice();
  const dictation = useDictation({ url: socketUrl });
  const [base, setBase] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [cleaning, setCleaning] = useState(false);
  const [raw, setRaw] = useState<string | null>(null);
  const [cleaned, setCleaned] = useState<string | null>(null);
  const [dictated, setDictated] = useState(false);
  const { listening } = dictation;

  useEffect(() => {
    if (!listening) return;
    setSeconds(0);
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [listening]);

  // Editing the text by hand ends "Undo cleanup": there is no longer one thing to go back to.
  useEffect(() => {
    if (cleaned !== null && draft !== cleaned) setCleaned(null);
    if (!draft) setDictated(false);
  }, [draft, cleaned]);

  useEffect(() => {
    const target = window as unknown as { __dictationSay?: (text: string) => void };
    target.__dictationSay = dictation.fakeSay;
    return () => {
      target.__dictationSay = undefined;
    };
  }, [dictation.fakeSay]);

  const joined = (words: string) => [base.trimEnd(), words].filter(Boolean).join(" ");

  async function stop() {
    const words = await dictation.stop();
    if (!words) return;
    const before = joined(words);
    onDraftChange(before);
    setDictated(true);
    setCleaning(true);
    try {
      const result = await callOp("dictation.cleanup", { text: words, names: namesIn(context) });
      if (result.changed) {
        const after = joined(result.text);
        onDraftChange(after);
        setRaw(before);
        setCleaned(after);
      }
    } catch {
      // The words as heard stay in the box: nothing is lost.
    } finally {
      setCleaning(false);
    }
  }

  function start() {
    setBase(draft);
    setRaw(null);
    setCleaned(null);
    dictation.start().catch((error: unknown) => toast.error(errorMessage(error)));
  }

  return {
    available: Boolean(prefs?.available) && !chat.active,
    listening,
    cleaning,
    seconds,
    shown: joined(dictation.text),
    dictated,
    canUndo: cleaned !== null && raw !== null,
    error: dictation.error,
    toggle: () => {
      if (listening) void stop();
      else start();
    },
    cancel: dictation.cancel,
    undo: () => {
      if (raw !== null) onDraftChange(raw);
      setCleaned(null);
    },
    clear: () => {
      setRaw(null);
      setCleaned(null);
      setDictated(false);
    },
  };
}

export function DictationButton({ dictation }: { dictation: ComposerDictation }) {
  if (!dictation.available) return null;
  return (
    <Button
      type="button"
      size="icon"
      variant={dictation.listening ? "default" : "outline"}
      onClick={dictation.toggle}
      disabled={dictation.cleaning}
      aria-label={dictation.listening ? "Stop dictating" : "Dictate"}
      aria-pressed={dictation.listening}
      data-testid="dictation-mic"
    >
      {dictation.cleaning ? (
        <LoaderCircleIcon className="animate-spin" />
      ) : dictation.listening ? (
        <SquareIcon />
      ) : (
        <MicIcon />
      )}
    </Button>
  );
}

export function DictationStatus({ dictation }: { dictation: ComposerDictation }) {
  if (dictation.listening) {
    const m = Math.floor(dictation.seconds / 60);
    const s = String(dictation.seconds % 60).padStart(2, "0");
    return (
      <p className="text-xs text-muted-foreground" data-testid="dictation-status">
        Listening {m}:{s} · Esc to cancel
      </p>
    );
  }
  if (dictation.error) return <p className="text-xs text-destructive">{dictation.error}</p>;
  if (!dictation.canUndo) return null;
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="h-6 px-2 text-xs"
      onClick={dictation.undo}
      data-testid="dictation-undo"
    >
      <Undo2Icon />
      Undo cleanup
    </Button>
  );
}
