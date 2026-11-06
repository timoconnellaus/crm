// The person's one assistant thread (ADR 0340): an `AssistantAgent` Durable Object per user, named
// `user:<userId>`, on the Cloudflare Agents SDK. It holds the thread (agent-core's SQLite message
// store with its FTS5 search index), runs one turn at a time, and streams each turn's events to
// every reader: the browsers' hibernatable WebSockets (the sidebar and /assistant on any device)
// and the HTTP turn route (evals and MCP-style clients).
//
// A turn is assembled as agent-core says (ADR 0341): the instructions and tools are the cached
// prefix, and the page context and the time ride in the tail of the new user message, which is
// then kept with it. The tools are an in-process MCP client of our own server acting as actor
// `assistant` for the owner (ADR 0200), with the thread id as its MCP session. Reasoning is kept
// and replayed (ADR 0201).
//
// Writes to D1 go only through operations: the turn's tool calls, `thread.open` once, and one
// `thread.finishTurn` per turn (unread count, preview, and the records it referenced, for erase).
// No alarms yet: compaction (W2) and agent reminders will add them.
//
// Memory (ADR 0342) lives in D1 and is read live each turn (core's `memoryForTurn`); the object
// keeps only when the memory block was last folded. Compaction calls `foldPendingLines()`.
import {
  assembleContext,
  messagesFromResponse,
  messageText,
  runTurn,
  SqliteMessageStore,
  type TailBlock,
  type ThreadMessage,
  unreadCount,
} from "@relationship-os/agent-core";
import {
  type ActingUser,
  type AssistantContext,
  type AssistantEvent,
  type AssistantEventInput,
  type AssistantPending,
  type AssistantThreadState,
  type AssistantThreadStore,
  assistantContextSchema,
  assistantInstructions,
  assistantTail,
  type ConversationScrub,
  conversationRefs,
  describeAssistantResult,
  EMPTY_THREAD_MEMORY,
  errorForLog,
  foldPendingLines,
  type InvocationContext,
  invokeByName,
  loadGeneralSettings,
  memoryForTurn,
  memorySaveOf,
  parseFloor,
  personsWordsInThread,
  type RateLimitBinding,
  RateLimitedError,
  ROLES,
  type Role,
  rateLimit,
  scrubParts,
  scrubPattern,
  scrubText,
  scrubValue,
  type ThreadClientFrame,
  type ThreadMemoryState,
  type ThreadSearchHit,
  type ThreadServerFrame,
  type TranscriptItem,
  transcriptFromThread,
  withSavedLines,
} from "@relationship-os/core";
import { createCrmDb } from "@relationship-os/db";
import { Agent, type Connection, type ConnectionContext, type WSMessage } from "agents";
import { aiContextFor } from "../ai.ts";
import { blobStoreFor, integrationRuntimeFor } from "../integrations.ts";
import type { McpCaller } from "../mcp/tools.ts";
import {
  automationWiring,
  ensureShippedExtensions,
  extensionHostFor,
  type OperationsEnv,
} from "../operations.ts";
import { connectAssistantMcp } from "./mcp-client.ts";

export interface AssistantEnv extends OperationsEnv {
  /** Assistant changes count against the same per-minute write budget as MCP (ADR 0091). */
  MCP_WRITE_RATE_LIMIT?: RateLimitBinding;
}

/** The header ros-app's own routing sets on a WebSocket upgrade: the signed-in user. */
export const USER_HEADER = "x-ros-assistant-user";

/** The Durable Object name of a user's thread. */
export function threadName(userId: string): string {
  return `user:${userId}`;
}

export interface TurnRequest {
  userId: string;
  text: string;
  context?: AssistantContext | undefined;
}

/** RPC-friendly: a refusal comes back as a value (error classes do not survive RPC). */
export type TurnStart =
  | { ok: true; stream: ReadableStream<Uint8Array>; threadId: string | null }
  | { ok: false; status: number; message: string };

export class ThreadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface RunningTurn {
  turn: number;
  userSeq: number;
  events: AssistantEvent[];
  listeners: Set<(event: AssistantEvent) => void>;
  abort: AbortController;
  done: Promise<void>;
}

