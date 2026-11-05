// /api/assistant/* (ADR 0200): the browser's way into a conversation object. The identity
// middleware has already resolved the Principal; these handlers resolve the CRM user, check the
// conversation is theirs (through assistant.* operations), and forward to its Durable Object.
// Framework-free so it is tested directly in workerd; src/routes/api/assistant/* wrap it.
import type { Principal } from "@relationship-os/auth";
import {
  type ActingUser,
  type AssistantContext,
  assistantContextSchema,
  conversationId,
  invokeByName,
  resolveActingUser,
  toOperationError,
} from "@relationship-os/core";
import { createCrmDb } from "@relationship-os/db";
import { z } from "zod";
import type { AssistantConversation, AssistantEnv } from "./conversation.ts";

export interface AssistantHttpEnv extends AssistantEnv {
  ASSISTANT?: DurableObjectNamespace<AssistantConversation>;
}

const turnBody = z.object({
  conversationId: conversationId.optional(),
  text: z.string().trim().min(1).max(20_000),
  context: assistantContextSchema.optional(),
});

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store",
  "x-accel-buffering": "no",
};

function json(status: number, body: unknown, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers });
}

function problem(status: number, message: string): Response {
  return json(status, { error: { message } });
}

/** Writes are same-origin only (the server-function CSRF rule, for plain routes). */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return request.headers.get("sec-fetch-site") === "same-origin";
  return origin === new URL(request.url).origin;
}

interface Caller {
  env: AssistantHttpEnv;
  user: ActingUser;
  stub: (id: string) => DurableObjectStub<AssistantConversation>;
}

async function caller(
  env: AssistantHttpEnv,
  principal: Principal | null,
): Promise<Caller | Response> {
  if (!principal) return problem(401, "Sign in to continue");
  const namespace = env.ASSISTANT;
  if (!namespace) return problem(503, "The assistant is not available on this deployment");
  const db = createCrmDb(env.DB);
  const user = await resolveActingUser(db, principal);
  return { env, user, stub: (id) => namespace.get(namespace.idFromName(id)) };
}

function uiContext(c: Caller) {
  return {
    actor: "human" as const,
    user: c.user,
    origin: { surface: "ui" as const },
    db: createCrmDb(c.env.DB),
  };
}

/** The conversation, if it is the caller's (a Response otherwise). */
async function own(c: Caller, id: string): Promise<Response | null> {
  try {
    await invokeByName("assistant.conversation", { id }, uiContext(c));
    return null;
  } catch (error) {
    const typed = toOperationError(error);
    if (
      typed.code === "not_found" ||
      typed.code === "forbidden" ||
      typed.code === "invalid_input"
    ) {
      return problem(404, "No such conversation");
    }
    throw error;
  }
}

/** POST /api/assistant/turn: starts a conversation when there is none, then a turn; SSE back. */
export async function handleTurn(
  request: Request,
  env: AssistantHttpEnv,
  principal: Principal | null,
): Promise<Response> {
  if (!sameOrigin(request)) return problem(403, "Cross-site request refused");
  const c = await caller(env, principal);
  if (c instanceof Response) return c;
  const parsed = turnBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return problem(400, "Expected { text, conversationId?, context? }");
  const { text, context } = parsed.data;
  let id: string;
  if (parsed.data.conversationId) {
    id = parsed.data.conversationId;
    const refused = await own(c, id);
    if (refused) return refused;
  } else {
    const started = (await invokeByName(
      "assistant.startConversation",
      { text, ...(context ? { context } : {}) },
      uiContext(c),
    )) as { id: string };
    id = started.id;
  }
  const start = await c.stub(id).startTurn({
    conversationId: id,
    userId: c.user.id,
    text,
    ...(context ? { context: context as AssistantContext } : {}),
  });
  if (!start.ok) return problem(start.status, start.message);
  return new Response(start.stream, {
    headers: { ...SSE_HEADERS, "x-conversation-id": id },
  });
}

/** GET /api/assistant/conversations/:id: the transcript and the running turn, if any. */
export async function handleState(
  env: AssistantHttpEnv,
  principal: Principal | null,
  id: string,
): Promise<Response> {
  const c = await caller(env, principal);
  if (c instanceof Response) return c;
  const refused = await own(c, id);
  if (refused) return refused;
  return json(200, await c.stub(id).state(c.user.id, id), { "cache-control": "no-store" });
}

/** GET /api/assistant/conversations/:id/stream?after=N: resume the running turn's events. */
export async function handleStream(
  env: AssistantHttpEnv,
  principal: Principal | null,
  id: string,
  after: number,
): Promise<Response> {
  const c = await caller(env, principal);
  if (c instanceof Response) return c;
  const refused = await own(c, id);
  if (refused) return refused;
  const stream = await c.stub(id).stream(c.user.id, Number.isFinite(after) ? after : 0);
  if (!stream) return new Response(null, { status: 204 });
  return new Response(stream, { headers: SSE_HEADERS });
}

/** POST /api/assistant/conversations/:id/stop: stop the running turn. */
export async function handleStop(
  request: Request,
  env: AssistantHttpEnv,
  principal: Principal | null,
  id: string,
): Promise<Response> {
  if (!sameOrigin(request)) return problem(403, "Cross-site request refused");
  const c = await caller(env, principal);
  if (c instanceof Response) return c;
  const refused = await own(c, id);
  if (refused) return refused;
  return json(200, { stopped: await c.stub(id).stop(c.user.id) });
}

/** DELETE /api/assistant/conversations/:id: remove it from the list and erase its history. */
export async function handleDelete(
  request: Request,
  env: AssistantHttpEnv,
  principal: Principal | null,
  id: string,
): Promise<Response> {
  if (!sameOrigin(request)) return problem(403, "Cross-site request refused");
  const c = await caller(env, principal);
  if (c instanceof Response) return c;
  const refused = await own(c, id);
  if (refused) return refused;
  await invokeByName("assistant.deleteConversation", { id }, uiContext(c));
  await c.stub(id).erase(c.user.id);
  return json(200, { id, deleted: true });
}
