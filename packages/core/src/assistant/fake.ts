// A scripted stand-in for the `assistant` role (ADR 0156, ADR 0200): local development and e2e
// with AI_FAKE_MODEL=true, and tests. It is a fake OpenAI-compatible chat server (streaming and
// not) driven by simple rules on the last message, plugged into the same AI SDK provider the real
// third-party models use, so the whole tool loop runs as it would against a real model.
//
// `requireReasoningContent` makes the server behave like DeepSeek with thinking on (ADR 0192,
// ADR 0201): a request whose history has an assistant tool-call message without
// `reasoning_content` is refused with HTTP 400.
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { ModelPricing } from "../ai/roles.ts";
import { fakeWidget } from "../dashboards/describe.ts";

export interface ScriptedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ScriptedReply {
  content?: string;
  reasoning?: string;
  toolCalls?: ScriptedToolCall[];
}

export interface ChatRequestBody {
  model?: string;
  stream?: boolean;
  messages?: {
    role: string;
    content?: unknown;
    reasoning_content?: string;
    tool_calls?: unknown[];
    tool_call_id?: string;
  }[];
  tools?: { function?: { name?: string } }[];
  thinking?: { type?: string };
  [key: string]: unknown;
}

export interface FakeUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_cache_hit_tokens?: number;
}

export interface FakeChatServerOptions {
  /** DeepSeek's rule with thinking on: tool-call turns must carry reasoning_content back. */
  requireReasoningContent?: boolean;
  /** Waits before answering (a test holding a call open). */
  beforeReply?: (body: ChatRequestBody) => Promise<void> | void;
  /** The usage to report for an answer. The default is a flat 10 in, 5 out. */
  usage?: (body: ChatRequestBody, reply: ScriptedReply) => FakeUsage;
}

/** How the scripted assistant's summary call is recognised (agent-core's NOTE_REQUEST). */
const NOTE_REQUEST_START = "Write the where-we-left-off note";

/**
 * What tests can change about the scripted assistant (ADR 0341). It stays the same object for the
 * whole isolate, so a test in workerd reaches the model its Durable Object runs. Local development
 * and e2e keep the defaults: no prices and no window, so only the rails and the fallback apply.
 */
export const fakeStandIn: {
  pricing: ModelPricing | null;
  contextTokens: number;
  /** Report the request's history as read from the provider's cache. */
  cacheHits: boolean;
  /** While set, a summary call waits for this. */
  holdSummary: Promise<void> | null;
  /** When set, every request the assistant model gets is kept here. */
  requests: ChatRequestBody[] | null;
} = { pricing: null, contextTokens: 0, cacheHits: true, holdSummary: null, requests: null };

function tokensOf(value: unknown): number {
  return Math.ceil((JSON.stringify(value ?? null) ?? "").length / 4);
}

/** About four characters a token, and everything before the newest message found cached. */
function estimatedUsage(body: ChatRequestBody, reply: ScriptedReply): FakeUsage {
  const prompt = tokensOf(body.messages) + tokensOf(body.tools);
  const completion = tokensOf(reply.content ?? reply.toolCalls ?? "");
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_cache_hit_tokens: fakeStandIn.cacheHits
      ? Math.max(0, prompt - tokensOf(body.messages?.at(-1)))
      : 0,
  };
}

function isSummaryCall(body: ChatRequestBody): boolean {
  return textOf(body.messages?.at(-1)?.content).startsWith(NOTE_REQUEST_START);
}

export interface FakeChatCall {
  url: string;
  headers: Record<string, string>;
  body: ChatRequestBody;
  status: number;
}

const DEEPSEEK_400 = "The `reasoning_content` in the thinking mode must be passed back to the API.";

/** Does this request break DeepSeek's thinking-mode rule? */
export function missingReasoningContent(body: ChatRequestBody): boolean {
  if (body.thinking?.type === "disabled") return false;
  return (body.messages ?? []).some(
    (m) =>
      m.role === "assistant" &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.length > 0 &&
      !(typeof m.reasoning_content === "string" && m.reasoning_content.length > 0),
  );
}

