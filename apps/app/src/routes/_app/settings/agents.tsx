// Settings → Agents (ADR 0344, ADR 0345): the kinds of agent that can be started, and for admins the
// limits on them and the point at which an email send needs a deliberate second step.
import type { CoreOutput } from "@relationship-os/core";
import { Badge } from "@relationship-os/ui/components/badge";
import { Button } from "@relationship-os/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@relationship-os/ui/components/card";
import { Input } from "@relationship-os/ui/components/input";
import { Label } from "@relationship-os/ui/components/label";
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { ErrorState } from "#/components/empty-state";
import { PageLayout } from "#/components/layout/page-layout";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

export const Route = createFileRoute("/_app/settings/agents")({ component: AgentsPage });

type Settings = CoreOutput<"agent.settings">;
type LimitKey = Exclude<keyof Settings, "defaults">;

const LIMITS: { key: LimitKey; label: string; hint: string }[] = [
  { key: "maxRunningPerUser", label: "Running per person", hint: "Further agents wait in line." },
  { key: "maxRunningPerWorkspace", label: "Running in the workspace", hint: "Across everyone." },
  { key: "defaultSteps", label: "Steps", hint: "For an agent with no profile." },
  { key: "defaultMinutes", label: "Minutes", hint: "For an agent with no profile." },
  { key: "defaultSpendUsd", label: "Spend (US dollars)", hint: "For an agent with no profile." },
  {
    key: "awaitSeconds",
    label: "Seconds to wait in a reply",
    hint: "Past this, an agent moves to the background.",
  },
  {
    key: "reminderHours",
    label: "Hours between reminders",
    hint: "While changes wait for review.",
  },
];

function LimitsCard({ settings }: { settings: Settings }) {
  const update = useOpMutation("agent.updateSettings", { invalidates: ["agent."] });
  const { defaults: _defaults, ...current } = settings;
  const [values, setValues] = useState<Record<LimitKey, string>>(
    Object.fromEntries(LIMITS.map((l) => [l.key, String(current[l.key])])) as Record<
      LimitKey,
      string
    >,
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Limits</CardTitle>
        <CardDescription>
          How many agents run at once, and the budgets of those started without a profile.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          {LIMITS.map((limit) => (
            <div key={limit.key} className="grid gap-1.5">
              <Label htmlFor={limit.key}>{limit.label}</Label>
              <Input
                id={limit.key}
                type="number"
                min={0}
                value={values[limit.key]}
                onChange={(e) => setValues((v) => ({ ...v, [limit.key]: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">{limit.hint}</p>
            </div>
          ))}
        </div>
        <div>
          <Button
            disabled={update.isPending}
            onClick={() =>
              update.mutate(
                Object.fromEntries(LIMITS.map((l) => [l.key, Number(values[l.key])])) as Record<
                  LimitKey,
                  number
                >,
                {
                  onSuccess: () => toast.success("Saved"),
                  onError: (error) => toast.error(errorMessage(error)),
                },
              )
            }
          >
            Save limits
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ThresholdCard() {
  const settings = useOp("approval.settings", {});
  const update = useOpMutation("approval.updateSettings", { invalidates: ["approval."] });
  const [value, setValue] = useState<string | null>(null);
  if (!settings.data) return <Skeleton className="h-32" />;
  const shown = value ?? String(settings.data.phraseThresholdEmail);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Large email sends</CardTitle>
        <CardDescription>
          Above this many recipients, approving a send takes a second press or the exact phrase.
          Raising it loosens your approval policy.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="phrase-threshold">Recipients</Label>
          <Input
            id="phrase-threshold"
            type="number"
            min={1}
            className="w-32"
            value={shown}
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
        <Button
          disabled={update.isPending}
          onClick={() =>
            update.mutate(
              { phraseThresholdEmail: Number(shown) },
              {
                onSuccess: () => toast.success("Saved"),
                onError: (error) => toast.error(errorMessage(error)),
              },
            )
          }
        >
          Save
        </Button>
      </CardContent>
    </Card>
  );
}

function ProfilesCard() {
  const profiles = useOp("agentProfile.list", {});
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Agent profiles</CardTitle>
        <CardDescription>
          The kinds of agent your assistant, routines and plugins can start by name.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {profiles.isError ? (
          <ErrorState title="Could not load the agent profiles" error={profiles.error} />
        ) : !profiles.data ? (
          <Skeleton className="h-32" />
        ) : (
          <ul className="grid gap-3">
            {profiles.data.items.map((profile) => (
              <li
                key={profile.name}
                className="grid gap-1 rounded-md border p-3 text-sm"
                data-testid="agent-profile"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{profile.label}</span>
                  {profile.source !== "shipped" && (
                    <Badge variant="outline">{profile.source}</Badge>
                  )}
                </div>
                <p>{profile.description}</p>
                <p className="text-xs text-muted-foreground">
                  Up to {profile.budget.steps} steps, {profile.budget.minutes} minutes and $
                  {profile.budget.spendUsd.toFixed(2)}.
                </p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function AgentsPage() {
  const settings = useOp("agent.settings", {});
  const { isAdmin: admin } = Route.useRouteContext();
  return (
    <PageLayout
      title="Agents"
      description="Longer work your assistant hands off, so you can keep chatting."
    >
      <div className="grid max-w-3xl gap-4">
        <ProfilesCard />
        {admin && settings.data && <LimitsCard settings={settings.data} />}
        {admin && <ThresholdCard />}
      </div>
    </PageLayout>
  );
}
