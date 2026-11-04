// Fakes for the model role registry: a Workers AI binding and an OpenAI-compatible server, both
// deterministic and recording what they were asked. No network, no real models.
import {
  createModelRunner,
  fakeEmbed,
  fakeModels,
  type ModelRunner,
  type ModelRunnerOptions,
  memoryVectorStore,
} from "../src/index.ts";
import { db } from "./helpers.ts";

export interface BindingCall {
  model: string;
  input: Record<string, unknown>;
  options: unknown;
}

/** A Workers AI binding: chat models answer `answer(model, input)`, bge models embed. */
export function fakeAiBinding(
  answer: (model: string, input: Record<string, unknown>) => string = (m) => `OK from ${m}`,
) {
  const calls: BindingCall[] = [];
  return {
    calls,
    binding: {
      async run(model: string, input: Record<string, unknown>, options?: unknown) {
        calls.push({ model, input, options });
        if (model.includes("bge")) {
          const texts = (Array.isArray(input.text) ? input.text : [input.text]) as string[];
          return { shape: [texts.length, 384], data: texts.map((t) => fakeEmbed(t)) };
        }
        return {
          response: answer(model, input),
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        };
      },
    },
  };
}

export interface FetchCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** An OpenAI-compatible server: chat completions answer `reply(body)`; embeddings use fakeEmbed. */
export function fakeOpenAiServer(
  reply: (body: Record<string, unknown>) => string = () => "Fake summary.",
) {
  const calls: FetchCall[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ url, headers, body });
    if (url.endsWith("/embeddings")) {
      const inputs = (Array.isArray(body.input) ? body.input : [body.input]) as string[];
      return Response.json({
        object: "list",
        data: inputs.map((t, index) => ({ object: "embedding", index, embedding: fakeEmbed(t) })),
        model: body.model,
        usage: { prompt_tokens: 1, total_tokens: 1 },
      });
    }
    return Response.json({
      id: "chatcmpl-fake",
      object: "chat.completion",
      created: 1,
      model: body.model,
      choices: [
        { index: 0, message: { role: "assistant", content: reply(body) }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  }) as typeof fetch;
  return { calls, fetch: fetchFn };
}

/** A registry-backed runner over the fake binding (and optional extra options). */
export function testRunner(
  options: Partial<ModelRunnerOptions> & {
    answer?: (model: string, input: Record<string, unknown>) => string;
  } = {},
): { models: ModelRunner; binding: ReturnType<typeof fakeAiBinding> } {
  const binding = fakeAiBinding(options.answer);
  const { answer: _answer, env, ...rest } = options;
  const models = createModelRunner({
    env: { AI: binding.binding, VECTORIZE_DIMENSIONS: "384", ...env },
    loadSettings: async () => (await import("../src/index.ts")).loadAiSettings(db.query),
    fakes: fakeModels(),
    ...rest,
  });
  return { models, binding };
}

export { memoryVectorStore };