let callCounter = 0;

function sse(chunks: unknown[]): Response {
  const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function chunk(model: string, delta: Record<string, unknown>, finish: string | null = null) {
  return {
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

/**
 * A fake OpenAI-compatible chat completions endpoint. `reply` decides each answer from the
 * request body. Records every call.
 */
export function fakeChatServer(
  reply: (body: ChatRequestBody) => ScriptedReply,
  options: FakeChatServerOptions = {},
) {
  const calls: FakeChatCall[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body ?? "{}")) as ChatRequestBody;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    if (options.requireReasoningContent && missingReasoningContent(body)) {
      calls.push({ url, headers, body, status: 400 });
      return Response.json(
        { error: { message: DEEPSEEK_400, type: "invalid_request_error" } },
        { status: 400 },
      );
    }
    calls.push({ url, headers, body, status: 200 });
    await options.beforeReply?.(body);
    const out = reply(body);
    const usage = options.usage?.(body, out) ?? {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    };
    const model = body.model ?? "fake";
    const toolCalls = (out.toolCalls ?? []).map((t) => {
      callCounter += 1;
      return {
        id: `call_${callCounter}`,
        type: "function",
        function: { name: t.name, arguments: JSON.stringify(t.arguments) },
      };
    });
    const finish = toolCalls.length ? "tool_calls" : "stop";
    if (body.stream) {
      const chunks: unknown[] = [chunk(model, { role: "assistant", content: "" })];
      if (out.reasoning) chunks.push(chunk(model, { reasoning_content: out.reasoning }));
      if (out.content) {
        for (const piece of out.content.match(/.{1,40}/gs) ?? []) {
          chunks.push(chunk(model, { content: piece }));
        }
      }
      toolCalls.forEach((call, index) => {
        chunks.push(chunk(model, { tool_calls: [{ index, ...call }] }));
      });
      chunks.push(chunk(model, {}, finish));
      chunks.push({
        ...chunk(model, {}),
        choices: [],
        usage,
      });
      return sse(chunks);
    }
    return Response.json({
      id: "chatcmpl-fake",
      object: "chat.completion",
      created: 1,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: out.content ?? (toolCalls.length ? null : ""),
            ...(out.reasoning ? { reasoning_content: out.reasoning } : {}),
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: finish,
        },
      ],
      usage,
    });
  }) as typeof fetch;
  return { calls, fetch: fetchFn };
}

// --- the scripted assistant -------------------------------------------------------------------

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === "object" && "text" in p ? String(p.text) : ""))
      .join("");
  }
  return "";
}

function systemText(body: ChatRequestBody): string {
  return (body.messages ?? [])
    .filter((m) => m.role === "system")
    .map((m) => textOf(m.content))
    .join("\n");
}

function lineValue(system: string, label: string): string | null {
  const match = new RegExp(`^- ${label}: (.+)$`, "m").exec(system);
  return match?.[1]?.trim() ?? null;
}

function hasTool(body: ChatRequestBody, name: string): boolean {
  return (body.tools ?? []).some((t) => t.function?.name === name);
}

function readTool(object: string, id: string, body: ChatRequestBody): ScriptedToolCall {
  if (object === "person" && hasTool(body, "person_get")) {
    return { name: "person_get", arguments: { id } };
  }
  if (object === "organisation" && hasTool(body, "organisation_get")) {
    return { name: "organisation_get", arguments: { id } };
  }
  return { name: "call_operation", arguments: { name: "record.get", input: { object, id } } };
}

