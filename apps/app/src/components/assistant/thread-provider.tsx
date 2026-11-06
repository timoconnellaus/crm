// The person's one assistant thread in the browser (ADR 0340). One WebSocket per tab to their
// AssistantAgent object carries the thread to every view of it: the docked sidebar and /assistant
// show the same items, a reply started on another device streams here too, and the unread badge
// on the "Ask AI" button and the nav stays current. The socket hibernates on the server between
// messages, so keeping it open costs little.
//
// Two contexts, so the badge does not re-render on every streamed word: `useThread` (everything)
// and `useThreadUnread` (the count).
import {
  type AssistantContext,
  type AssistantEvent,
  type AssistantThreadState,
  applyEvent,
  type ThreadClientFrame,
  type ThreadServerFrame,
  type TranscriptItem,
} from "@relationship-os/core/client";
import { useQueryClient } from "@tanstack/react-query";
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
import { callOp } from "#/lib/operations";
import { invalidateOps } from "#/lib/query";

export interface ThreadView {
  /** The thread id (ath_…), null before the first message. */
  id: string | null;
  items: TranscriptItem[];
  running: boolean;
  thinking: boolean;
  error: string | null;
  /** The first window has not arrived yet. */
  loading: boolean;
  hasEarlier: boolean;
  /** A message to scroll to (after "Jump to"); cleared by the view once it has scrolled. */
  jumpTarget: number | null;
  clearJump: () => void;
  send: (text: string, context: AssistantContext) => Promise<void>;
  stop: () => Promise<void>;
  loadEarlier: () => void;
  jumpTo: (seq: number) => void;
  deleteMessage: (seq: number) => Promise<void>;
}

interface UnreadView {
  unread: number;
}

const ThreadContext = createContext<ThreadView | null>(null);
const UnreadContext = createContext<UnreadView>({ unread: 0 });
const VisibleContext = createContext<((delta: number) => void) | null>(null);

async function problem(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? `The assistant answered ${response.status}`;
  } catch {
    return `The assistant answered ${response.status}`;
  }
}

/** Reads server-sent events from a response body, calling `onEvent` for each. */
async function readStream(response: Response, onEvent: (event: AssistantEvent) => void) {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n\n");
    while (index >= 0) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const data = frame.split("\n").find((l) => l.startsWith("data: "));
      if (data) onEvent(JSON.parse(data.slice(6)) as AssistantEvent);
      index = buffer.indexOf("\n\n");
    }
  }
}

function socketUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/api/assistant/socket`;
}

export function ThreadProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [id, setId] = useState<string | null>(null);
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [running, setRunning] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasEarlier, setHasEarlier] = useState(false);
  const [unread, setUnread] = useState(0);
  const [jumpTarget, setJumpTarget] = useState<number | null>(null);
  const [watchers, setWatchers] = useState(0);
  const [pageVisible, setPageVisible] = useState(true);
  const socket = useRef<WebSocket | null>(null);
  const firstSeq = useRef<number | null>(null);
  const unreadRef = useRef(0);
  unreadRef.current = unread;

  const frame = useCallback((message: ThreadClientFrame): boolean => {
    const ws = socket.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(message));
    return true;
  }, []);

  const onEvent = useCallback(
    (event: AssistantEvent) => {
      setThinking(event.type === "thinking");
      setItems((current) => applyEvent(current, event));
      if (event.type === "turn-start") {
        setRunning(true);
        setError(null);
      }
      if (event.type === "turn-end") {
        setRunning(false);
        setThinking(false);
        // The stored messages carry their seqs (for delete and jump): reload the window.
        frame({ type: "sync" });
        // The turn may have changed anything the person can see.
        void invalidateOps(client, "");
      }
    },
    [client, frame],
  );

  const applyState = useCallback(
    (state: AssistantThreadState, mode: "replace" | "prepend") => {
      setLoading(false);
      if (state.id) setId(state.id);
      setUnread(state.unread);
      if (mode === "prepend") {
        setItems((current) => [...state.items, ...current]);
        firstSeq.current = state.firstSeq ?? firstSeq.current;
        setHasEarlier(state.hasEarlier);
        return;
      }
      let next = state.items;
      for (const event of state.running?.events ?? []) next = applyEvent(next, event);
      setItems(next);
      firstSeq.current = state.firstSeq;
      setHasEarlier(state.hasEarlier);
      setRunning(Boolean(state.running));
      const last = state.running?.events.at(-1);
      setThinking(last?.type === "thinking");
    },
    [],
  );

  // The socket: open while signed in, reconnecting with backoff.
  useEffect(() => {
    let closed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const ws = new WebSocket(socketUrl());
      socket.current = ws;
      ws.onopen = () => {
        attempt = 0;
      };
      ws.onmessage = (message) => {
        if (typeof message.data !== "string") return;
        let data: ThreadServerFrame;
        try {
          data = JSON.parse(message.data) as ThreadServerFrame;
        } catch {
          return;
        }
        switch (data.type) {
          case "state":
            applyState(data.state, data.mode);
            break;
          case "event":
            onEvent(data.event);
            break;
          case "unread":
            setUnread(data.unread);
            break;
          case "deleted":
            ws.send(JSON.stringify({ type: "sync" } satisfies ThreadClientFrame));
            break;
          case "error":
            setError(data.message);
            break;
        }
      };
      ws.onclose = () => {
        if (socket.current === ws) socket.current = null;
        if (closed) return;
        attempt += 1;
        timer = setTimeout(connect, Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)));
      };
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      socket.current?.close();
      socket.current = null;
    };
  }, [applyState, onEvent]);

  // Is the chat on screen? Views register while they show it; a hidden tab does not count.
  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState === "visible");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  const visible = watchers > 0 && pageVisible;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-sent when the socket reconnects and the state arrives.
  useEffect(() => {
    frame({ type: "visible", visible });
    if (visible && unreadRef.current > 0) {
      setUnread(0);
      void callOp("thread.markSeen", {}).catch(() => {});
    }
  }, [visible, loading, unread > 0, frame]);

  const send = useCallback(
    async (text: string, context: AssistantContext) => {
      setError(null);
      if (frame({ type: "send", text, context })) return;
      // No socket (a network that blocks WebSockets): the HTTP turn, read as server-sent events.
      setRunning(true);
      try {
        const response = await fetch("/api/assistant/turn", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, context }),
        });
        if (!response.ok) {
          setError(await problem(response));
          return;
        }
        await readStream(response, onEvent);
      } catch (caught) {
        setError(String(caught));
      } finally {
        setRunning(false);
        setThinking(false);
      }
    },
    [frame, onEvent],
  );

  const stop = useCallback(async () => {
    if (frame({ type: "stop" })) return;
    await fetch("/api/assistant/thread/stop", { method: "POST" });
  }, [frame]);

  const loadEarlier = useCallback(() => {
    if (firstSeq.current !== null) frame({ type: "sync", beforeSeq: firstSeq.current });
  }, [frame]);

  const jumpTo = useCallback(
    (seq: number) => {
      if (firstSeq.current === null || seq < firstSeq.current) frame({ type: "sync", fromSeq: seq });
      setJumpTarget(seq);
    },
    [frame],
  );

  const deleteMessage = useCallback(async (seq: number) => {
    await callOp("thread.deleteMessage", { seq });
    // Other views hear it from the server; this one updates at once.
    setItems((current) => current.filter((i) => i.seq !== seq));
  }, []);

  const view = useMemo<ThreadView>(
    () => ({
      id,
      items,
      running,
      thinking,
      error,
      loading,
      hasEarlier,
      jumpTarget,
      clearJump: () => setJumpTarget(null),
      send,
      stop,
      loadEarlier,
      jumpTo,
      deleteMessage,
    }),
    [
      id,
      items,
      running,
      thinking,
      error,
      loading,
      hasEarlier,
      jumpTarget,
      send,
      stop,
      loadEarlier,
      jumpTo,
      deleteMessage,
    ],
  );
  const unreadView = useMemo(() => ({ unread }), [unread]);
  const register = useCallback((delta: number) => setWatchers((n) => Math.max(0, n + delta)), []);

  return (
    <VisibleContext.Provider value={register}>
      <UnreadContext.Provider value={unreadView}>
        <ThreadContext.Provider value={view}>{children}</ThreadContext.Provider>
      </UnreadContext.Provider>
    </VisibleContext.Provider>
  );
}

/** The thread, for the sidebar and /assistant. */
export function useThread(): ThreadView {
  const value = useContext(ThreadContext);
  if (!value) throw new Error("useThread needs ThreadProvider");
  return value;
}

/** The unread count, for the badges (0 outside the signed-in shell). */
export function useThreadUnread(): UnreadView {
  return useContext(UnreadContext);
}

/** A view showing the chat calls this while it is on screen, so replies arrive already seen. */
export function useThreadVisible(active: boolean) {
  const register = useContext(VisibleContext);
  useEffect(() => {
    if (!register || !active) return;
    register(1);
    return () => register(-1);
  }, [register, active]);
}
