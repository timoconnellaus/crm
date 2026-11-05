// CLI pieces shared by the eval runners: the model options, the credentials check and --only.
import { DEFAULT_MODEL, type ModelParams, type Provider, resolveProvider } from "./model.ts";

/** parseArgs option definitions for choosing and tuning the model. */
export const modelCliOptions = {
  model: { type: "string" },
  temperature: { type: "string" },
  "max-tokens": { type: "string" },
  "reasoning-effort": { type: "string" },
  thinking: { type: "string" },
} as const;

export interface ModelChoice {
  /** --model, else EVAL_MODEL, else DEFAULT_MODEL. */
  model: string;
  params: ModelParams;
}

export function parsePositiveInt(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer`);
  return n;
}

export function parseModelArgs(
  values: {
    model?: string | undefined;
    temperature?: string | undefined;
    "max-tokens"?: string | undefined;
    "reasoning-effort"?: string | undefined;
    thinking?: string | undefined;
  },
  env: Record<string, string | undefined>,
): ModelChoice {
  const params: ModelParams = {};
  if (values.temperature !== undefined) {
    const t = Number(values.temperature);
    if (!Number.isFinite(t) || t < 0 || t > 2) {
      throw new Error("--temperature must be a number from 0 to 2");
    }
    params.temperature = t;
  }
  if (values["max-tokens"] !== undefined) {
    params.maxTokens = parsePositiveInt(values["max-tokens"], "--max-tokens");
  }
  if (values["reasoning-effort"]) params.reasoningEffort = values["reasoning-effort"];
  const thinking = (values.thinking ?? env.EVAL_THINKING)?.trim().toLowerCase();
  if (thinking) {
    if (thinking !== "on" && thinking !== "off") {
      throw new Error("--thinking (EVAL_THINKING) must be on or off");
    }
    params.thinking = thinking;
  }
  return { model: values.model || env.EVAL_MODEL?.trim() || DEFAULT_MODEL, params };
}

/** Splits --only into ids and refuses unknown ones. */
export function parseOnly(value: string | undefined, known: string[]): string[] | null {
  if (!value) return null;
  const only = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = only.filter((id) => !known.includes(id));
  if (unknown.length) throw new Error(`Unknown task id(s): ${unknown.join(", ")}`);
  return only;
}

/** The provider, or exit code 2 and a clear message when the credentials are missing. */
export function checkCredentials(
  env: Record<string, string | undefined>,
): { code: 2; message: string } | { provider: Provider } {
  const result = resolveProvider(env);
  return result.ok ? { provider: result.provider } : { code: 2, message: result.message };
}
