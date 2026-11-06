// A fake OpenAI-compatible chat server for tests: the real AI SDK provider talks to it, so the
// whole turn loop runs without a model. Each request is recorded.
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

export interface FakeRequest {
  messages: { role: string; content: unknown; tool_calls?: unknown }[];
  tools?: { function: { name: string } }[];
}

export type FakeReply =
  | { text: string }
  | { toolCall: { name: string; arguments: Record<string, unknown> } }
  | { fail: string };

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 0,
    model: "fake",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}),
  })}\n\n`;
}

export function fakeModel(reply: (request: FakeRequest, index: number) => FakeReply): {
  model: LanguageModel;
  requests: FakeRequest[];
} {
  const requests: FakeRequest[] = [];
  let calls = 0;
  const fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as FakeRequest;
    requests.push(body);
    const out = reply(body, calls++);
    if ("fail" in out)
      return new Response(JSON.stringify({ error: { message: out.fail } }), { status: 500 });
    const frames =
      "text" in out
        ? [chunk({ role: "assistant", content: out.text }), chunk({}, "stop")]
        : [
            chunk({
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `call_${calls}`,
                  type: "function",
                  function: {
                    name: out.toolCall.name,
                    arguments: JSON.stringify(out.toolCall.arguments),
                  },
                },
              ],
            }),
            chunk({}, "tool_calls"),
          ];
    return new Response(`${frames.join("")}data: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  };
  const model = createOpenAICompatible({
    name: "fake",
    baseURL: "https://fake.invalid/v1",
    fetch: fetch as typeof globalThis.fetch,
  }).chatModel("fake-model");
  return { model, requests };
}
