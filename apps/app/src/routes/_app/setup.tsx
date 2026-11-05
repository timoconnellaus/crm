// The first-run setup wizard (ADR 0167). Admins land here on their first visit after install,
// until they finish or skip it. Every step saves as it goes (setup.save), so it can be left and
// resumed; each real change goes through its own operation (settings.update, policy.update,
// sample.install / sample.remove).
import { COMMON_CURRENCIES, POLICY_PRESETS, type PolicyPreset } from "@crm/core/client";
import { Badge } from "@crm/ui/components/badge";
import { Button } from "@crm/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@crm/ui/components/card";
import { Input } from "@crm/ui/components/input";
import { Label } from "@crm/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@crm/ui/components/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@crm/ui/components/select";
import { Skeleton } from "@crm/ui/components/skeleton";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { CheckCircle2Icon, CpuIcon, FileUpIcon, PlugZapIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { PageLayout } from "#/components/layout/page-layout";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

export const Route = createFileRoute("/_app/setup")({ component: SetupPage });

const STEPS = ["admin", "organisation", "ai", "policy", "connect", "sample"] as const;
type Step = (typeof STEPS)[number];

const STEP_TITLES: Record<Step, string> = {
  admin: "Your account",
  organisation: "Organisation",
  ai: "AI",
  policy: "Approval policy",
  connect: "Connect and import",
  sample: "Sample data",
};

const PRESET_COPY: Record<PolicyPreset, { title: string; description: string }> = {
  cautious: {
    title: "Cautious",
    description: "AI may read freely. Every change it proposes waits for a person to approve.",
  },
  balanced: {
    title: "Balanced",
    description:
      "AI makes single-record changes; bulk changes, deletes and outbound actions wait for review.",
  },
  autonomous: {
    title: "Autonomous",
    description: "AI makes most changes; large deletes and schema or extension changes still wait.",
  },
};

const MAX_LOGO_BYTES = 140_000;

function timezones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf(key: string): string[] }).supportedValuesOf(
      "timeZone",
    );
  } catch {
    return ["UTC"];
  }
}

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function SetupPage() {
  const { isAdmin } = Route.useRouteContext();
  const navigate = useNavigate();
  const status = useOp("setup.status", {});
  const save = useOpMutation("setup.save", { invalidates: ["setup."] });
  const finish = useOpMutation("setup.finish", { invalidates: ["setup."] });
  const [step, setStep] = useState<Step | null>(null);

  useEffect(() => {
    if (status.data && step === null) setStep(status.data.step);
  }, [status.data, step]);

  if (!isAdmin) {
    return (
      <PageLayout title="Setup" width="md">
        <p className="text-sm text-muted-foreground">
          An admin sets up this CRM. Ask one to finish setup.
        </p>
      </PageLayout>
    );
  }
  if (status.isPending || step === null) {
    return (
      <PageLayout title="Set up your CRM" width="md">
        <Skeleton className="h-64 w-full" />
      </PageLayout>
    );
  }

  const index = STEPS.indexOf(step);
  async function go(next: Step | "done", data?: Record<string, unknown>) {
    try {
      if (next === "done") {
        await finish.mutateAsync({ outcome: "completed" });
        toast.success("Setup complete");
        await navigate({ to: "/" });
        return;
      }
      await save.mutateAsync({ step: next, ...(data ? { data } : {}) });
      setStep(next);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }
  async function skip() {
    try {
      await finish.mutateAsync({ outcome: "skipped" });
      toast.message("Setup skipped. You can finish it any time from Settings → General.");
      await navigate({ to: "/" });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }
  const next = (data?: Record<string, unknown>) =>
    go((STEPS[index + 1] as Step | undefined) ?? "done", data);
  const back = index > 0 ? () => setStep(STEPS[index - 1] as Step) : undefined;

  return (
    <PageLayout
      title="Set up your CRM"
      width="md"
      description={`Step ${index + 1} of ${STEPS.length}: ${STEP_TITLES[step]}`}
      actions={
        <Button variant="ghost" onClick={skip} disabled={finish.isPending} data-testid="setup-skip">
          Skip setup
        </Button>
      }
    >
      <ol className="mb-4 flex flex-wrap gap-1.5" aria-label="Setup steps">
        {STEPS.map((s, i) => (
          <li key={s}>
            <Badge variant={i === index ? "default" : i < index ? "secondary" : "outline"}>
              {i + 1}. {STEP_TITLES[s]}
            </Badge>
          </li>
        ))}
      </ol>
      <div data-testid={`setup-step-${step}`}>
        {step === "admin" && <AdminStep onNext={() => next()} />}
        {step === "organisation" && <OrganisationStep onNext={next} onBack={back} />}
        {step === "ai" && <AiStep onNext={next} onBack={back} />}
        {step === "policy" && <PolicyStep onNext={next} onBack={back} />}
        {step === "connect" && <ConnectStep onNext={() => next()} onBack={back} />}
        {step === "sample" && <SampleStep onFinish={() => go("done")} onBack={back} />}
      </div>
    </PageLayout>
  );
}

function StepCard({
  title,
  description,
  children,
  onBack,
  onNext,
  nextLabel = "Continue",
  busy = false,
}: {
  title: string;
  description: ReactNode;
  children?: ReactNode;
  onBack?: (() => void) | undefined;
  onNext: () => void;
  nextLabel?: string;
  busy?: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {children}
        <div className="flex flex-wrap justify-between gap-2 pt-2">
          {onBack ? (
            <Button variant="outline" onClick={onBack}>
              Back
            </Button>
          ) : (
            <span />
          )}
          <Button onClick={onNext} disabled={busy} data-testid="setup-next">
            {busy ? "Saving…" : nextLabel}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function AdminStep({ onNext }: { onNext: () => void }) {
  const { principal, identityProvider } = Route.useRouteContext();
  const access = identityProvider === "cloudflare-access";
  return (
    <StepCard
      title={access ? "Confirm your Cloudflare Access identity" : "You are the first admin"}
      description={
        access
          ? "This CRM signs people in with Cloudflare Access. The first person through Access is its admin; everyone after joins as a member."
          : "You created the first account, so you are this CRM's admin. Only you can sign up until you invite others or allow sign-up."
      }
      onNext={onNext}
      nextLabel={access ? "That's me, continue" : "Continue"}
    >
      <div className="rounded-lg border p-3 text-sm" data-testid="setup-identity">
        <div className="font-medium">{principal.name || principal.email}</div>
        <div className="text-muted-foreground">{principal.email}</div>
        <Badge variant="secondary" className="mt-2">
          Admin · {access ? "Cloudflare Access" : "email and password"}
        </Badge>
      </div>
    </StepCard>
  );
}

function OrganisationStep({
  onNext,
  onBack,
}: {
  onNext: (data?: Record<string, unknown>) => void;
  onBack?: (() => void) | undefined;
}) {
  const settings = useOp("settings.get", {});
  const update = useOpMutation("settings.update", { invalidates: ["settings."] });
  const [name, setName] = useState<string | null>(null);
  const [logo, setLogo] = useState<string | null | undefined>(undefined);
  const [currency, setCurrency] = useState<string | null>(null);
  const [timezone, setTimezone] = useState<string | null>(null);
  if (!settings.data) return <Skeleton className="h-64 w-full" />;
  const current = settings.data;
  const tz = timezone ?? (current.timezone === "UTC" ? browserTimezone() : current.timezone);
  const zones = [...new Set([tz, ...timezones()])];
  const shownLogo = logo === undefined ? current.logo : logo;

  async function onFile(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_LOGO_BYTES) {
      toast.error("That image is too large; use one under 140 KB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setLogo(String(reader.result));
    reader.readAsDataURL(file);
  }

  async function save() {
    const orgName = (name ?? current.orgName ?? "").trim();
    if (!orgName) {
      toast.error("Give your organisation a name");
      return;
    }
    try {
      await update.mutateAsync({
        orgName,
        baseCurrency: currency ?? current.baseCurrency,
        timezone: tz,
        ...(logo !== undefined ? { logo } : {}),
      });
      onNext({ organisation: true });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <StepCard
      title="Your organisation"
      description="Its name and logo appear in the app. Amounts are shown in the base currency; dates in the timezone."
      onBack={onBack}
      onNext={save}
      busy={update.isPending}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="org-name">Organisation name</Label>
        <Input
          id="org-name"
          value={name ?? current.orgName ?? ""}
          onChange={(e) => setName(e.target.value)}
          placeholder="Acme Ltd"
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="org-logo">Logo (optional)</Label>
        <div className="flex flex-wrap items-center gap-3">
          {shownLogo && (
            <img
              src={shownLogo}
              alt="Logo preview"
              className="size-10 rounded border object-contain"
            />
          )}
          <Input
            id="org-logo"
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
            className="w-full sm:w-72"
            onChange={(e) => onFile(e.target.files?.[0])}
          />
          {shownLogo && (
            <Button variant="ghost" size="sm" onClick={() => setLogo(null)}>
              Remove
            </Button>
          )}
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="org-currency">Base currency</Label>
          <Select value={currency ?? current.baseCurrency} onValueChange={setCurrency}>
            <SelectTrigger id="org-currency" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[...new Set([current.baseCurrency, ...COMMON_CURRENCIES])].map((code) => (
                <SelectItem key={code} value={code}>
                  {code}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="org-timezone">Timezone</Label>
          <Select value={tz} onValueChange={setTimezone}>
            <SelectTrigger id="org-timezone" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              {zones.map((zone) => (
                <SelectItem key={zone} value={zone}>
                  {zone}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </StepCard>
  );
}

function AiStep({
  onNext,
  onBack,
}: {
  onNext: (data?: Record<string, unknown>) => void;
  onBack?: (() => void) | undefined;
}) {
  const update = useOpMutation("settings.update", { invalidates: ["settings."] });
  async function save() {
    try {
      await update.mutateAsync({ aiMode: "workers-ai" });
      onNext({ aiMode: "workers-ai" });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }
  return (
    <StepCard
      title="AI"
      description="The assistant, summaries and widget descriptions use AI models through named roles."
      onBack={onBack}
      onNext={save}
      busy={update.isPending}
    >
      <RadioGroup value="workers-ai" aria-label="AI provider">
        <Label
          htmlFor="ai-workers"
          className="flex cursor-pointer items-start gap-3 rounded-lg border p-3"
        >
          <RadioGroupItem id="ai-workers" value="workers-ai" className="mt-0.5" />
          <div className="grid gap-1">
            <span className="flex items-center gap-2 font-medium">
              <CpuIcon className="size-4" aria-hidden /> Use Workers AI only for now
            </span>
            <span className="text-sm font-normal text-muted-foreground">
              Models run in your own Cloudflare account. No third-party keys, and nothing leaves
              Cloudflare.
            </span>
          </div>
        </Label>
      </RadioGroup>
      <p className="text-sm text-muted-foreground">
        To choose other providers per role and add their keys, open Settings → AI after setup.
      </p>
    </StepCard>
  );
}

function PolicyStep({
  onNext,
  onBack,
}: {
  onNext: (data?: Record<string, unknown>) => void;
  onBack?: (() => void) | undefined;
}) {
  const policy = useOp("policy.get", {});
  const update = useOpMutation("policy.update", { invalidates: ["policy."] });
  const [selected, setSelected] = useState<PolicyPreset | null>(null);
  const value = selected ?? policy.data?.preset ?? "cautious";
  async function save() {
    // Until the current preset has loaded, `value` is only the fallback: saving it then would
    // silently change the policy (Next is disabled meanwhile; this guards a fast click).
    if (!policy.data) return;
    try {
      if (value !== policy.data?.preset) await update.mutateAsync({ preset: value });
      onNext({ policy: value });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }
  return (
    <StepCard
      title="How much may AI do without asking?"
      description="Changes above this line wait in the Approvals inbox for a person. You can change it in Settings → Approval policy."
      onBack={onBack}
      onNext={save}
      busy={update.isPending || policy.isPending}
    >
      <RadioGroup
        value={value}
        onValueChange={(v) => setSelected(v as PolicyPreset)}
        aria-label="Approval policy preset"
        className="grid gap-2"
      >
        {POLICY_PRESETS.map((preset) => (
          <Label
            key={preset}
            htmlFor={`setup-preset-${preset}`}
            className="flex cursor-pointer items-start gap-3 rounded-lg border p-3"
          >
            <RadioGroupItem id={`setup-preset-${preset}`} value={preset} className="mt-0.5" />
            <div className="grid gap-1">
              <span className="font-medium">{PRESET_COPY[preset].title}</span>
              <span className="text-sm font-normal text-muted-foreground">
                {PRESET_COPY[preset].description}
              </span>
            </div>
          </Label>
        ))}
      </RadioGroup>
    </StepCard>
  );
}

function ConnectStep({
  onNext,
  onBack,
}: {
  onNext: () => void;
  onBack?: (() => void) | undefined;
}) {
  return (
    <StepCard
      title="Bring in your contacts (optional)"
      description="Connect a mailbox and calendar to sync people and meetings, or import a spreadsheet. You can do either later."
      onBack={onBack}
      onNext={onNext}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Button variant="outline" asChild className="h-auto justify-start gap-3 p-3">
          <Link to="/settings/integrations" target="_blank">
            <PlugZapIcon className="size-5" aria-hidden />
            <span className="grid text-left">
              <span>Connect Google or Microsoft</span>
              <span className="text-xs font-normal text-muted-foreground">
                Settings → Integrations
              </span>
            </span>
          </Link>
        </Button>
        <Button variant="outline" asChild className="h-auto justify-start gap-3 p-3">
          <Link to="/import" target="_blank">
            <FileUpIcon className="size-5" aria-hidden />
            <span className="grid text-left">
              <span>Import a CSV</span>
              <span className="text-xs font-normal text-muted-foreground">
                People or organisations
              </span>
            </span>
          </Link>
        </Button>
      </div>
    </StepCard>
  );
}

function SampleStep({
  onFinish,
  onBack,
}: {
  onFinish: () => void;
  onBack?: (() => void) | undefined;
}) {
  const status = useOp("setup.status", {});
  const install = useOpMutation("sample.install", {
    invalidates: ["setup.", "person.", "organisation.", "task."],
  });
  const remove = useOpMutation("sample.remove", {
    invalidates: ["setup.", "person.", "organisation.", "task."],
  });
  const installed = (status.data?.sampleRecords ?? 0) > 0;
  return (
    <StepCard
      title="Try it with sample data (optional)"
      description="A few sample organisations, people and tasks, marked “(sample)”, to explore with. Remove them in one click, here or in Settings → General."
      onBack={onBack}
      onNext={onFinish}
      nextLabel="Finish setup"
    >
      {installed ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-2 text-sm" data-testid="sample-installed">
            <CheckCircle2Icon className="size-4 text-success" aria-hidden />
            {status.data?.sampleRecords} sample records installed
          </span>
          <Button
            variant="outline"
            onClick={async () => {
              try {
                const result = await remove.mutateAsync({});
                toast.success(`Removed ${result.removed} sample records`);
              } catch (error) {
                toast.error(errorMessage(error));
              }
            }}
            disabled={remove.isPending}
          >
            {remove.isPending ? "Removing…" : "Remove sample data"}
          </Button>
        </div>
      ) : (
        <Button
          variant="outline"
          className="w-fit"
          onClick={async () => {
            try {
              await install.mutateAsync({});
              toast.success("Sample data installed");
            } catch (error) {
              toast.error(errorMessage(error));
            }
          }}
          disabled={install.isPending}
        >
          {install.isPending ? "Installing…" : "Install sample data"}
        </Button>
      )}
    </StepCard>
  );
}
