// Settings → General: the deployment's base currency (ADR 0101). Every currency field without its
// own currency (deal values, budgets) is shown in it. Admins change it; everyone can see it.
import { COMMON_CURRENCIES } from "@crm/core/client";
import { Button } from "@crm/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@crm/ui/components/card";
import { Label } from "@crm/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@crm/ui/components/select";
import { Skeleton } from "@crm/ui/components/skeleton";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { PageLayout, SaveBar } from "#/components/layout/page-layout";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

export const Route = createFileRoute("/_app/settings/general")({ component: GeneralPage });

function currencyName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "currency" }).of(code) ?? code;
  } catch {
    return code;
  }
}

function GeneralPage() {
  const { isAdmin } = Route.useRouteContext();
  const settings = useOp("settings.get", {});
  const update = useOpMutation("settings.update", { invalidates: ["settings."] });
  const [choice, setChoice] = useState<string | null>(null);
  const current = settings.data?.baseCurrency;
  const dirty = choice !== null && choice !== current;
  const codes = [...new Set([...(current ? [current] : []), ...COMMON_CURRENCIES])];

  async function onSave() {
    if (!choice) return;
    try {
      await update.mutateAsync({ baseCurrency: choice });
      toast.success(`Base currency set to ${choice}`);
      setChoice(null);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <PageLayout
      title="General"
      width="md"
      back={{ to: "/settings", label: "Settings" }}
      description="Settings for the whole organisation."
      footer={
        isAdmin ? (
          <SaveBar dirty={dirty || update.isPending} message={`Show amounts in ${choice}?`}>
            <Button variant="ghost" onClick={() => setChoice(null)}>
              Cancel
            </Button>
            <Button onClick={onSave} disabled={!dirty || update.isPending}>
              {update.isPending ? "Saving…" : "Save"}
            </Button>
          </SaveBar>
        ) : undefined
      }
    >
      <Card>
        <CardHeader>
          <CardTitle>Base currency</CardTitle>
          <CardDescription>
            Deal values and other amounts are shown in this currency. Changing it relabels amounts;
            it does not convert them.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-1.5">
          <Label htmlFor="base-currency">Currency</Label>
          {settings.isPending ? (
            <Skeleton className="h-9 w-64" />
          ) : (
            <Select
              value={choice ?? current ?? "USD"}
              onValueChange={setChoice}
              disabled={!isAdmin}
            >
              <SelectTrigger id="base-currency" className="w-full sm:w-72">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {codes.map((code) => (
                  <SelectItem key={code} value={code}>
                    {code} · {currencyName(code)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {!isAdmin && <p className="text-xs text-muted-foreground">Only admins can change it.</p>}
        </CardContent>
      </Card>
      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Organisation</CardTitle>
          <CardDescription>
            {settings.data?.orgName ?? "No name yet"} · {settings.data?.timezone ?? "UTC"} · AI:{" "}
            {settings.data?.aiMode === "workers-ai" ? "Workers AI" : settings.data?.aiMode}
          </CardDescription>
        </CardHeader>
        {settings.data?.logo && (
          <CardContent>
            <img
              src={settings.data.logo}
              alt="Organisation logo"
              className="size-12 rounded border object-contain"
            />
          </CardContent>
        )}
      </Card>
      {isAdmin && <SetupCard />}
    </PageLayout>
  );
}

/** Reopen the setup wizard, and install or remove sample data (ADR 0167). */
function SetupCard() {
  const navigate = useNavigate();
  const status = useOp("setup.status", {});
  const restart = useOpMutation("setup.restart", { invalidates: ["setup."] });
  const remove = useOpMutation("sample.remove", {
    invalidates: ["setup.", "person.", "organisation.", "task."],
  });
  const samples = status.data?.sampleRecords ?? 0;
  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>Setup</CardTitle>
        <CardDescription>
          {status.data?.status === "completed"
            ? "Setup is complete. Run it again to change the organisation, AI, policy or sample data."
            : "Setup was skipped or is unfinished."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={async () => {
            try {
              await restart.mutateAsync({});
              await navigate({ to: "/setup" });
            } catch (error) {
              toast.error(errorMessage(error));
            }
          }}
        >
          Open the setup wizard
        </Button>
        {samples > 0 && (
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
            data-testid="remove-sample-data"
          >
            Remove sample data ({samples})
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
