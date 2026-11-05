// The OpenAI-compatible client and provider selection, against a fake fetch.
import { describe, expect, it } from "vitest";
import {
  chatCompletionsModel,
  describeError,
  isFatalModelError,
  ModelApiError,
  ModelNetworkError,
  type Provider,
  resolveProvider,
  samplingFields,
} from "../lib/model.ts";

function provider(env: Record<string, string>): Provider {
  const result = resolveProvider(env);
  if (!result.ok) throw new Error(result.message);
  return result.provider;
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const completion = {
  choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
};

describe("resolveProvider", () => {
  it("targets Workers AI by default", () => {
    const p = provider({ CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_API_TOKEN: "tok" });
    expect(p.url).toBe("https://api.cloudflare.com/client/v4/accounts/acc/ai/v1/chat/completions");
    expect(p.headers).toEqual({ authorization: "Bearer tok" });
    expect(p.modelId("@cf/x/y")).toBe("@cf/x/y");
    expect(p.label).toBe("Workers AI");
  });

  it("routes through AI Gateway's compat endpoint with a workers-ai/ model prefix", () => {
    const p = provider({
      CLOUDFLARE_ACCOUNT_ID: "acc",
      CLOUDFLARE_API_TOKEN: "tok",
      CF_AI_GATEWAY_ID: "evals",
      CF_AIG_TOKEN: "gw",
    });
    expect(p.url).toBe("https://gateway.ai.cloudflare.com/v1/acc/evals/compat/chat/completions");
    expect(p.headers).toEqual({
      authorization: "Bearer tok",
      "cf-aig-authorization": "Bearer gw",
    });
    expect(p.modelId("@cf/x/y")).toBe("workers-ai/@cf/x/y");
    expect(p.modelId("workers-ai/@cf/x/y")).toBe("workers-ai/@cf/x/y");
  });

  it("uses any OpenAI-compatible endpoint when EVAL_BASE_URL is set", () => {
    const p = provider({
      EVAL_BASE_URL: "http://localhost:11434/v1/",
      EVAL_API_KEY: "none",
      CLOUDFLARE_ACCOUNT_ID: "ignored",
    });
    expect(p.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(
      provider({ EVAL_BASE_URL: "https://x.test/v1/chat/completions", EVAL_API_KEY: "k" }).url,
    ).toBe("https://x.test/v1/chat/completions");
    const missing = resolveProvider({ EVAL_BASE_URL: "https://x.test/v1" });
    expect(missing.ok).toBe(false);
  });
});

describe("chatCompletionsModel", () => {
  const p = provider({ CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_API_TOKEN: "tok" });

  it("posts the request with the provider's headers and model id", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const model = chatCompletionsModel(p, {
      fetch: async (url, init) => {
        seen.push({ url: String(url), init: init ?? {} });
        return ok(completion);
      },
    });
    const response = await model.createCompletion({
      model: "@cf/x/y",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0,
    });
    expect(response.choices[0]?.message.content).toBe("hi");
    const [request] = seen;
    if (!request) throw new Error("no request was sent");
    expect(request.url).toBe(p.url);
    expect((request.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(String(request.init.body))).toEqual({
      model: "@cf/x/y",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0,
    });
  });

  it("unwraps Cloudflare's result envelope", async () => {
    const model = chatCompletionsModel(p, {
      fetch: async () => ok({ success: true, result: completion }),
    });
    const response = await model.createCompletion({ model: "m", messages: [] });
    expect(response.choices).toHaveLength(1);
  });

  it("retries 429 and 5xx, and fails fatally on 401", async () => {
    const statuses = [429, 503];
    const model = chatCompletionsModel(p, {
      sleep: async () => {},
      fetch: async () => {
        const status = statuses.shift();
        return status ? new Response("busy", { status }) : ok(completion);
      },
    });
    await expect(model.createCompletion({ model: "m", messages: [] })).resolves.toBeTruthy();

    const denied = chatCompletionsModel(p, {
      sleep: async () => {},
      fetch: async () => new Response("bad token", { status: 401 }),
    });
    const error = await denied.createCompletion({ model: "m", messages: [] }).catch((e) => e);
    expect(error).toBeInstanceOf(ModelApiError);
    expect(error.message).toContain("401");
    expect(isFatalModelError(error)).toBe(true);
    expect(isFatalModelError(new ModelApiError(400, "bad request"))).toBe(false);
  });

  it("retries network errors and reports their cause, not just 'fetch failed'", async () => {
    const offline = () =>
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.example.test"), {
          code: "ENOTFOUND",
        }),
      });
    let calls = 0;
    const retries: string[] = [];
    const flaky = chatCompletionsModel(p, {
      sleep: async () => {},
      onRetry: ({ reason }) => retries.push(reason),
      fetch: async () => {
        calls += 1;
        if (calls < 3) throw offline();
        return ok(completion);
      },
    });
    await expect(flaky.createCompletion({ model: "m", messages: [] })).resolves.toBeTruthy();
    expect(retries).toEqual([
      "fetch failed, caused by getaddrinfo ENOTFOUND api.example.test",
      "fetch failed, caused by getaddrinfo ENOTFOUND api.example.test",
    ]);

    const down = chatCompletionsModel(p, {
      retries: 2,
      sleep: async () => {},
      fetch: async () => {
        throw offline();
      },
    });
    const error = await down.createCompletion({ model: "m", messages: [] }).catch((e) => e);
    expect(error).toBeInstanceOf(ModelNetworkError);
    expect(error.message).toMatch(/failed after 3 attempt\(s\)/);
    expect(error.message).toContain("ENOTFOUND api.example.test");
  });

  it("retries a timed-out attempt, and passes each attempt a timeout signal", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    let calls = 0;
    const model = chatCompletionsModel(p, {
      sleep: async () => {},
      timeoutMs: 1000,
      fetch: async (_url, init) => {
        signals.push(init?.signal);
        calls += 1;
        if (calls === 1) throw new DOMException("The operation timed out.", "TimeoutError");
        return ok(completion);
      },
    });
    await expect(model.createCompletion({ model: "m", messages: [] })).resolves.toBeTruthy();
    expect(signals).toHaveLength(2);
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
  });
});

describe("describeError", () => {
  it("follows causes, codes and aggregate errors", () => {
    const error = new TypeError("fetch failed", {
      cause: new AggregateError(
        [
          Object.assign(new Error("connect ECONNREFUSED ::1:443"), { code: "ECONNREFUSED" }),
          Object.assign(new Error("connect timed out"), { code: "ETIMEDOUT" }),
        ],
        "",
      ),
    });
    expect(describeError(error)).toBe(
      "fetch failed, caused by AggregateError [connect ECONNREFUSED ::1:443; ETIMEDOUT: connect timed out]",
    );
    expect(describeError("plain")).toBe("plain");
  });
});

describe("samplingFields", () => {
  it("sends DeepSeek's thinking switch only when configured", () => {
    expect(samplingFields({})).toEqual({});
    expect(samplingFields({ thinking: "off", temperature: 0 })).toEqual({
      temperature: 0,
      thinking: { type: "disabled" },
    });
    expect(samplingFields({ thinking: "on", reasoningEffort: "high" })).toEqual({
      reasoning_effort: "high",
      thinking: { type: "enabled" },
    });
  });
});
