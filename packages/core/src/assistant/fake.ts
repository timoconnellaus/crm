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

export interface FakeChatServerOptions {
  /** DeepSeek's rule with thinking on: tool-call turns must carry reasoning_content back. */
  requireReasoningContent?: boolean;
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
    const out = reply(body);
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
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
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
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
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
    if (o.error && typeof o.error === "object") {
      return `That didn't work: ${String((o.error as Record<string, unknown>).message ?? "error")}`;
    }
    if (o.status === "shown") return "Here it is.";
    if (o.status === "not_shown") return "I could not show that as a card.";
    if (Array.isArray(o.widgets)) return "Done: the dashboard is ready.";
    const name = o.displayName ?? o.name ?? o.title;
    if (typeof name === "string") return `Here is what I found about ${name}.`;
  }
  return text.startsWith("ERROR") ? `That didn't work: ${text.slice(7, 200)}` : "Done.";
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
  if (last?.role === "tool") {
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
  if (/\bshow (?:me )?my overdue tasks\b/i.test(text)) {
    return withReasoning({
      toolCalls: [{ name: "a2ui_produce", arguments: { producer: "tasks.overdueCard" } }],
    });
  }
  if (/\bshow (?:me )?(?:my )?stale deals\b/i.test(text)) {
    return withReasoning({
      toolCalls: [{ name: "a2ui_produce", arguments: { producer: "pipeline.staleDealsCard" } }],
    });
  }
  const overdue = /\b(?:create|add) an overdue task called\s+(.+)$/i.exec(text);
  if (overdue?.[1]) {
    return withReasoning({
      toolCalls: [
        {
          name: "task_create",
          arguments: {
            title: overdue[1].replace(/[.!?]+$/, "").slice(0, 200),
            dueAt: "2020-01-06",
            reason,
          },
        },
      ],
    });
  }
  const card = /\bshow (?:me )?a (broken )?card about (.+)$/i.exec(text);
  if (card?.[2]) {
    const subject = card[2].replace(/[.!?]+$/, "").slice(0, 100);
    return withReasoning({
      toolCalls: [
        {
          name: "show_card",
          arguments: {
            text: `Plain words about ${subject}.`,
            card: {
              a2ui: 1,
              root: card[1]
                ? { type: "marquee", text: subject }
                : {
                    type: "card",
                    title: subject,
                    children: [{ type: "text", text: `A card about ${subject}.` }],
                    actions: [
                      { kind: "reply", label: "Tell me more", text: `More about ${subject}` },
                    ],
                  },
            },
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
  return withReasoning({
    content:
      `I'm ${name}. I can look up and change records, build dashboards and widgets, and write ` +
      'extensions and automations for approval. Try "Create a task to call Ada tomorrow".',
  });
}

/** The scripted assistant as an AI SDK language model. */
export function fakeAssistantModel(options: FakeChatServerOptions = {}): LanguageModel {
  const server = fakeChatServer(scriptedAssistant, options);
  return createOpenAICompatible({
    name: "fake",
    baseURL: "https://fake-assistant.invalid/v1",
    fetch: server.fetch,
  }).chatModel("fake-assistant");
}
