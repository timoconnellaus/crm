// One in-app assistant conversation (ADR 0030, ADR 0200): a Durable Object per conversation, named
// by its id (asc_…), with SQLite storage. It holds the durable history (the AI SDK's model
// messages, reasoning included: ADR 0201), runs one turn at a time, and streams each turn's events
// to every reader. A reader that drops (a page change, a phone locking) reconnects and resumes
// from the last event it saw while the turn keeps running here.
//
// Writes to D1 go only through operations: the turn's tool calls (actor `assistant`, through our
// own MCP server) and one `assistant.finishTurn` per turn for the conversation list. There are no
// alarms: the object does work only while a person is talking to it.
import { DurableObject } from "cloudflare:workers";
import {
  type ActingUser,
  type AssistantContext,
  type AssistantConversationState,
  type AssistantEvent,
  type AssistantEventInput,
  assistantInstructions,
  type InvocationContext,
  invokeByName,
  loadGeneralSettings,
  messagesForModel,
  parseFloor,
  personsWords,
  type RateLimitBinding,
  RateLimitedError,
  ROLES,
  type Role,
  rateLimit,
  runAssistantTurn,
  type StoredMessage,
  type TranscriptItem,
  transcriptFromMessages,
} from "@relationship-os/core";
import { createCrmDb } from "@relationship-os/db";
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

type ModelMessage = StoredMessage["message"];

export interface AssistantEnv extends OperationsEnv {
  /** Assistant changes count against the same per-minute write budget as MCP (ADR 0091). */
  MCP_WRITE_RATE_LIMIT?: RateLimitBinding;
}

export interface TurnRequest {
  conversationId: string;
  userId: string;
  text: string;
  context?: AssistantContext | undefined;
}

/** RPC-friendly: a refusal comes back as a value (error classes do not survive RPC). */
export type TurnStart =
  | { ok: true; stream: ReadableStream<Uint8Array> }
  | { ok: false; status: number; message: string };

export class ConversationError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface RunningTurn {
  turn: number;
  events: AssistantEvent[];
  listeners: Set<(event: AssistantEvent) => void>;
  abort: AbortController;
  done: Promise<void>;
}

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

export class AssistantConversation extends DurableObject<AssistantEnv> {
  #running: RunningTurn | null = null;

