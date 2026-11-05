// Stage 7 AC 5: the eval sets run through the in-app assistant instead of an external MCP client.
// With EVAL_VIA=assistant, runAgent hands each task's prompts to the deployment's own assistant
// (POST /api/assistant/turn, signed in as the eval user) and records the tool calls it streams
// back, so the same grading and outcome checks apply. The model is the deployment's `assistant`
// model role (Settings → AI or AI_MODEL_ROLES), not EVAL_MODEL.
import type { AgentRun, RecordedCall } from "./agent.ts";
import { parseResult } from "./mcp.ts";

export interface AssistantDriver {
  baseUrl: string;
  /** The eval user's session cookie (signIn). */
  cookie: string;
  fetch?: typeof fetch;
}

let driver: AssistantDriver | null = null;

/** Called by each runner after signing in: routes runAgent through the in-app assistant. */
export function configureVia(baseUrl: string, cookie: string, env = process.env): boolean {
  if (env.EVAL_VIA !== "assistant") {
    driver = null;
    return false;
  }
  driver = { baseUrl, cookie };
  return true;
}

export function assistantDriver(): AssistantDriver | null {
  return driver;
}

export function setAssistantDriver(next: AssistantDriver | null) {
  driver = next;
}

interface StreamEvent {
  seq: number;
  type: string;
  delta?: string;
  id?: string;
  tool?: string;
  input?: unknown;
  output?: unknown;
  isError?: boolean;
  message?: string;
  status?: string;
}

/** Parses a server-sent event stream body into the assistant's events. */
export function parseEvents(body: string): StreamEvent[] {
  return body
    .split("\n\n")
    .map((frame) => frame.split("\n").find((l) => l.startsWith("data: ")))
    .filter((l): l is string => Boolean(l))
    .map((l) => JSON.parse(l.slice(6)) as StreamEvent);
}

/** Runs a task's prompts as turns of one assistant conversation. */
export async function runViaAssistant(
  d: AssistantDriver,
  prompts: readonly string[],
): Promise<AgentRun> {
  const run: AgentRun = {
    calls: [],
    replies: [],
    finalText: "",
    stopReason: null,
    turns: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
  const fetchFn = d.fetch ?? fetch;
  const origin = new URL(d.baseUrl).origin;
  let conversationId: string | null = null;
  for (const [promptIndex, text] of prompts.entries()) {
    const response = await fetchFn(new URL("/api/assistant/turn", d.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", cookie: d.cookie, origin },
      body: JSON.stringify({ ...(conversationId ? { conversationId } : {}), text }),
    });
    if (!response.ok) {
      run.error = `assistant turn failed: HTTP ${response.status} ${await response.text()}`;
      break;
    }
    conversationId = response.headers.get("x-conversation-id") ?? conversationId;
    const events = parseEvents(await response.text());
    const calls = new Map<string, RecordedCall>();
    let reply = "";
    for (const event of events) {
      if (event.type === "step") run.turns += 1;
      if (event.type === "text") reply += event.delta ?? "";
      if (event.type === "tool-call" && event.id) {
        const call: RecordedCall = {
          promptIndex,
          turn: run.turns,
          name: event.tool ?? "",
          input: (event.input ?? {}) as Record<string, unknown>,
          isError: false,
          resultText: "",
          result: null,
        };
        calls.set(event.id, call);
        run.calls.push(call);
      }
      if (event.type === "tool-result" && event.id) {
        const call = calls.get(event.id);
        if (call) {
          call.isError = Boolean(event.isError);
          call.resultText =
            typeof event.output === "string" ? event.output : JSON.stringify(event.output);
          call.result =
            typeof event.output === "string" ? parseResult(event.output) : (event.output ?? null);
        }
      }
      if (event.type === "error") run.error = `assistant error: ${event.message ?? "unknown"}`;
      if (event.type === "turn-end") run.stopReason = event.status ?? null;
    }
    run.replies.push(reply.trim());
    run.finalText = reply.trim();
    if (run.error) break;
  }
  return run;
}