function describeResult(text: string): string {
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {
    // plain text
  }
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (o.status === "pending_approval") {
      return `That change is waiting for approval (${String(o.operation ?? "")}). You can approve or reject it here, or in the Approvals inbox.`;
    }
    if (typeof o.result === "string" && typeof o.message === "string") {
      if (o.result === "saved") return "Got it, I'll remember that.";
      if (o.result === "confirm") return "Here's how I've read that. Is this right?";
      if (o.result === "duplicate") return "I already remember that.";
      if (o.result === "customer") return "That's about a customer, so it belongs on their record.";
      return o.message;
    }
    if (o.error && typeof o.error === "object") {
      return `That didn't work: ${String((o.error as Record<string, unknown>).message ?? "error")}`;
    }
    if (Array.isArray(o.widgets)) return "Done: the dashboard is ready.";
    const name = o.displayName ?? o.name ?? o.title;
    if (typeof name === "string") return `Here is what I found about ${name}.`;
  }
  return text.startsWith("ERROR") ? `That didn't work: ${text.slice(7, 200)}` : "Done.";
}

/**
 * After `memory.propose` refuses a customer fact: on a record's page, offer it as a note on that
 * record, as the instructions say.
 */
function noteForRefusedFact(
  messages: NonNullable<ChatRequestBody["messages"]>,
  result: string,
): ScriptedToolCall | null {
  if (!/"result":\s*"customer"/.test(result)) return null;
  const said = messages.findLast((m) => m.role === "user");
  const raw = textOf(said?.content);
  const tailEnd = raw.lastIndexOf("</context>");
  if (tailEnd < 0) return null;
  const [object, id] = lineValue(raw.slice(0, tailEnd), "Current record")?.split(/\s+/) ?? [];
  if (!object || !id) return null;
  const body = raw
    .slice(tailEnd + "</context>".length)
    .trim()
    .replace(/^(?:please )?remember(?: that)?\s+/i, "");
  return {
    name: "call_operation",
    arguments: {
      name: "activity.proposeNote",
      input: { record: { object, id }, body },
      reason: "The person asked to keep this, and it belongs on the record.",
    },
  };
}

