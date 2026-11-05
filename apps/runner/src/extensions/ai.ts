// codemode:ai: the model roles extensions may use (summarise, extract, classify), resolved through
// the model role registry in @relationship-os/core (ADR 0009, ADR 0150): shipped defaults (Workers AI) → deploy
// config → Settings → AI overrides, through AI Gateway when AI_GATEWAY_ID is set. Without any
// configured model the module fails with a clear error rather than reaching any network.
import {
  type AiEnv,
  AiNotConfiguredError,
  loadAiSettings,
  type ModelRunner,
  modelRunnerFromEnv,
  platformAiAllowed,
} from "@relationship-os/core";
import { createCrmDb } from "@relationship-os/db";

export { AiNotConfiguredError };

/** The registry-backed runner for ros-runner's environment, or null without AI. */
export function runnerModels(env: object): ModelRunner | null {
  const e = env as AiEnv & { DB?: D1Database };
  const db = e.DB ? createCrmDb(e.DB) : null;
  return (
    modelRunnerFromEnv(e, {
      ...(db
        ? {
            loadSettings: () => loadAiSettings(db.query),
            // Hosted plans (ADR 0211): platform AI only while the allowance lasts; BYOK always.
            platformAi: () => platformAiAllowed(db.query),
          }
        : {}),
    }) ?? null
  );
}

function prompt(role: "summarise" | "extract" | "classify", args: readonly unknown[]): string {
  const text = String(args[0] ?? "").slice(0, 20_000);
  switch (role) {
    case "summarise": {
      const options = (args[1] ?? {}) as { maxWords?: number };
      return `Summarise the text below in at most ${options.maxWords ?? 80} words. Reply with the summary only.\n\n${text}`;
    }
    case "extract":
      return `Extract these fields from the text below and reply with one JSON object only: ${JSON.stringify(args[1] ?? {})}\n\n${text}`;
    case "classify":
      return `Classify the text below as exactly one of: ${JSON.stringify(args[1] ?? [])}. Reply with the label only.\n\n${text}`;
  }
}

/**
 * Model role `build` for one prompt: the AI-written summary of an extension proposal. Null when
 * the deployment has no AI (the approval screen then says no AI summary is available).
 */
export async function runBuildRole(
  env: object,
  input: string,
): Promise<{ text: string; model: string } | null> {
  const models = runnerModels(env);
  if (!models) return null;
  const result = await models.run("build", [{ role: "user", content: input }], { maxTokens: 400 });
  return result.text ? { text: result.text, model: result.model } : null;
}

export async function runModelRole(
  env: object,
  role: "summarise" | "extract" | "classify",
  args: readonly unknown[],
): Promise<unknown> {
  const models = runnerModels(env);
  if (!models) {
    throw new AiNotConfiguredError(
      "AI is not configured for this deployment: add an `ai` binding to ros-runner (docs/deploying.md)",
    );
  }
  const { text } = await models.run(role, [{ role: "user", content: prompt(role, args) }]);
  if (role === "summarise") return text;
  if (role === "classify") {
    const labels = (args[1] as string[] | undefined) ?? [];
    const label =
      labels.find((l) => text.toLowerCase().includes(l.toLowerCase())) ?? labels[0] ?? "";
    return { label };
  }
  try {
    const match = /\{[\s\S]*\}/.exec(text);
    return match ? (JSON.parse(match[0]) as unknown) : {};
  } catch {
    return {};
  }
}
