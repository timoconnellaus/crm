// codemode:ai: the model roles extensions may use (summarise, extract, classify), resolved through
// the minimal role → model mapping in @crm/core (ADR 0009). Workers AI is the default provider;
// calls go through AI Gateway when AI_GATEWAY_ID is set. Without an `ai` binding the module fails
// with a clear error rather than reaching any network.
import { type ModelRole, modelFor } from "@crm/core";

interface AiBinding {
  run(
    model: string,
    input: { messages: { role: string; content: string }[]; max_tokens?: number },
    options?: { gateway?: { id: string } },
  ): Promise<{ response?: string } | unknown>;
}

interface AiEnv {
  AI?: AiBinding;
  AI_GATEWAY_ID?: string;
}

export class AiNotConfiguredError extends Error {
  override name = "AiNotConfiguredError";
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

export async function runModelRole(
  env: object,
  role: "summarise" | "extract" | "classify",
  args: readonly unknown[],
): Promise<unknown> {
  const { AI, AI_GATEWAY_ID } = env as AiEnv;
  if (!AI) {
    throw new AiNotConfiguredError(
      "AI is not configured for this deployment: add an `ai` binding to crm-runner (docs/deploying.md)",
    );
  }
  const choice = modelFor(role as ModelRole);
  const result = (await AI.run(
    choice.model,
    { messages: [{ role: "user", content: prompt(role, args) }], max_tokens: choice.maxTokens },
    AI_GATEWAY_ID ? { gateway: { id: AI_GATEWAY_ID } } : {},
  )) as { response?: string };
  const text = (result.response ?? "").trim();
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
