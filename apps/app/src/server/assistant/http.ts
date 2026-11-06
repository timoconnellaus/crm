// /api/assistant/* (ADR 0200, ADR 0340): the browser's and the evals' way into the person's one
// thread. The identity middleware has already resolved the Principal; these handlers resolve the
// CRM user and forward to their AssistantAgent Durable Object (`user:<userId>`), which checks
// its owner again. Framework-free so it is tested directly in workerd; src/routes/api/assistant/*
// and src/server.ts (the WebSocket) wrap it.
//
// Searching, deleting a message and marking the thread seen are operations (thread.*), called
// like any other from the UI.
import type { Principal } from "@relationship-os/auth";
import {
  type ActingUser,
  type AssistantContext,
  assistantContextSchema,
  resolveActingUser,
} from "@relationship-os/core";
import { createCrmDb } from "@relationship-os/db";
import { getAgentByName } from "agents";
import { z } from "zod";
import { type AssistantAgent, type AssistantEnv, threadName, USER_HEADER } from "./agent.ts";

export interface AssistantHttpEnv extends AssistantEnv {
  ASSISTANT?: DurableObjectNamespace<AssistantAgent>;
}

const turnBody = z.object({
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

/** The person's thread object, initialised (the Agents SDK's start-up has run). */
export async function threadStub(
  namespace: DurableObjectNamespace<AssistantAgent>,
  userId: string,
): Promise<DurableObjectStub<AssistantAgent>> {
  return getAgentByName(namespace as never, threadName(userId)) as unknown as Promise<
    DurableObjectStub<AssistantAgent>
  >;
}

interface Caller {
  user: ActingUser;
  stub: () => Promise<DurableObjectStub<AssistantAgent>>;
  namespace: DurableObjectNamespace<AssistantAgent>;
}

async function caller(env: AssistantHttpEnv, principal: Principal | null): Promise<Caller | Response> {
  if (!principal) return problem(401, "Sign in to continue");
  const namespace = env.ASSISTANT;
  if (!namespace) return problem(503, "The assistant is not available on this deployment");
  const user = await resolveActingUser(createCrmDb(env.DB), principal);
  return { user, namespace, stub: () => threadStub(namespace, user.id) };
}

/** POST /api/assistant/turn: a message to the person's thread; the reply streams back as SSE. */
export async function handleTurn(
  request: Request,
  env: AssistantHttpEnv,
  principal: Principal | null,
): Promise<Response> {
  if (!sameOrigin(request)) return problem(403, "Cross-site request refused");
  const c = await caller(env, principal);
  if (c instanceof Response) return c;
  const parsed = turnBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return problem(400, "Expected { text, context? }");
  const { text, context } = parsed.data;
  const start = await (await c.stub()).startTurn({
    userId: c.user.id,
    text,
    ...(context ? { context: context as AssistantContext } : {}),
  });
  if (!start.ok) return problem(start.status, start.message);
  return new Response(start.stream, {
    headers: { ...SSE_HEADERS, ...(start.threadId ? { "x-thread-id": start.threadId } : {}) },
  });
}

function seqParam(url: URL, name: string): number | undefined {
  const value = Number.parseInt(url.searchParams.get(name) ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** GET /api/assistant/thread[?before=N|from=N]: a window of the thread and the running turn. */
export async function handleState(
  request: Request,
  env: AssistantHttpEnv,
  principal: Principal | null,
): Promise<Response> {
  const c = await caller(env, principal);
  if (c instanceof Response) return c;
  const url = new URL(request.url);
  const beforeSeq = seqParam(url, "before");
  const fromSeq = seqParam(url, "from");
  const state = await (await c.stub()).threadState(c.user.id, {
    ...(beforeSeq ? { beforeSeq } : {}),
    ...(fromSeq ? { fromSeq } : {}),
  });
  return json(200, state, { "cache-control": "no-store" });
}

/** GET /api/assistant/thread/stream?after=N: resume the running turn's events. */
export async function handleStream(
  env: AssistantHttpEnv,
  principal: Principal | null,
  after: number,
): Promise<Response> {
  const c = await caller(env, principal);
  if (c instanceof Response) return c;
  const stream = await (await c.stub()).stream(c.user.id, Number.isFinite(after) ? after : 0);
  if (!stream) return new Response(null, { status: 204 });
  return new Response(stream, { headers: SSE_HEADERS });
}

/** POST /api/assistant/thread/stop: stop the running turn. */
export async function handleStop(
  request: Request,
  env: AssistantHttpEnv,
  principal: Principal | null,
): Promise<Response> {
  if (!sameOrigin(request)) return problem(403, "Cross-site request refused");
  const c = await caller(env, principal);
  if (c instanceof Response) return c;
  return json(200, { stopped: await (await c.stub()).stop(c.user.id) });
}

/** The WebSocket path (handled in src/server.ts, before TanStack Start). */
export const SOCKET_PATH = "/api/assistant/socket";

/**
 * GET /api/assistant/socket (WebSocket upgrade): the person's live connection to their thread.
 * Same-origin only (a cross-site page must not open it with the person's cookies). The object
 * is told who the user is by a header only this Worker can set.
 */
export async function handleSocket(
  request: Request,
  env: AssistantHttpEnv,
  principal: Principal | null,
): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return problem(426, "Expected a WebSocket upgrade");
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return problem(403, "Cross-site request refused");
  }
  const c = await caller(env, principal);
  if (c instanceof Response) return c;
  const forwarded = new Request(request);
  forwarded.headers.set(USER_HEADER, c.user.id);
  return c.namespace.get(c.namespace.idFromName(threadName(c.user.id))).fetch(forwarded);
}
