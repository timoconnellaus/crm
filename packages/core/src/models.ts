// The minimal model-role mapping stage 3 needs (ADR 0009): code asks for a role, never a model.
// The roles extensions use (`summarise`, `extract`, `classify`) and `build` (the AI-written summary
// on an extension proposal, stage 3b) are mapped, all to Workers AI by default; calls go through
// AI Gateway when one is configured. Workers AI is the default provider for every role. The full registry
// (capabilities, fallbacks, admin overrides, other providers) comes with the stage that needs it.

export const MODEL_ROLES = [
  "build",
  "assistant",
  "summarise",
  "extract",
  "classify",
  "embed",
  "vision",
  "review",
] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

export interface ModelChoice {
  provider: "workers-ai";
  model: string;
  /** Upper bound on generated tokens. */
  maxTokens: number;
}

/** Shipped defaults: the roles extensions can use through `codemode:ai`, and `build`. */
export const DEFAULT_MODEL_ROLES: Partial<Record<ModelRole, ModelChoice>> = {
  build: {
    provider: "workers-ai",
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    maxTokens: 400,
  },
  summarise: {
    provider: "workers-ai",
    model: "@cf/meta/llama-3.1-8b-instruct-fast",
    maxTokens: 512,
  },
  extract: { provider: "workers-ai", model: "@cf/meta/llama-3.1-8b-instruct-fast", maxTokens: 512 },
  classify: { provider: "workers-ai", model: "@cf/meta/llama-3.1-8b-instruct-fast", maxTokens: 64 },
};

/** Resolves a role to its model, or throws a clear configuration error. */
export function modelFor(role: ModelRole): ModelChoice {
  const choice = DEFAULT_MODEL_ROLES[role];
  if (!choice) throw new Error(`No model is configured for the ${role} role`);
  return choice;
}

// ---------------------------------------------------------------------------------------------
// Running a role from crm-app (stage 4a: "Describe a widget"). crm-runner has its own copy for
// extension code (apps/runner/src/extensions/ai.ts); both resolve roles through `modelFor`.

export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelRunResult {
  text: string;
  /** The model that answered (or `fake` for the local stand-in). */
  model: string;
}

/** Runs a model role. Operations get one as `ctx.models` when the deployment has AI. */
export interface ModelRunner {
  run(
    role: ModelRole,
    messages: readonly ModelMessage[],
    options?: { maxTokens?: number },
  ): Promise<ModelRunResult>;
}

/** The Workers AI binding's `run`, as far as roles need it. */
export interface WorkersAiBinding {
  run(
    model: string,
    input: { messages: ModelMessage[]; max_tokens?: number; temperature?: number },
    options?: { gateway?: { id: string } },
  ): Promise<unknown>;
}

/** Text out of a Workers AI response (`{ response }`, or OpenAI-style `choices`). */
function responseText(result: unknown): string {
  if (typeof result === "string") return result;
  const r = result as {
    response?: unknown;
    choices?: { message?: { content?: unknown } }[];
  };
  if (typeof r?.response === "string") return r.response;
  if (r?.response && typeof r.response === "object") return JSON.stringify(r.response);
  const content = r?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

/**
 * Model roles over the Workers AI binding (ADR 0009), through AI Gateway when `gatewayId` is
 * set. Workers AI is the default provider for every role; no third-party key is needed.
 */
export function workersAiModels(ai: WorkersAiBinding, gatewayId?: string): ModelRunner {
  return {
    async run(role, messages, options = {}) {
      const choice = modelFor(role);
      const result = await ai.run(
        choice.model,
        {
          messages: messages.map((m) => ({ ...m, content: m.content.slice(0, 60_000) })),
          max_tokens: options.maxTokens ?? choice.maxTokens,
          temperature: 0.1,
        },
        gatewayId ? { gateway: { id: gatewayId } } : {},
      );
      return { text: responseText(result).trim(), model: choice.model };
    },
  };
}

/**
 * The model runner for an adapter's environment: Workers AI when an `AI` binding exists, else a
 * local stand-in when `AI_FAKE_MODEL` is "true" (local dev and e2e only; see
 * docs/deploying.md), else none ("AI is not configured").
 */
export function modelRunnerFromEnv(
  env: { AI?: unknown; AI_GATEWAY_ID?: string; AI_FAKE_MODEL?: string },
  fake?: () => ModelRunner,
): ModelRunner | undefined {
  if (env.AI && typeof (env.AI as WorkersAiBinding).run === "function") {
    return workersAiModels(env.AI as WorkersAiBinding, env.AI_GATEWAY_ID || undefined);
  }
  if (env.AI_FAKE_MODEL === "true" && fake) return fake();
  return undefined;
}
