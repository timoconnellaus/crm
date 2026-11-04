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
