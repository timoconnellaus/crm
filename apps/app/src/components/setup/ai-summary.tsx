// The setup wizard's AI step (ADR 0167, amended): what this deployment's model roles actually
// resolve to, from the same data as Settings → AI (ai.settings: provider, model, source and
// readiness per role). It describes; it changes nothing. Changes are made in Settings → AI.
import type { CoreOutput } from "@relationship-os/core";
import { CheckCircle2Icon, CircleAlertIcon, CpuIcon } from "lucide-react";

type Settings = CoreOutput<"ai.settings">;
type Role = Settings["roles"][number];

/** How the wizard names a role in a sentence. `embed` is what semantic search runs on. */
const ROLE_NAMES: Record<string, string> = {
  build: "build",
  assistant: "assistant",
  summarise: "summarise",
  extract: "extract",
  classify: "classify",
  embed: "search",
  vision: "vision",
  review: "review",
};

const SOURCE_PHRASES: Record<Role["source"], string> = {
  shipped: "the shipped defaults",
  deploy: "its deploy configuration",
  admin: "Settings → AI",
};

export interface AiSetupLine {
  /** What runs, e.g. "DeepSeek V4.1 Flash" or "Workers AI in your Cloudflare account". */
  what: string;
  roles: string[];
  /** e.g. "every role except search". */
  where: string;
  /** e.g. "its deploy configuration"; null when the roles' sources differ. */
  from: string | null;
}

export interface AiSetupSummary {
  configured: boolean;
  lines: AiSetupLine[];
  /** One sentence per line, e.g. "This deployment is set up for … on …, from …". */
  sentences: string[];
  /** Readiness problems, one per provider in use that is not ready. */
  problems: { provider: string; label: string; reason: string; roles: string[] }[];
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function rolesPhrase(roles: string[], all: string[]): string {
  if (roles.length === all.length) return "every role";
  const missing = all.filter((r) => !roles.includes(r));
  if (missing.length <= 2 && roles.length > missing.length) {
    return `every role except ${list(missing)}`;
  }
  return `the ${list(roles)} ${roles.length === 1 ? "role" : "roles"}`;
}

/** "DeepSeek V4.1 Flash", or "GPT-4.1 mini (OpenAI)" when the model's name doesn't say. */
function modelWithProvider(model: string, provider: string): string {
  return model.toLowerCase().startsWith(provider.toLowerCase()) ? model : `${model} (${provider})`;
}

/** Describes the resolved role table in plain words: what runs where, and from which layer. */
export function describeAiSetup(settings: Settings): AiSetupSummary {
  const providerLabel = (id: string) => settings.providers.find((p) => p.id === id)?.label ?? id;
  const all = settings.roles.map((r) => ROLE_NAMES[r.role] ?? r.role);
  // One line per provider, largest first: Workers AI runs a different model per role, so it is
  // named as a provider; another provider with one model for all its roles is named by model.
  const byProvider = new Map<string, Role[]>();
  for (const role of settings.roles) {
    byProvider.set(role.provider, [...(byProvider.get(role.provider) ?? []), role]);
  }
  const lines = [...byProvider.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([provider, roles]): AiSetupLine => {
      const names = roles.map((r) => ROLE_NAMES[r.role] ?? r.role);
      const models = new Set(roles.map((r) => r.label));
      const what =
        provider === "workers-ai"
          ? "Workers AI in your Cloudflare account"
          : provider === "platform"
            ? "Platform AI, included with your plan"
            : models.size === 1
              ? modelWithProvider([...models][0] as string, providerLabel(provider))
              : providerLabel(provider);
      const sources = new Set(roles.map((r) => r.source));
      const source = sources.size === 1 ? ([...sources][0] as Role["source"]) : null;
      return {
        what,
        roles: names,
        where: rolesPhrase(names, all),
        from: source ? SOURCE_PHRASES[source] : null,
      };
    });
  const sentences = lines.map((line, i) => {
    const from = line.from ? `, from ${line.from}` : ", from more than one source";
    return i === 0
      ? `This deployment is set up for ${line.what} on ${line.where}${from}.`
      : `${line.where.charAt(0).toUpperCase()}${line.where.slice(1)} ${line.roles.length === 1 ? "uses" : "use"} ${line.what}${from}.`;
  });
  const problems = [...byProvider.entries()].flatMap(([provider, roles]) => {
    const notReady = roles.filter((r) => !r.ready);
    if (notReady.length === 0) return [];
    return [
      {
        provider,
        label: providerLabel(provider),
        reason: notReady[0]?.notReadyReason ?? "Not configured",
        roles: notReady.map((r) => ROLE_NAMES[r.role] ?? r.role),
      },
    ];
  });
  return { configured: settings.configured, lines, sentences, problems };
}

/** The AI step's body: the summary, each provider's roles, and readiness problems. */
export function AiSetupSummaryView({ settings }: { settings: Settings }) {
  const summary = describeAiSetup(settings);
  return (
    <div className="grid gap-3" data-testid="setup-ai-summary">
      <div className="grid gap-1.5 rounded-lg border p-3 text-sm">
        {summary.sentences.map((sentence, i) => (
          <p
            key={sentence}
            className={
              i === 0 ? "flex items-start gap-2 font-medium" : "pl-6 text-muted-foreground"
            }
            data-testid="setup-ai-line"
          >
            {i === 0 && <CpuIcon className="mt-0.5 size-4 shrink-0" aria-hidden />}
            <span className="min-w-0">{sentence}</span>
          </p>
        ))}
      </div>
      {!summary.configured && (
        <p
          className="flex items-start gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm"
          role="note"
          data-testid="setup-ai-not-configured"
        >
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            AI is not configured for this deployment yet: it needs the Workers AI binding or a
            provider key. AI features say so until then.
          </span>
        </p>
      )}
      {summary.problems.length > 0 ? (
        <ul className="grid gap-1.5 text-sm" aria-label="AI readiness problems">
          {summary.problems.map((p) => (
            <li
              key={p.provider}
              className="flex items-start gap-2 text-destructive"
              data-testid="setup-ai-problem"
            >
              <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span className="min-w-0 break-words">
                {p.label}: {p.reason}. Affects {list(p.roles)}.
              </span>
            </li>
          ))}
        </ul>
      ) : (
        summary.configured && (
          <p
            className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400"
            data-testid="setup-ai-ready"
          >
            <CheckCircle2Icon className="size-4 shrink-0" aria-hidden />
            Every role is ready.
          </p>
        )
      )}
    </div>
  );
}
