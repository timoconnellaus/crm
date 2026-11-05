// One assistant conversation in the browser (ADR 0200): load its transcript, send a message and
// read the reply as it streams, resume a turn that is still running (after a reload or when the
// panel reopens), and stop it.
import {
  type AssistantContext,
  type AssistantConversationState,
  type AssistantEvent,
  applyEvent,
  type TranscriptItem,
} from "@relationship-os/core/client";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { invalidateOps } from "#/lib/query";

export interface ConversationView {
  id: string | null;
  items: TranscriptItem[];
  running: boolean;
  thinking: boolean;
  error: string | null;
  loading: boolean;
  send: (text: string, context: AssistantContext) => Promise<void>;
  stop: () => Promise<void>;
}

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

export function useConversation(
  conversationId: string | null,
  onStarted?: (id: string) => void,
): ConversationView {
  const client = useQueryClient();
  const [id, setId] = useState<string | null>(conversationId);
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [running, setRunning] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const lastSeq = useRef(0);
  const generation = useRef(0);
  // A conversation this hook just started: the parent learning its id must not reload it.
  const startedHere = useRef<string | null>(null);

  const onEvent = useCallback((event: AssistantEvent) => {
    lastSeq.current = event.seq;
    setThinking(event.type === "thinking");
    setItems((current) => applyEvent(current, event));
  }, []);

  const finishTurn = useCallback(() => {
    setRunning(false);
    setThinking(false);
    // The turn may have changed anything the person can see.
    void invalidateOps(client, "");
  }, [client]);

  // Load (or switch to) a conversation, resuming its running turn.
  useEffect(() => {
    if (conversationId && conversationId === startedHere.current) return;
    setId(conversationId);
    setError(null);
    lastSeq.current = 0;
    const mine = ++generation.current;
    if (!conversationId) {
      setItems([]);
      setRunning(false);
      return;
    }
    setLoading(true);
    void (async () => {
      try {
        const response = await fetch(`/api/assistant/conversations/${conversationId}`);
        if (mine !== generation.current) return;
        if (!response.ok) {
          setError(await problem(response));
          setItems([]);
          return;
        }
        const state = (await response.json()) as AssistantConversationState;
        setItems(state.items);
        if (state.running) {
          setRunning(true);
          const stream = await fetch(
            `/api/assistant/conversations/${conversationId}/stream?after=0`,
          );
          if (stream.status === 200 && mine === generation.current) {
            await readStream(stream, (event) => {
              if (mine === generation.current) onEvent(event);
            });
          }
          if (mine === generation.current) finishTurn();
        }
      } catch (caught) {
        if (mine === generation.current) setError(String(caught));
      } finally {
        if (mine === generation.current) setLoading(false);
      }
    })();
  }, [conversationId, onEvent, finishTurn]);

  const send = useCallback(
    async (text: string, context: AssistantContext) => {
      setError(null);
      setRunning(true);
      lastSeq.current = 0;
      const mine = generation.current;
      try {
        const response = await fetch("/api/assistant/turn", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...(id ? { conversationId: id } : {}), text, context }),
        });
        if (!response.ok) {
          setError(await problem(response));
          setRunning(false);
          return;
        }
        const started = response.headers.get("x-conversation-id");
        if (started && started !== id) {
          setId(started);
          startedHere.current = started;
          onStarted?.(started);
        }
        await readStream(response, (event) => {
          if (mine === generation.current) onEvent(event);
        });
        // A dropped connection (phone sleep, flaky network): resume from the last event.
        if (started && mine === generation.current) {
          for (let attempt = 0; attempt < 3; attempt++) {
            const resumed = await fetch(
              `/api/assistant/conversations/${started}/stream?after=${lastSeq.current}`,
            );
            if (resumed.status !== 200) break;
            await readStream(resumed, onEvent);
          }
        }
      } catch (caught) {
        setError(String(caught));
      } finally {
        if (mine === generation.current) finishTurn();
      }
    },
    [id, onEvent, onStarted, finishTurn],
  );

  const stop = useCallback(async () => {
    if (!id) return;
    await fetch(`/api/assistant/conversations/${id}/stop`, { method: "POST" });
  }, [id]);

  return { id, items, running, thinking, error, loading, send, stop };
}
