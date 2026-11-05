// Settings → AI (admins, ADRs 0150-0155): each model role's provider, model, capabilities,
// fallback and where the setting comes from, with Edit (capability-checked by ai.updateRole) and
// Test and a review-independence warning; provider keys stored in AI Gateway (BYOK, the default
// with a gateway) or as Workers secrets (never shown); usage and spend
// per role from AI Gateway; and the semantic search index.
import type { CoreOutput } from "@relationship-os/core";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@relationship-os/ui/components/alert-dialog";
import { Badge } from "@relationship-os/ui/components/badge";
import { Button } from "@relationship-os/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@relationship-os/ui/components/card";
import { Checkbox } from "@relationship-os/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@relationship-os/ui/components/dialog";
import { Input } from "@relationship-os/ui/components/input";
import { Label } from "@relationship-os/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@relationship-os/ui/components/select";
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@relationship-os/ui/components/table";
import { createFileRoute } from "@tanstack/react-router";
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  LockIcon,
  PencilIcon,
  PlayIcon,
  XCircleIcon,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { PageLayout } from "#/components/layout/page-layout";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

export const Route = createFileRoute("/_app/settings/ai")({ component: AiSettingsPage });

type Settings = CoreOutput<"ai.settings">;
type Role = Settings["roles"][number];
type Provider = Settings["providers"][number];
type ProviderId = Provider["id"];
type Capabilities = Role["capabilities"];
type TestResult = CoreOutput<"ai.testRole">;

const DOCS_URL =
  "https://github.com/timoconnellaus/relationship-os/blob/main/docs/deploying.md#in-app-ai";

const ROLE_TITLES: Record<string, string> = {
  build: "Build",
  assistant: "Assistant",
  summarise: "Summarise",
  extract: "Extract",
  classify: "Classify",
  embed: "Embeddings",
  vision: "Vision",
  review: "Review",
};

const SOURCE_LABELS: Record<Role["source"], string> = {
  shipped: "Default",
  deploy: "Deploy config",
  admin: "Set here",
};

/** Providers whose models are not in the catalogue: the model is typed with its capabilities. */
const FREE_TEXT_PROVIDERS = new Set<ProviderId>(["openai-compatible", "jev", "custom"]);
const OTHER_MODEL = "__other__";
const NO_FALLBACK = "__none__";

function contextLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M context`;
  return `${Math.round(tokens / 1000)}K context`;
}

function money(n: number): string {
  return n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  });
}

function AiSettingsPage() {
  const { isAdmin } = Route.useRouteContext();
  return (
    <PageLayout
      title="AI"
      width="md"
      back={{ to: "/settings", label: "Settings" }}
      description="Which model each AI feature uses, provider keys, usage and semantic search."
    >
      {isAdmin ? (
        <AiSettings />
      ) : (
        <p
          className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm"
          role="note"
        >
          <LockIcon className="size-4" aria-hidden />
          Only admins can see and change AI settings.
        </p>
      )}
    </PageLayout>
  );
}

function AiSettings() {
  const settings = useOp("ai.settings", {});
  if (settings.isPending) return <Skeleton className="h-64 w-full" />;
  if (settings.isError || !settings.data) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {errorMessage(settings.error)}
      </p>
    );
  }
  const data = settings.data;
  return (
    <div className="grid gap-6">
      {!data.configured && (
        <p
          className="flex items-start gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm"
          role="note"
        >
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            AI is not configured for this deployment: add the Workers AI binding or a provider key.{" "}
            <DocsLink />
          </span>
        </p>
      )}
      <RolesSection settings={data} />
      <ProvidersSection settings={data} />
      <UsageCard />
      <SemanticSearchCard search={data.semanticSearch} />
    </div>
  );
}

function DocsLink() {
  return (
    <a
      href={DOCS_URL}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 underline underline-offset-2"
    >
      In-app AI in the deployment guide
      <ExternalLinkIcon className="size-3" aria-hidden />
    </a>
  );
}

// --- Model roles -------------------------------------------------------------------------------

function CapabilityBadges({ capabilities }: { capabilities: Capabilities }) {
  const flags: [boolean, string][] = [
    [capabilities.toolUse, "Tools"],
    [capabilities.jsonSchema, "JSON schema"],
    [!capabilities.jsonSchema && capabilities.jsonObject === true, "JSON mode"],
    [capabilities.vision, "Vision"],
    [capabilities.embedding, "Embeddings"],
  ];
  return (
    <span className="flex flex-wrap gap-1">
      {flags
        .filter(([on]) => on)
        .map(([, label]) => (
          <Badge key={label} variant="secondary" className="font-normal">
            {label}
          </Badge>
        ))}
      <Badge variant="outline" className="font-normal">
        {contextLabel(capabilities.contextTokens)}
      </Badge>
      {capabilities.dimensions ? (
        <Badge variant="outline" className="font-normal">
          {capabilities.dimensions} dimensions
        </Badge>
      ) : null}
    </span>
  );
}

function RolesSection({ settings }: { settings: Settings }) {
  const [editing, setEditing] = useState<Role | null>(null);
  const providerLabel = (id: string) => settings.providers.find((p) => p.id === id)?.label ?? id;
  const modelLabel = (provider: string, model: string) =>
    settings.catalogue.find((m) => m.provider === provider && m.model === model)?.label ?? model;
  return (
    <section aria-labelledby="ai-roles" className="grid gap-3">
      <div className="grid gap-1">
        <h2 id="ai-roles" className="text-base font-semibold">
          Model roles
        </h2>
        <p className="text-sm text-muted-foreground">
          Each AI feature asks for a role, never a model. Choose the model behind each role; a model
          must have every capability its role needs.
        </p>
      </div>
      <div className="grid gap-3">
        {settings.roles.map((role) => (
          <RoleCard
            key={role.role}
            role={role}
            providerLabel={providerLabel}
            fallbackLabel={
              role.fallback
                ? `${modelLabel(role.fallback.provider, role.fallback.model)} (${providerLabel(role.fallback.provider)})`
                : null
            }
            onEdit={() => setEditing(role)}
          />
        ))}
      </div>
      {editing && (
        <EditRoleDialog
          key={editing.role}
          role={editing}
          settings={settings}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function RoleCard({
  role,
  providerLabel,
  fallbackLabel,
  onEdit,
}: {
  role: Role;
  providerLabel: (id: string) => string;
  fallbackLabel: string | null;
  onEdit: () => void;
}) {
  const test = useOpMutation("ai.testRole");
  const [result, setResult] = useState<TestResult | null>(null);
  const title = ROLE_TITLES[role.role] ?? role.role;

  async function runTest() {
    setResult(null);
    try {
      setResult(await test.mutateAsync({ role: role.role }));
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <Card className="gap-3 py-4" data-testid={`ai-role-${role.role}`} aria-label={`${title} role`}>
      <CardHeader className="px-4">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          {title}
          <Badge variant="outline" className="font-normal" data-testid="role-source">
            {SOURCE_LABELS[role.source]}
          </Badge>
          {role.ready ? (
            <Badge variant="secondary" className="font-normal">
              Ready
            </Badge>
          ) : (
            <Badge variant="destructive" className="font-normal">
              Not ready
            </Badge>
          )}
        </CardTitle>
        <CardDescription>{role.requirements.description}</CardDescription>
        <CardAction className="flex gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void runTest()}
            disabled={test.isPending}
            aria-label={`Test the ${title} role`}
          >
            <PlayIcon />
            {test.isPending ? "Testing…" : "Test"}
          </Button>
          <Button variant="ghost" size="sm" onClick={onEdit} aria-label={`Edit the ${title} role`}>
            <PencilIcon />
            <span className="max-sm:sr-only">Edit</span>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-2 px-4 text-sm">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2" data-testid="role-model">
          <span className="font-medium">{role.label}</span>
          <span className="text-muted-foreground">{providerLabel(role.provider)}</span>
          {role.label !== role.model && (
            <code className="min-w-0 truncate text-xs text-muted-foreground">{role.model}</code>
          )}
        </div>
        <CapabilityBadges capabilities={role.capabilities} />
        <p className="text-muted-foreground">
          Fallback: {fallbackLabel ?? "none"}
          {" · "}
          {role.params.maxTokens.toLocaleString()} tokens max · temperature{" "}
          {role.params.temperature}
        </p>
        {!role.ready && role.notReadyReason && (
          <p className="text-destructive" data-testid="role-not-ready">
            {role.notReadyReason}
          </p>
        )}
        {role.warnings.map((warning) => (
          <p
            key={warning}
            className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400"
            role="note"
            data-testid="role-warning"
          >
            <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0">{warning}</span>
          </p>
        ))}
        {role.ignored.map((layer) => (
          <p key={layer.layer} className="text-xs text-amber-700 dark:text-amber-400">
            Ignored the {layer.layer} setting: {layer.problems.join("; ")}
          </p>
        ))}
        {result && (
          <p
            className={
              result.ok
                ? "flex items-start gap-1.5 text-emerald-700 dark:text-emerald-400"
                : "flex items-start gap-1.5 text-destructive"
            }
            role="status"
            data-testid="role-test-result"
            data-ok={result.ok}
          >
            {result.ok ? (
              <CheckCircle2Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
            ) : (
              <XCircleIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
            )}
            <span className="min-w-0 break-words">
              {result.ok
                ? `OK in ${result.ms} ms · ${result.model ?? "unknown model"}`
                : `Failed: ${result.error ?? "no answer"}`}
            </span>
          </p>
        )}
      </CardContent>
    </Card>
  );
}

const CUSTOM_DEFAULT: Capabilities = {
  chat: true,
  toolUse: false,
  jsonSchema: false,
  jsonObject: false,
  vision: false,
  embedding: false,
  contextTokens: 32_000,
};

function EditRoleDialog({
  role,
  settings,
  onClose,
}: {
  role: Role;
  settings: Settings;
  onClose: () => void;
}) {
  const update = useOpMutation("ai.updateRole", { invalidates: ["ai."] });
  const test = useOpMutation("ai.testRole");
  const title = ROLE_TITLES[role.role] ?? role.role;
  const [provider, setProvider] = useState<ProviderId>(role.provider);
  const listed = (p: ProviderId) => settings.catalogue.filter((m) => m.provider === p);
  const inCatalogue = listed(role.provider).some((m) => m.model === role.model);
  const [model, setModel] = useState<string>(inCatalogue ? role.model : OTHER_MODEL);
  const [customModel, setCustomModel] = useState(inCatalogue ? "" : role.model);
  const [caps, setCaps] = useState<Capabilities>(
    inCatalogue ? { ...CUSTOM_DEFAULT, embedding: role.requirements.embedding } : role.capabilities,
  );
  const [fallback, setFallback] = useState<string>(
    role.fallback ? `${role.fallback.provider}|${role.fallback.model}` : NO_FALLBACK,
  );
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const models = listed(provider);
  const freeText =
    FREE_TEXT_PROVIDERS.has(provider) || models.length === 0 || model === OTHER_MODEL;
  const chosenModel = freeText ? customModel.trim() : model;
  const fallbackOptions = settings.catalogue.map((m) => ({
    value: `${m.provider}|${m.model}`,
    label: `${m.label} (${settings.providers.find((p) => p.id === m.provider)?.label ?? m.provider})`,
  }));
  if (fallback !== NO_FALLBACK && !fallbackOptions.some((o) => o.value === fallback)) {
    fallbackOptions.push({ value: fallback, label: fallback.split("|")[1] ?? fallback });
  }

  function onProvider(next: string) {
    const id = next as ProviderId;
    setProvider(id);
    const first = listed(id)[0];
    setModel(first && !FREE_TEXT_PROVIDERS.has(id) ? first.model : OTHER_MODEL);
    setError(null);
    setTestResult(null);
  }

  function target() {
    return {
      provider,
      model: chosenModel,
      ...(freeText ? { capabilities: { ...caps, chat: !caps.embedding } } : {}),
    };
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!chosenModel) {
      setError("Choose or type a model");
      return;
    }
    const [fbProvider, ...fbModel] = fallback.split("|");
    try {
      await update.mutateAsync({
        role: role.role,
        ...target(),
        fallback:
          fallback === NO_FALLBACK
            ? null
            : { provider: fbProvider as ProviderId, model: fbModel.join("|") },
      });
      toast.success(`The ${title} role now uses ${chosenModel}`);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function reset() {
    setError(null);
    try {
      await update.mutateAsync({ role: role.role, reset: true });
      toast.success(`The ${title} role is back to its default`);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function tryIt() {
    setTestResult(null);
    if (!chosenModel) return;
    try {
      setTestResult(await test.mutateAsync({ role: role.role, target: target() }));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={(e) => void save(e)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Edit the {title} role</DialogTitle>
            <DialogDescription>{role.requirements.description}</DialogDescription>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            Needs:{" "}
            {[
              role.requirements.toolUse && "tool use",
              role.requirements.jsonSchema
                ? "JSON schema output"
                : role.requirements.json && "JSON output",
              role.requirements.vision && "vision",
              role.requirements.embedding && "embeddings",
              `${contextLabel(role.requirements.minContextTokens)} or more`,
            ]
              .filter(Boolean)
              .join(", ")}
            .
          </p>
          <div className="grid gap-2">
            <Label htmlFor="ai-provider">Provider</Label>
            <Select value={provider} onValueChange={onProvider}>
              <SelectTrigger id="ai-provider" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {settings.providers.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                    {!p.ready ? " (not set up)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {!FREE_TEXT_PROVIDERS.has(provider) && models.length > 0 && (
            <div className="grid gap-2">
              <Label htmlFor="ai-model">Model</Label>
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger id="ai-model" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {models.map((m) => (
                    <SelectItem key={m.model} value={m.model}>
                      {m.label}
                    </SelectItem>
                  ))}
                  <SelectItem value={OTHER_MODEL}>Other model…</SelectItem>
                </SelectContent>
              </Select>
              {model !== OTHER_MODEL && (
                <CapabilityBadges
                  capabilities={
                    models.find((m) => m.model === model)?.capabilities ?? role.capabilities
                  }
                />
              )}
            </div>
          )}
          {freeText && (
            <fieldset className="grid gap-3 rounded-md border p-3">
              <legend className="px-1 text-sm font-medium">Model and its capabilities</legend>
              <div className="grid gap-2">
                <Label htmlFor="ai-custom-model">Model id</Label>
                <Input
                  id="ai-custom-model"
                  value={customModel}
                  onChange={(e) => setCustomModel(e.target.value)}
                  placeholder={provider === "custom" ? "custom-<slug>/<model>" : "e.g. my-model-v2"}
                  autoComplete="off"
                />
                {provider === "custom" && (
                  <p className="text-xs text-muted-foreground">
                    The AI Gateway custom provider and model, as the gateway names them, e.g.{" "}
                    <code>custom-together/deepseek-ai/DeepSeek-V4.1-Flash-1017</code>.
                  </p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    ["toolUse", "Tool use"],
                    ["jsonSchema", "JSON schema"],
                    ["jsonObject", "JSON mode"],
                    ["vision", "Vision"],
                    ["embedding", "Embeddings"],
                  ] as const
                ).map(([key, label]) => (
                  <Label key={key} className="flex items-center gap-2 font-normal">
                    <Checkbox
                      checked={caps[key] === true}
                      onCheckedChange={(checked) =>
                        setCaps((c) => ({ ...c, [key]: checked === true }))
                      }
                    />
                    {label}
                  </Label>
                ))}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="ai-context">Context window (tokens)</Label>
                <Input
                  id="ai-context"
                  type="number"
                  min={1}
                  value={caps.contextTokens}
                  onChange={(e) =>
                    setCaps((c) => ({ ...c, contextTokens: Number(e.target.value) || 1 }))
                  }
                />
              </div>
            </fieldset>
          )}
          <div className="grid gap-2">
            <Label htmlFor="ai-fallback">Fallback</Label>
            <Select value={fallback} onValueChange={setFallback}>
              <SelectTrigger id="ai-fallback" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_FALLBACK}>No fallback</SelectItem>
                {fallbackOptions.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Used when the model fails or its provider is down.
            </p>
          </div>
          {testResult && (
            <p
              className={
                testResult.ok
                  ? "text-sm text-emerald-700 dark:text-emerald-400"
                  : "text-sm text-destructive"
              }
              role="status"
            >
              {testResult.ok
                ? `OK in ${testResult.ms} ms · ${testResult.model ?? ""}`
                : `Failed: ${testResult.error ?? "no answer"}`}
            </p>
          )}
          {error && (
            <p className="text-sm text-destructive" role="alert" data-testid="role-edit-error">
              {error}
            </p>
          )}
          <DialogFooter className="gap-2 sm:justify-between">
            <Button
              type="button"
              variant="ghost"
              onClick={() => void reset()}
              disabled={update.isPending || role.source !== "admin"}
            >
              Reset to default
            </Button>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button
                type="button"
                variant="outline"
                onClick={() => void tryIt()}
                disabled={test.isPending || !chosenModel}
              >
                {test.isPending ? "Testing…" : "Test"}
              </Button>
              <Button type="submit" disabled={update.isPending}>
                {update.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- Provider keys -----------------------------------------------------------------------------

function ProvidersSection({ settings }: { settings: Settings }) {
  const [adding, setAdding] = useState<Provider | null>(null);
  const [removing, setRemoving] = useState<Provider | null>(null);
  const remove = useOpMutation("ai.deleteProviderKey", { invalidates: ["ai."] });
  const keyed = settings.providers.filter((p) => p.needsKey);
  const modes = settings.admin.keyModes;

  async function onRemove() {
    if (!removing || removing.id === "workers-ai") return;
    try {
      await remove.mutateAsync({ provider: removing.id });
      toast.success(`Removed the ${removing.label} key`);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setRemoving(null);
    }
  }

  return (
    <Card data-testid="ai-providers">
      <CardHeader>
        <CardTitle>Provider keys</CardTitle>
        <CardDescription>
          Workers AI needs no key. Other providers need an API key, stored in AI Gateway (BYOK, the
          default when there is a gateway) or as a Workers secret. Keys go straight to Cloudflare
          and are never shown again.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {modes.length === 0 && (
          <div
            className="grid gap-2 rounded-md border bg-muted/50 px-3 py-2.5 text-sm"
            role="note"
            data-testid="ai-key-instructions"
          >
            <p className="font-medium">Adding keys here needs Cloudflare API access</p>
            <ul className="grid list-disc gap-1 pl-5 text-muted-foreground">
              <li>
                Set the <code>CLOUDFLARE_ACCOUNT_ID</code> variable on ros-app.
              </li>
              <li>
                Add the <code>CLOUDFLARE_API_TOKEN</code> secret: a token with Workers Scripts
                Write; for BYOK also AI Gateway Edit and Secrets Store Write; for usage, AI Gateway
                Read.
              </li>
            </ul>
            {settings.admin.missing.length > 0 && (
              <p className="text-muted-foreground">Missing: {settings.admin.missing.join(", ")}.</p>
            )}
            <p>
              <DocsLink />
            </p>
          </div>
        )}
        <ul className="divide-y rounded-md border" aria-label="Providers">
          {keyed.map((p) => (
            <li
              key={p.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 text-sm"
              data-testid={`ai-provider-${p.id}`}
            >
              <div className="grid min-w-0 flex-1 gap-0.5">
                <span className="flex flex-wrap items-center gap-2 font-medium">
                  {p.label}
                  {p.id === "custom" && p.ready ? (
                    <Badge variant="outline" className="font-normal text-muted-foreground">
                      Keys in AI Gateway, per provider
                    </Badge>
                  ) : p.ready ? (
                    <Badge variant="secondary" className="font-normal">
                      <KeyRoundIcon aria-hidden />
                      {p.keySource === "byok" ? "Key in AI Gateway" : "Key set"}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="font-normal text-muted-foreground">
                      No key
                    </Badge>
                  )}
                </span>
                {!p.ready && p.reason && (
                  <span className="text-xs text-muted-foreground">{p.reason}</span>
                )}
              </div>
              {modes.length > 0 && (p.id !== "custom" || modes.includes("byok")) && (
                <div className="flex gap-2">
                  {p.id !== "custom" &&
                    p.ready &&
                    (p.keySource === "secret" || p.keySource === "byok") && (
                      <Button variant="ghost" size="sm" onClick={() => setRemoving(p)}>
                        Remove
                      </Button>
                    )}
                  <Button variant="outline" size="sm" onClick={() => setAdding(p)}>
                    {p.ready && p.id !== "custom" ? "Replace key" : "Add key"}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
      {adding && (
        <AddKeyDialog
          key={adding.id}
          provider={adding}
          modes={modes}
          gateway={settings.admin.gateway}
          onClose={() => setAdding(null)}
        />
      )}
      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the {removing?.label} key?</AlertDialogTitle>
            <AlertDialogDescription>
              Roles using {removing?.label} stop working (their fallback is used, if any).
              {removing?.keySource === "byok" ? " Remove the key from AI Gateway as well." : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void onRemove()}>Remove key</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

const MODE_LABELS = {
  secret: "Workers secret",
  byok: "AI Gateway (BYOK)",
} as const;

function AddKeyDialog({
  provider,
  modes,
  gateway,
  onClose,
}: {
  provider: Provider;
  modes: Settings["admin"]["keyModes"];
  gateway: string | null;
  onClose: () => void;
}) {
  const store = useOpMutation("ai.setProviderKey", { invalidates: ["ai."] });
  const custom = provider.id === "custom";
  // BYOK in the deployment's AI Gateway when there is one (ADR 0203); a custom provider exists
  // only in the gateway, so its key is BYOK only.
  const available = custom ? modes.filter((m) => m === "byok") : modes;
  const [apiKey, setApiKey] = useState("");
  const [slug, setSlug] = useState("");
  const [mode, setMode] = useState<(typeof modes)[number]>(
    available.includes("byok") ? "byok" : (available[0] ?? "secret"),
  );
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (provider.id === "workers-ai") return;
    setError(null);
    try {
      const out = await store.mutateAsync({
        provider: provider.id,
        apiKey,
        mode,
        ...(custom ? { customProvider: slug.trim() } : {}),
      });
      setApiKey("");
      toast.success(
        out.stored === "byok"
          ? `${provider.label} key stored in AI Gateway`
          : `${provider.label} key stored as a secret on ${out.targets.join(", ")}`,
      );
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={(e) => void submit(e)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{provider.label} API key</DialogTitle>
            <DialogDescription>
              The key goes straight to Cloudflare. It is never stored in the database or shown
              again.
            </DialogDescription>
          </DialogHeader>
          {custom && (
            <div className="grid gap-2">
              <Label htmlFor="ai-custom-slug">Custom provider</Label>
              <Input
                id="ai-custom-slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="together"
                autoComplete="off"
                required
              />
              <p className="text-xs text-muted-foreground">
                Its slug in AI Gateway. The key is stored under <code>custom-{"<slug>"}</code>.
              </p>
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="ai-api-key">API key</Label>
            <Input
              id="ai-api-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              required
              minLength={8}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ai-key-mode">Store it as</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
              <SelectTrigger id="ai-key-mode" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {available.map((m) => (
                  <SelectItem key={m} value={m}>
                    {MODE_LABELS[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {mode === "byok" && gateway && (
              <p className="text-xs text-muted-foreground">In the AI Gateway “{gateway}”.</p>
            )}
          </div>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={store.isPending || apiKey.trim().length < 8 || (custom && !slug.trim())}
            >
              {store.isPending ? "Storing…" : "Store key"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- Usage and semantic search -----------------------------------------------------------------

function UsageCard() {
  const usage = useOp("ai.usage", { days: 7 }, { staleTime: 5 * 60_000 });
  const data = usage.data;
  return (
    <Card data-testid="ai-usage">
      <CardHeader>
        <CardTitle>Usage and spend</CardTitle>
        <CardDescription>Requests, tokens and cost per role over the last 7 days.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        {usage.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : usage.isError || !data ? (
          <p className="text-sm text-destructive" role="alert">
            {errorMessage(usage.error)}
          </p>
        ) : !data.available ? (
          <p className="text-sm text-muted-foreground" data-testid="ai-usage-unavailable">
            Usage is not available: {data.reason ?? "AI Gateway is not configured"}.
          </p>
        ) : data.roles.length === 0 ? (
          <p className="text-sm text-muted-foreground">No AI requests in the last 7 days.</p>
        ) : (
          <>
            <Table aria-label="Usage per role">
              <TableHeader>
                <TableRow>
                  <TableHead>Role</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead className="text-right">Tokens in</TableHead>
                  <TableHead className="text-right">Tokens out</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right">Cached</TableHead>
                  <TableHead className="text-right">Errors</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.roles.map((r) => (
                  <TableRow key={r.role}>
                    <TableCell>{ROLE_TITLES[r.role] ?? r.role}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.requests.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.tokensIn.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.tokensOut.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{money(r.cost)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.cached.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.errors.toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="text-xs text-muted-foreground">
              From AI Gateway's logs
              {data.truncated ? ` (the latest ${data.sampled.toLocaleString()} requests)` : ""},
              fetched {new Date(data.fetchedAt).toLocaleString()}.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function SemanticSearchCard({ search }: { search: Settings["semanticSearch"] }) {
  return (
    <Card data-testid="ai-semantic-search">
      <CardHeader>
        <CardTitle>Semantic search</CardTitle>
        <CardDescription>
          Records are embedded after each change, so search and Similar records find them by
          meaning.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {search.configured ? (
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Embedded</dt>
            <dd className="text-right tabular-nums">{search.embedded.toLocaleString()}</dd>
            <dt className="text-muted-foreground">Waiting to embed</dt>
            <dd className="text-right tabular-nums">{search.queued.toLocaleString()}</dd>
            <dt className="text-muted-foreground">Dimensions</dt>
            <dd className="text-right tabular-nums">{search.dimensions ?? "default"}</dd>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">
            Not configured: add a Vectorize index and the Embeddings role. Search uses words only
            until then. <DocsLink />
          </p>
        )}
      </CardContent>
    </Card>
  );
}