/** The rules: deterministic answers and tool calls for the e2e scenarios. */
export function scriptedAssistant(body: ChatRequestBody): ScriptedReply {
  const messages = body.messages ?? [];
  const last = messages[messages.length - 1];
  const system = systemText(body);
  const name = /^Your name is ([^.]+)\./m.exec(system)?.[1] ?? "the assistant";
  const reasoning = body.thinking?.type === "enabled" ? "Working out what to do." : undefined;
  const withReasoning = (reply: ScriptedReply): ScriptedReply =>
    reasoning ? { ...reply, reasoning } : reply;
  // A compaction's summary call (ADR 0341): the note keeps the person's first words.
  if (isSummaryCall(body)) {
    const earlier = /^We were talking about: .+$/m.exec(system)?.[0];
    if (earlier) return withReasoning({ content: earlier });
    const first = messages.find((m) => m.role === "user");
    const words = textOf(first?.content);
    const end = words.lastIndexOf("</context>");
    const opening = (end >= 0 ? words.slice(end + "</context>".length) : words).trim();
    const firstWords = opening.split(/\s+/).slice(0, 2).join(" ");
    return withReasoning({ content: `We were talking about: ${firstWords}` });
  }
  if (last?.role === "tool") {
    const note = noteForRefusedFact(messages, textOf(last.content));
    if (note) return withReasoning({ toolCalls: [note] });
    return withReasoning({ content: describeResult(textOf(last.content)) });
  }
  // The page context rides in the user message's <context> block (the tail, ADR 0341).
  const raw = textOf(last?.content);
  const tailEnd = raw.lastIndexOf("</context>");
  const page = tailEnd >= 0 ? raw.slice(0, tailEnd) : system;
  const text = (tailEnd >= 0 ? raw.slice(tailEnd + "</context>".length) : raw).trim();
  const record = lineValue(page, "Current record");
  const selection = lineValue(page, "Selected records");
  const reason = `Asked in the assistant: ${text.slice(0, 120)}`;

  if (selection && /\b(selected|these|them)\b/i.test(text)) {
    const [object, ...ids] = selection.split(/\s+/);
    return withReasoning({
      content: `You selected ${ids.length} ${object} record${ids.length === 1 ? "" : "s"}: ${ids.join(", ")}.`,
    });
  }
  const conditional =
    /^when i'?m on an? (organisation|person) with more than (\d+) people,?\s+(.+)$/i.exec(text);
  if (conditional?.[3]) {
    return withReasoning({
      toolCalls: [
        {
          name: "call_operation",
          arguments: {
            name: "memory.propose",
            input: {
              text: conditional[3].replace(/[.!?]+$/, ""),
              kind: "conditional",
              condition: {
                object: conditional[1]?.toLowerCase(),
                filter: { field: "currentPeopleCount", op: "gt", value: Number(conditional[2]) },
              },
            },
          },
        },
      ],
    });
  }
  const remember = /^(?:please )?remember(?: that)?\s+(.+)$/i.exec(text);
  if (remember?.[1]) {
    return withReasoning({
      toolCalls: [
        {
          name: "call_operation",
          arguments: {
            name: "memory.propose",
            input: { text: remember[1].replace(/[.!?]+$/, "").slice(0, 200) },
          },
        },
      ],
    });
  }
  const task = /\b(?:create|add) (?:a )?task(?: to| called| for)?\s+(.+)$/i.exec(text);
  if (task?.[1]) {
    const [object, id] = record?.split(/\s+/) ?? [];
    return withReasoning({
      toolCalls: [
        {
          name: "task_create",
          arguments: {
            title: task[1].replace(/[.!?]+$/, "").slice(0, 200),
            ...(object && id && (object === "person" || object === "organisation")
              ? { links: [{ object, id }] }
              : {}),
            reason,
          },
        },
      ],
    });
  }
  if (/\b(widget|dashboard|chart)\b/i.test(text)) {
    const widget = fakeWidget(text);
    return withReasoning({
      toolCalls: [
        {
          name: "call_operation",
          arguments: {
            name: "dashboard.create",
            input: { title: `${String(widget.title)} dashboard`, widgets: [widget] },
            reason,
          },
        },
      ],
    });
  }
  if (record && /\b(delete|remove|trash)\b/i.test(text)) {
    const [object, id] = record.split(/\s+/);
    return withReasoning({
      toolCalls: [
        {
          name: "call_operation",
          arguments: {
            name: object === "organisation" ? "organisation.delete" : `${object}.delete`,
            input: { id },
            reason,
          },
        },
      ],
    });
  }
  if (record && /\b(this|summari[sz]e|about|who|what)\b/i.test(text)) {
    const [object, id] = record.split(/\s+/);
    if (object && id) return withReasoning({ toolCalls: [readTool(object, id, body)] });
  }
  // A spoken turn on a visible screen asks for a short spoken version first (ADR 0349).
  const say = /<say>…<\/say>/.test(page) ? "<say>Here is the short version.</say>\n" : "";
  return withReasoning({
    content:
      `${say}I'm ${name}. I can look up and change records, build dashboards and widgets, and write ` +
      'extensions and automations for approval. Try "Create a task to call Ada tomorrow".',
  });
}

/** The scripted assistant as an AI SDK language model. */
export function fakeAssistantModel(options: FakeChatServerOptions = {}): LanguageModel {
  const server = fakeChatServer(scriptedAssistant, {
    usage: estimatedUsage,
    async beforeReply(body) {
      fakeStandIn.requests?.push(body);
      if (isSummaryCall(body)) await fakeStandIn.holdSummary;
    },
    ...options,
  });
  return createOpenAICompatible({
    name: "fake",
    baseURL: "https://fake-assistant.invalid/v1",
    fetch: server.fetch,
  }).chatModel("fake-assistant");
}