  constructor(ctx: DurableObjectState, env: AssistantEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      )`);
      // One row per stored model message. `turn` groups a user message with what answered it.
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        turn INTEGER NOT NULL,
        json TEXT NOT NULL
      )`);
      // running → done | error | stopped; a turn left `running` by an evicted object is shown
      // as interrupted.
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS turns (
        turn INTEGER PRIMARY KEY NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        model TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      )`);
    });
  }

  #meta(key: string): string | null {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)
      .toArray()[0];
    return row?.value ?? null;
  }

  #setMeta(key: string, value: string) {
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  /** The conversation belongs to the person who started it; nobody else may read or extend it. */
  #assertOwner(userId: string, claim = false) {
    const owner = this.#meta("owner");
    if (!owner && claim) {
      this.#setMeta("owner", userId);
      return;
    }
    if (owner !== userId) throw new ConversationError(404, "No such conversation");
  }

  #stored(): StoredMessage[] {
    return this.ctx.storage.sql
      .exec<{ turn: number; json: string }>("SELECT turn, json FROM messages ORDER BY seq")
      .toArray()
      .map((r) => ({ turn: r.turn, message: JSON.parse(r.json) as ModelMessage }));
  }

  #lastTurn(): number {
    const row = this.ctx.storage.sql
      .exec<{ turn: number | null }>("SELECT MAX(turn) AS turn FROM turns")
      .toArray()[0];
    return row?.turn ?? 0;
  }

  /** The stored conversation for the UI, plus the running turn to resume. */
  async state(userId: string, conversationId: string): Promise<AssistantConversationState> {
    this.#assertOwner(userId);
    const items: TranscriptItem[] = transcriptFromMessages(this.#stored());
    const turns = this.ctx.storage.sql
      .exec<{ turn: number; status: string; error: string | null }>(
        "SELECT turn, status, error FROM turns WHERE status != 'done' ORDER BY turn",
      )
      .toArray();
    for (const t of turns) {
      if (this.#running?.turn === t.turn) continue;
      if (t.status === "running" || t.status === "error") {
        const message =
          t.status === "running"
            ? "This reply was interrupted. Ask again to continue."
            : (t.error ?? "This reply failed.");
        const at = items.findLastIndex((i) => i.turn <= t.turn);
        items.splice(at + 1, 0, { kind: "error", turn: t.turn, message });
      }
    }
    const running = this.#running
      ? {
          turn: this.#running.turn,
          lastSeq: this.#running.events[this.#running.events.length - 1]?.seq ?? 0,
        }
      : null;
    // While a turn runs, its messages are not stored yet: the reader replays its events.
    const visible = running ? items.filter((i) => i.turn < running.turn) : items;
    return { id: conversationId, items: visible, running };
  }

  /** Starts a turn and returns its event stream (SSE). Only one turn runs at a time. */
  async startTurn(request: TurnRequest): Promise<TurnStart> {
    try {
      return { ok: true, stream: this.#startTurn(request) };
    } catch (error) {
      if (error instanceof ConversationError) {
        return { ok: false, status: error.status, message: error.message };
      }
      throw error;
    }
  }

  #startTurn(request: TurnRequest): ReadableStream<Uint8Array> {
    this.#assertOwner(request.userId, true);
    if (this.#running) {
      throw new ConversationError(409, "A reply is still being written. Wait for it, or stop it.");
    }
    const turn = this.#lastTurn() + 1;
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      "INSERT INTO turns (turn, status, started_at) VALUES (?, 'running', ?)",
      turn,
      now,
    );
    const running: RunningTurn = {
      turn,
      events: [],
      listeners: new Set(),
      abort: new AbortController(),
      done: Promise.resolve(),
    };
    this.#running = running;
    this.#emit({ type: "turn-start", turn, text: request.text, at: now });
    const stream = this.#subscribe(running, 0);
    running.done = this.#runTurn(request, running).finally(() => {
      if (this.#running === running) this.#running = null;
    });
    this.ctx.waitUntil(running.done);
    return stream;
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

  /** Erases the conversation's history (assistant.deleteConversation removed it from the list). */
  async erase(userId: string): Promise<void> {
    this.#assertOwner(userId);
    this.#running?.abort.abort();
    await this.ctx.storage.deleteAll();
  }

  #emit(input: AssistantEventInput) {
    const running = this.#running;
    if (!running) return;
    const event = { ...input, seq: running.events.length + 1 } as AssistantEvent;
    running.events.push(event);
    for (const listener of running.listeners) listener(event);
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
    const db = createCrmDb(this.env.DB);
    const row = await db.query
      .selectFrom("core_user")
      .select(["id", "email", "name", "role", "deactivated_at"])
      .where("id", "=", userId)
      .executeTakeFirst();
    if (!row || row.deactivated_at) throw new ConversationError(403, "This account cannot sign in");
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      role: (ROLES as readonly string[]).includes(row.role) ? (row.role as Role) : "viewer",
    };
  }

  async #runTurn(request: TurnRequest, running: RunningTurn): Promise<void> {
    const env = this.env;
    const db = createCrmDb(env.DB);
    let status: "done" | "error" | "stopped" = "error";
    let error: string | null = null;
    let model: string | null = null;
    let preview: string | null = null;
    const userMessage: ModelMessage = { role: "user", content: request.text };
    let newMessages: ModelMessage[] = [userMessage];
    try {
      const user = await this.#actingUser(request.userId);
      await ensureShippedExtensions(env);
      const ai = aiContextFor(env, db);
      const chatModels = ai.models?.chatModels ? await ai.models.chatModels("assistant") : null;
      if (!chatModels?.length) {
        throw new ConversationError(
          503,
          "AI is not configured for this deployment (Settings → AI).",
        );
      }
      const extensionHost = extensionHostFor(env);
      const integrations = integrationRuntimeFor(env);
      const blobs = blobStoreFor(env);
      const context: InvocationContext = {
        ...(integrations ? { integrations } : {}),
        ...(blobs ? { blobs } : {}),
        actor: "assistant",
        user,
        // The conversation is the assistant's MCP session: its pending actions group in its change
        // set, and only its reads see them simulated (ADR 0022, ADR 0032).
        origin: { surface: "assistant", sessionId: request.conversationId },
        db,
        floor: parseFloor(env.APPROVAL_FLOOR),
        approvalExpiryDays: int(env.APPROVAL_EXPIRY_DAYS, 7),
        ...(extensionHost ? { extensionHost } : {}),
        ...automationWiring(env),
        ...ai,
        // The person's own turns, by code: what authoring.intent checks an automation against
        // (ADR 0230). The model never writes them; a request it passes is ignored.
        personsWords: personsWords(this.#stored(), request.text),
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
        const instructions = assistantInstructions({
          name: settings.assistantName,
          user: { name: user.name, role: user.role },
          now: new Date().toISOString(),
          timezone: settings.timezone,
          orgName: settings.orgName,
          context: request.context,
          serverInstructions: mcp.instructions,
        });
        const result = await runAssistantTurn({
          models: chatModels,
          instructions,
          history: messagesForModel(this.#stored()),
          userText: request.text,
          tools: mcp.tools,
          emit: (event) => this.#emit(event),
          signal: running.abort.signal,
        });
        newMessages = result.messages;
        status = result.status;
        error = result.error ?? null;
        model = result.model ?? null;
        preview = result.text || null;
      } finally {
        await mcp.close();
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "The assistant failed";
      if (!(caught instanceof ConversationError)) console.error("assistant turn failed", caught);
      this.#emit({ type: "error", message: error });
    }
    // One transaction: the turn's messages and its status.
    this.ctx.storage.transactionSync(() => {
      for (const message of newMessages) {
        this.ctx.storage.sql.exec(
          "INSERT INTO messages (turn, json) VALUES (?, ?)",
          running.turn,
          JSON.stringify(message),
        );
      }
      this.ctx.storage.sql.exec(
        "UPDATE turns SET status = ?, error = ?, model = ?, finished_at = ? WHERE turn = ?",
        status,
        error,
        model,
        new Date().toISOString(),
        running.turn,
      );
    });
    // The conversation list (D1): once per turn, through an operation, as the owner.
    try {
      const user = await this.#actingUser(request.userId);
      await invokeByName(
        "assistant.finishTurn",
        { id: request.conversationId, preview: preview ?? error },
        { actor: "human", user, origin: { surface: "ui" }, db },
      );
    } catch (caught) {
      console.warn("assistant: could not update the conversation list", caught);
    }
    this.#emit({ type: "turn-end", status, at: new Date().toISOString() });
  }
}
