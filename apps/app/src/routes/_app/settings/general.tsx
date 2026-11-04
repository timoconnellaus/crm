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
import { createFileRoute } from "@tanstack/react-router";
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
    </PageLayout>
  );
}
