// The minimal model-role mapping stage 3 needs (ADR 0009): code asks for a role, never a model.
// Only the bulk roles extensions use (`summarise`, `extract`, `classify`) are mapped, all to Workers
// AI by default; calls go through AI Gateway when one is configured. The full registry
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

/** Shipped defaults for the roles extensions can use through `codemode:ai`. */
export const DEFAULT_MODEL_ROLES: Partial<Record<ModelRole, ModelChoice>> = {
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