interface SocketState {
  userId: string;
  visible: boolean;
}

/** Messages shown per window of the thread ("Show earlier messages" loads the next). */
export const THREAD_WINDOW = 200;

const encoder = new TextEncoder();

function sseFrame(event: AssistantEvent): Uint8Array {
  return encoder.encode(
    `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
  );
}

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export class AssistantAgent extends Agent<Cloudflare.Env> {
  static override options = { sendIdentityOnConnect: false };

  #store: SqliteMessageStore | null = null;
  #running: RunningTurn | null = null;
  /** Erases that arrived while a turn ran: applied to its messages before they are stored. */
  #scrubs: ConversationScrub[] = [];

  get #env(): AssistantEnv {
    return this.env as unknown as AssistantEnv;
  }

  /** The thread's tables, created on first use (idempotent). */
  get #messages(): SqliteMessageStore {
    if (!this.#store) {
      const sql = this.ctx.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS thread_meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      )`);
      // running → done | error | stopped; a turn left `running` by an evicted object shows as
      // interrupted. `prefix_hash` is the cached prefix it was sent with (ADR 0341).
      sql.exec(`CREATE TABLE IF NOT EXISTS thread_turns (
        turn INTEGER PRIMARY KEY NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        model TEXT,
        prefix_hash TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      )`);
      this.#store = new SqliteMessageStore(sql);
    }
    return this.#store;
  }

  #meta(key: string): string | null {
    void this.#messages;
    const row = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM thread_meta WHERE key = ?", key)
      .toArray()[0];
    return row?.value ?? null;
  }

  #setMeta(key: string, value: string) {
    void this.#messages;
    this.ctx.storage.sql.exec(
      "INSERT INTO thread_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  /** The thread belongs to one person; nobody else may read or extend it. */
  #assertOwner(userId: string) {
    const owner = this.#meta("owner");
    if (!owner) {
      this.#setMeta("owner", userId);
      return;
    }
    if (owner !== userId) throw new ThreadError(404, "No such thread");
  }

  #lastSeen(): number {
    return Number(this.#meta("last_seen_seq") ?? 0);
  }

  #unread(): number {
    const lastSeen = this.#lastSeen();
    return unreadCount(this.#messages.list({ afterSeq: lastSeen }), lastSeen);
  }

  #memoryState(): ThreadMemoryState {
    const raw = this.#meta("memory");
    return raw ? (JSON.parse(raw) as ThreadMemoryState) : EMPTY_THREAD_MEMORY;
  }

  /**
   * Compaction's hook (ADR 0342): the prefix is being rewritten, so every pending memory line joins
   * the memory block and leaves the tail. Call it after the compaction is committed; the next turn
   * sends the block returned here.
   */
  async foldPendingLines(): Promise<{ block: string | undefined; folded: string[] }> {
    const owner = this.#meta("owner");
    if (!owner) return { block: undefined, folded: [] };
    const db = createCrmDb(this.#env.DB);
    const { state, block, folded } = await foldPendingLines(db.query, owner, this.#memoryState());
    this.#setMeta("memory", JSON.stringify(state));
    return { block, folded };
  }

  // -------------------------------------------------------------------------------------------
  // Reading the thread

  #errorItems(firstSeq: number | null): TranscriptItem[] {
    const turns = this.ctx.storage.sql
      .exec<{ turn: number; status: string; error: string | null; finished_at: string | null }>(
        "SELECT turn, status, error, finished_at FROM thread_turns WHERE status IN ('running', 'error') ORDER BY turn",
      )
      .toArray();
    const items: TranscriptItem[] = [];
    for (const t of turns) {
      if (this.#running?.turn === t.turn) continue;
      const message =
        t.status === "running"
          ? "This reply was interrupted. Ask again to continue."
          : (t.error ?? "This reply failed.");
      items.push({
        kind: "error",
        turn: t.turn,
        message,
        ...(t.finished_at ? { at: t.finished_at } : {}),
      });
    }
    if (firstSeq === null) return items;
    const firstTurn = this.#messages.get(firstSeq)?.turn ?? 0;
    return items.filter((i) => i.turn >= firstTurn);
  }

  /** A window of the thread for the UI, plus the running turn to resume. */
  #state(
    options: { beforeSeq?: number | undefined; fromSeq?: number | undefined } = {},
  ): AssistantThreadState {
    const store = this.#messages;
    const messages =
      options.fromSeq !== undefined
        ? store.list({ afterSeq: options.fromSeq - 1, limit: THREAD_WINDOW * 4 })
        : store.list({
            ...(options.beforeSeq !== undefined ? { beforeSeq: options.beforeSeq } : {}),
            limit: THREAD_WINDOW,
          });
    const running = this.#running;
    // While a turn runs, its messages are not shown from storage: the reader replays its events.
    const shown = running ? messages.filter((m) => m.turn < running.turn) : messages;
    const items = transcriptFromThread(shown);
    const firstSeq = messages[0]?.seq ?? null;
    if (options.beforeSeq === undefined) {
      // Failed and interrupted turns show where they happened.
      for (const error of this.#errorItems(firstSeq)) {
        const at = items.findLastIndex((i) => i.turn <= error.turn);
        items.splice(at + 1, 0, error);
      }
    }
    return {
      id: this.#meta("thread_id"),
      items,
      running: running
        ? {
            turn: running.turn,
            lastSeq: running.events.at(-1)?.seq ?? 0,
            events: [...running.events],
          }
        : null,
      firstSeq,
      hasEarlier: firstSeq !== null && store.list({ beforeSeq: firstSeq, limit: 1 }).length > 0,
      lastSeq: store.lastSeq(),
      lastSeenSeq: this.#lastSeen(),
      unread: this.#unread(),
    };
  }

  /** The thread for the UI: the newest window, the one before `beforeSeq`, or from `fromSeq`. */
  async threadState(
    userId: string,
    options: { beforeSeq?: number; fromSeq?: number } = {},
  ): Promise<AssistantThreadState> {
    this.#assertOwner(userId);
    return this.#state(options);
  }

  async search(userId: string, query: string, limit = 20): Promise<ThreadSearchHit[]> {
    this.#assertOwner(userId);
    return this.#search(query, limit);
  }

  #search(query: string, limit: number): ThreadSearchHit[] {
    return this.#messages.search(query, limit).map((h) => ({
      seq: h.seq,
      turn: h.turn,
      role: h.role,
      at: h.createdAt,
      text: h.text,
    }));
  }

  /**
   * Deletes a message: one of the person's, or a whole reply (every assistant and tool message of
   * its turn, so a tool call never loses its result). Gone from the thread, search and what the
   * model sees. `thread.deleteMessage` deletes the memory lines saved from it (ADR 0342).
   */
  async deleteMessage(userId: string, seq: number): Promise<{ deleted: number[] }> {
    this.#assertOwner(userId);
    const message = this.#messages.get(seq);
    if (!message || message.deletedAt) return { deleted: [] };
    if (this.#running?.turn === message.turn) {
      throw new ThreadError(409, "Wait for the reply to finish before deleting it.");
    }
    const seqs =
      message.role === "user"
        ? [seq]
        : this.#messages
            .turn(message.turn)
            .filter((m) => !m.deletedAt && m.role !== "user")
            .map((m) => m.seq);
    this.#messages.delete(seqs, new Date().toISOString());
    this.#broadcast({ type: "deleted", seqs });
    return { deleted: seqs };
  }

  /** The person has seen the thread up to `seq` (the newest message when absent). */
  async markSeen(userId: string, seq?: number): Promise<{ unread: number; lastSeenSeq: number }> {
    this.#assertOwner(userId);
    const target = Math.min(seq ?? Number.MAX_SAFE_INTEGER, this.#messages.lastSeq());
    const lastSeenSeq = Math.max(this.#lastSeen(), target);
    this.#setMeta("last_seen_seq", String(lastSeenSeq));
    const unread = this.#unread();
    this.#broadcast({ type: "unread", unread, lastSeenSeq });
    return { unread, lastSeenSeq };
  }

  /** The prefix hash each finished turn was sent with (tests check it is stable, ADR 0341). */
  async prefixHashes(userId: string): Promise<{ turn: number; prefixHash: string | null }[]> {
    this.#assertOwner(userId);
    return this.ctx.storage.sql
      .exec<{ turn: number; prefix_hash: string | null }>(
        "SELECT turn, prefix_hash FROM thread_turns ORDER BY turn",
      )
      .toArray()
      .map((r) => ({ turn: r.turn, prefixHash: r.prefix_hash }));
  }

  /**
   * Redacts an erased person or organisation from the stored thread (ADR 0019 and ADR 0200
   * amendments): tool calls and results that mention them lose their content, and mentions in
   * text, tail blocks, reasoning and turn errors become "[erased]". Called by `person.erase` /
   * `organisation.erase` for threads the ref index lists, before the erase commits; not
   * owner-checked (only server code holds the binding). A running turn's events are redacted too,
   * and its messages are when they are stored.
   */
  async scrub(scrub: ConversationScrub): Promise<{ messages: number }> {
    const pattern = scrubPattern(scrub);
    if (!pattern) return { messages: 0 };
    let changed = 0;
    const store = this.#messages;
    this.ctx.storage.transactionSync(() => {
      for (const message of store.list({ includeDeleted: false })) {
        const parts = scrubParts(message.parts, pattern);
        if (parts === message.parts) continue;
        changed += 1;
        store.replace(message.seq, parts);
      }
      const errors = this.ctx.storage.sql
        .exec<{ turn: number; error: string }>(
          "SELECT turn, error FROM thread_turns WHERE error IS NOT NULL",
        )
        .toArray();
      for (const row of errors) {
        const error = scrubText(row.error, pattern);
        if (error !== row.error) {
          this.ctx.storage.sql.exec(
            "UPDATE thread_turns SET error = ? WHERE turn = ?",
            error,
            row.turn,
          );
        }
      }
    });
    const running = this.#running;
    if (running) {
      this.#scrubs.push(scrub);
      running.events = running.events.map((event) => scrubValue(event, pattern));
    }
    return { messages: changed };
  }

  // -------------------------------------------------------------------------------------------
  // WebSockets: every open sidebar and /assistant page, on any device

  override onConnect(connection: Connection<SocketState>, context: ConnectionContext) {
    const userId = context.request.headers.get(USER_HEADER);
    try {
      if (!userId) throw new ThreadError(401, "Sign in to continue");
      this.#assertOwner(userId);
    } catch {
      connection.close(4004, "No such thread");
      return;
    }
    connection.setState({ userId, visible: false });
    this.#send(connection, { type: "state", state: this.#state(), mode: "replace" });
  }

  override async onMessage(connection: Connection<SocketState>, message: WSMessage) {
    const state = connection.state;
    if (!state?.userId || typeof message !== "string") return;
    let frame: ThreadClientFrame;
    try {
      frame = JSON.parse(message) as ThreadClientFrame;
    } catch {
      return;
    }
    switch (frame.type) {
      case "send": {
        const context = frame.context ? assistantContextSchema.safeParse(frame.context) : null;
        const text = typeof frame.text === "string" ? frame.text.trim().slice(0, 20_000) : "";
        if (!text) return;
        try {
          this.#startTurn({
            userId: state.userId,
            text,
            ...(context?.success ? { context: context.data } : {}),
          });
        } catch (error) {
          this.#send(connection, {
            type: "error",
            message: error instanceof Error ? error.message : "The assistant failed",
          });
        }
        return;
      }
      case "stop":
        this.#running?.abort.abort();
        return;
      case "sync": {
        const beforeSeq = typeof frame.beforeSeq === "number" ? frame.beforeSeq : undefined;
        const fromSeq = typeof frame.fromSeq === "number" ? frame.fromSeq : undefined;
        this.#send(connection, {
          type: "state",
          state: this.#state({ beforeSeq, fromSeq }),
          mode: beforeSeq !== undefined ? "prepend" : "replace",
        });
        return;
      }
      case "visible":
        connection.setState({ ...state, visible: frame.visible === true });
        return;
      default:
        return;
    }
  }

  #send(connection: Connection<SocketState>, frame: ThreadServerFrame) {
    try {
      connection.send(JSON.stringify(frame));
    } catch {
      // The socket closed under us; it reconnects and syncs.
    }
  }

  #broadcast(frame: ThreadServerFrame) {
    this.broadcast(JSON.stringify(frame));
  }

  /** Is the chat on screen on any of the person's devices? */
  #anyoneWatching(): boolean {
    for (const connection of this.getConnections<SocketState>()) {
      if (connection.state?.visible) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------------------------
  // Turns

  /** Starts a turn and returns its event stream (SSE). Only one turn runs at a time. */
  async startTurn(request: TurnRequest): Promise<TurnStart> {
    try {
      const running = this.#startTurn(request);
      return { ok: true, stream: this.#subscribe(running, 0), threadId: this.#meta("thread_id") };
    } catch (error) {
      if (error instanceof ThreadError) {
        return { ok: false, status: error.status, message: error.message };
      }
      throw error;
    }
  }

  /** Resumes the running turn's events after `after` (none when no turn is running). */
  async stream(userId: string, after: number): Promise<ReadableStream<Uint8Array> | null> {
    this.#assertOwner(userId);
    const running = this.#running;
    if (!running) return null;
    return this.#subscribe(running, after);
  }

  /** Stops the running turn after its current step. */
  async stop(userId: string): Promise<boolean> {
    this.#assertOwner(userId);
    if (!this.#running) return false;
    this.#running.abort.abort();
    return true;
  }

  #startTurn(request: TurnRequest): RunningTurn {
    this.#assertOwner(request.userId);
    if (this.#running) {
      throw new ThreadError(409, "A reply is still being written. Wait for it, or stop it.");
    }
    const store = this.#messages;
    const turn =
      Math.max(
        store.lastTurn(),
        Number(
          this.ctx.storage.sql
            .exec<{ turn: number | null }>("SELECT MAX(turn) AS turn FROM thread_turns")
            .toArray()[0]?.turn ?? 0,
        ),
      ) + 1;
    const now = new Date().toISOString();
    // The person's words are kept at once (the tail is added when the turn is assembled).
    const [user] = store.append([
      {
        turn,
        role: "user",
        via: "text",
        parts: [{ type: "text", text: request.text }],
        createdAt: now,
      },
    ]);
    this.ctx.storage.sql.exec(
      "INSERT INTO thread_turns (turn, status, started_at) VALUES (?, 'running', ?)",
      turn,
      now,
    );
    // Sending a message means the person has seen everything before it.
    this.#setMeta("last_seen_seq", String(user?.seq ?? this.#lastSeen()));
    const running: RunningTurn = {
      turn,
      userSeq: user?.seq ?? 0,
      events: [],
      listeners: new Set(),
      abort: new AbortController(),
      done: Promise.resolve(),
    };
    this.#running = running;
    this.#emit({ type: "turn-start", turn, text: request.text, at: now });
    running.done = this.#runTurn(request, running).finally(() => {
      if (this.#running === running) this.#running = null;
    });
    this.ctx.waitUntil(running.done);
    return running;
  }

  #emit(input: AssistantEventInput) {
    const running = this.#running;
    if (!running) return;
    const event = { ...input, seq: running.events.length + 1 } as AssistantEvent;
    running.events.push(event);
    for (const listener of running.listeners) listener(event);
    this.#broadcast({ type: "event", event });
  }

  #subscribe(running: RunningTurn, after: number): ReadableStream<Uint8Array> {
    let listener: ((event: AssistantEvent) => void) | null = null;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const send = (event: AssistantEvent) => {
          if (closed) return;
          try {
            controller.enqueue(sseFrame(event));
          } catch {
            closed = true;
          }
          if (event.type === "turn-end") {
            closed = true;
            if (listener) running.listeners.delete(listener);
            try {
              controller.close();
            } catch {
              // already closed by the reader
            }
          }
        };
        for (const event of running.events) if (event.seq > after) send(event);
        if (!closed) {
          listener = send;
          running.listeners.add(listener);
        }
      },
      cancel() {
        if (listener) running.listeners.delete(listener);
      },
    });
  }

  async #actingUser(userId: string): Promise<ActingUser> {
    const db = createCrmDb(this.#env.DB);
    const row = await db.query
      .selectFrom("core_user")
      .select(["id", "email", "name", "role", "deactivated_at"])
      .where("id", "=", userId)
      .executeTakeFirst();
    if (!row || row.deactivated_at) throw new ThreadError(403, "This account cannot sign in");
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      role: (ROLES as readonly string[]).includes(row.role) ? (row.role as Role) : "viewer",
    };
  }

  /** The thread's id (ath_…), its D1 row created the first time through `thread.open`. */
  async #threadId(user: ActingUser): Promise<string> {
    const known = this.#meta("thread_id");
    if (known) return known;
    const db = createCrmDb(this.#env.DB);
    const opened = (await invokeByName(
      "thread.open",
      {},
      { actor: "human", user, origin: { surface: "ui" }, db },
    )) as { id: string };
    this.#setMeta("thread_id", opened.id);
    return opened.id;
  }

  /** This thread, for operations its own turn calls (the model's `thread.search`). */
  #localThreads(): AssistantThreadStore {
    return {
      search: async (_userId, query, limit) => this.#search(query, limit),
      deleteMessage: async () => {
        throw new ThreadError(403, "The assistant cannot delete messages");
      },
      markSeen: async () => ({ unread: this.#unread(), lastSeenSeq: this.#lastSeen() }),
      scrub: async (_userId, scrub) => {
        await this.scrub(scrub);
      },
    };
  }

  async #runTurn(request: TurnRequest, running: RunningTurn): Promise<void> {
    const env = this.#env;
    const db = createCrmDb(env.DB);
    const store = this.#messages;
    let status: "done" | "error" | "stopped" = "error";
    let error: string | null = null;
    let model: string | null = null;
    let preview: string | null = null;
    let prefixHash: string | null = null;
    let newMessages: Omit<ThreadMessage, "seq" | "createdAt">[] = [];
    let threadId: string | null = null;
    try {
      const user = await this.#actingUser(request.userId);
      threadId = await this.#threadId(user);
      await ensureShippedExtensions(env);
      const ai = aiContextFor(env, db);
      const chatModels = ai.models?.chatModels
        ? await ai.models.chatModels("assistant.core")
        : null;
      if (!chatModels?.length) {
        throw new ThreadError(503, "AI is not configured for this deployment (Settings → AI).");
      }
      const extensionHost = extensionHostFor(env);
      const integrations = integrationRuntimeFor(env);
      const blobs = blobStoreFor(env);
      const history = store.list({ beforeSeq: running.userSeq });
      const context: InvocationContext = {
        ...(integrations ? { integrations } : {}),
        ...(blobs ? { blobs } : {}),
        actor: "assistant",
        user,
        // The thread is the assistant's MCP session: its pending actions group in its change set,
        // and only its reads see them simulated (ADR 0022, ADR 0032).
        origin: { surface: "assistant", sessionId: threadId },
        db,
        floor: parseFloor(env.APPROVAL_FLOOR),
        approvalExpiryDays: int(env.APPROVAL_EXPIRY_DAYS, 7),
        ...(extensionHost ? { extensionHost } : {}),
        ...automationWiring(env),
        ...ai,
        assistantThreads: this.#localThreads(),
        // The person's own turns, by code: what authoring.intent checks an automation against
        // (ADR 0230). The model never writes them; a request it passes is ignored.
        personsWords: personsWordsInThread(history, request.text),
        assistantTurn: { threadId, messageSeq: running.userSeq, text: request.text },
      };
      const caller: McpCaller = {
        context,
        async consumeWrite() {
          const writes = await rateLimit(env.MCP_WRITE_RATE_LIMIT, `assistant:${user.id}`);
          if (!writes.ok) {
            throw new RateLimitedError(
              `Rate limit: too many changes this minute. Retry in ${writes.retryAfterSeconds}s.`,
              { retryAfterSeconds: writes.retryAfterSeconds },
            );
          }
        },
      };
      const mcp = await connectAssistantMcp(caller);
      try {
        const settings = await loadGeneralSettings(db.query);
        const tail: TailBlock[] = [
          ...assistantTail({
            now: new Date().toISOString(),
            timezone: settings.timezone,
            context: request.context,
          }),
        ];
        // With no history there is no cached prefix to protect, so everything starts in the block.
        const memory = await memoryForTurn(db.query, user.id, {
          state: this.#memoryState(),
          fold: !history.length,
          record: request.context?.record,
        });
        tail.push(...memory.tail);
        this.#setMeta("memory", JSON.stringify(memory.state));
        const assembled = await assembleContext({
          prefix: {
            instructions: assistantInstructions({
              name: settings.assistantName,
              user: { name: user.name, role: user.role },
              orgName: settings.orgName,
              serverInstructions: mcp.instructions,
            }),
            tools: mcp.tools,
            memory: memory.block,
          },
          history,
          tail,
          text: request.text,
          turn: running.turn,
          via: "text",
        });
        prefixHash = assembled.prefixHash;
        // The user message is kept exactly as it is sent, tail and all, so history replays byte
        // for byte on the next turn.
        store.replace(running.userSeq, assembled.userMessage.parts);
        const result = await runTurn<{ pending: AssistantPending }>({
          models: chatModels,
          system: assembled.system,
          messages: assembled.messages,
          tools: mcp.tools,
          emit: (event) => {
            this.#emit(event as AssistantEventInput);
            const save = event.type === "tool-result" ? memorySaveOf(event.output) : undefined;
            if (save) {
              const state = withSavedLines(this.#memoryState(), [save.line]);
              this.#setMeta("memory", JSON.stringify(state));
            }
          },
          describeResult: describeAssistantResult,
          signal: running.abort.signal,
        });
        newMessages = messagesFromResponse(running.turn, "text", result.response);
        status = result.status;
        error = result.error ?? null;
        model = result.model ?? null;
        preview = result.text || null;
      } finally {
        await mcp.close();
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "The assistant failed";
      if (!(caught instanceof ThreadError)) {
        console.error("assistant turn failed", errorForLog(caught));
      }
      this.#emit({ type: "error", message: error });
    }
    // An erase that arrived during the turn applies to what it is about to store.
    if (this.#scrubs.length) {
      for (const scrub of this.#scrubs.splice(0)) {
        const pattern = scrubPattern(scrub);
        newMessages = newMessages.map((m) => ({ ...m, parts: scrubParts(m.parts, pattern) }));
        const user = store.get(running.userSeq);
        if (user) {
          const parts = scrubParts(user.parts, pattern);
          if (parts !== user.parts) store.replace(user.seq, parts);
        }
        error = error === null ? null : scrubText(error, pattern);
        preview = preview === null ? null : scrubText(preview, pattern);
      }
    }
    // One transaction: the turn's messages and its status.
    let stored: ThreadMessage[] = [];
    this.ctx.storage.transactionSync(() => {
      stored = store.append(newMessages);
      this.ctx.storage.sql.exec(
        "UPDATE thread_turns SET status = ?, error = ?, model = ?, prefix_hash = ?, finished_at = ? WHERE turn = ?",
        status,
        error,
        model,
        prefixHash,
        new Date().toISOString(),
        running.turn,
      );
    });
    // A reply that arrives while the chat is on screen somewhere is already seen.
    if (this.#anyoneWatching()) this.#setMeta("last_seen_seq", String(store.lastSeq()));
    const unread = this.#unread();
    // The bookkeeping row (D1): once per turn, through an operation, as the owner. It also indexes
    // the records and emails the turn referenced, so an erase can find this thread.
    if (threadId) {
      try {
        const user = await this.#actingUser(request.userId);
        const turnMessages = [store.get(running.userSeq), ...stored].filter(
          (m): m is ThreadMessage => Boolean(m),
        );
        const refs = await conversationRefs([
          turnMessages.map((m) => m.parts),
          request.context ?? null,
        ]);
        await invokeByName(
          "thread.finishTurn",
          { id: threadId, preview: preview ?? error, unread, refs },
          { actor: "human", user, origin: { surface: "ui" }, db },
        );
      } catch (caught) {
        console.warn("assistant: could not record the turn", caught);
      }
    }
    this.#emit({ type: "turn-end", status, at: new Date().toISOString() });
    this.#broadcast({ type: "unread", unread, lastSeenSeq: this.#lastSeen() });
  }
}

/** The person's words of a stored message (for previews and tests). */
export { messageText };
