// Settings → Approval policy: view the org's preset and the deploy-time floor; admins change the
// preset (policy.update). Loosening asks for confirmation.
import {
  type GateFloor,
  type GateMatrix,
  isLoosening,
  POLICY_PRESETS,
  type PolicyPreset,
  PRESET_MATRICES,
} from "@crm/core/client";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@crm/ui/components/alert-dialog";
import { Badge } from "@crm/ui/components/badge";
import { Button } from "@crm/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@crm/ui/components/card";
import { Label } from "@crm/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@crm/ui/components/radio-group";
import { Skeleton } from "@crm/ui/components/skeleton";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronLeftIcon, LockIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { FloorTable, GateMatrixTable } from "#/components/settings/gate-matrix";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

export const Route = createFileRoute("/_app/settings/approval-policy")({
  component: ApprovalPolicyPage,
});

const PRESET_COPY: Record<PolicyPreset, { title: string; description: string }> = {
  cautious: {
    title: "Cautious",
    description: "AI may read freely. Every change it proposes waits for a person to approve.",
  },
  balanced: {
    title: "Balanced",
    description:
      "AI may make single-record changes. Bulk changes over 25 records, deletes and anything outbound wait for review.",
  },
  autonomous: {
    title: "Autonomous",
    description:
      "AI may make most changes and send outbound actions. Large deletes and schema or extension changes still wait for review.",
  },
};

function ApprovalPolicyPage() {
  const { isAdmin } = Route.useRouteContext();
  const policy = useOp("policy.get", {});
  const update = useOpMutation("policy.update");
  const [selected, setSelected] = useState<PolicyPreset | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (policy.data) setSelected(policy.data.preset);
  }, [policy.data]);

  const current = policy.data?.preset;
  const preview = selected ?? current ?? "balanced";
  const changed = Boolean(current && selected && selected !== current);

  async function save() {
    if (!selected) return;
    try {
      const result = await update.mutateAsync({ preset: selected });
      toast.success(`Approval policy is now ${PRESET_COPY[result.preset].title}`);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setConfirming(false);
    }
  }

  function onSave() {
    if (current && selected && isLoosening(current, selected)) setConfirming(true);
    else void save();
  }

  return (
    <div className="mx-auto grid w-full grid-cols-1 max-w-4xl gap-6">
      <div className="grid gap-1">
        <Link
          to="/settings"
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeftIcon className="size-4" />
          Settings
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Approval policy</h1>
        <p className="text-muted-foreground">
          How much the in-app assistant, external AI clients and automations may do before a person
          reviews it. People using the app are limited only by their role.
        </p>
      </div>

      {!isAdmin && (
        <p
          className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm"
          role="note"
        >
          <LockIcon className="size-4" aria-hidden />
          Only admins can change the approval policy.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Preset</CardTitle>
          <CardDescription>
            The org-wide starting point for every AI and automation change.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {policy.isPending ? (
            <Skeleton className="h-40 w-full" />
          ) : policy.isError ? (
            <p className="text-sm text-destructive" role="alert">
              {errorMessage(policy.error)}
            </p>
          ) : (
            <RadioGroup
              value={selected ?? undefined}
              onValueChange={(value) => setSelected(value as PolicyPreset)}
              disabled={!isAdmin || update.isPending}
              aria-label="Approval policy preset"
              className="gap-2"
            >
              {POLICY_PRESETS.map((preset) => (
                <Label
                  key={preset}
                  htmlFor={`preset-${preset}`}
                  className="flex cursor-pointer items-start gap-3 rounded-md border p-3 font-normal has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-accent/50"
                >
                  <RadioGroupItem id={`preset-${preset}`} value={preset} className="mt-0.5" />
                  <span className="grid gap-1">
                    <span className="flex items-center gap-2 font-medium">
                      {PRESET_COPY[preset].title}
                      {preset === current && <Badge variant="secondary">Current</Badge>}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {PRESET_COPY[preset].description}
                    </span>
                  </span>
                </Label>
              ))}
            </RadioGroup>
          )}
          {isAdmin && (
            <div className="flex items-center justify-end gap-2">
              {changed && (
                <Button variant="ghost" onClick={() => setSelected(current ?? null)}>
                  Cancel
                </Button>
              )}
              <Button onClick={onSave} disabled={!changed || update.isPending}>
                {update.isPending ? "Saving…" : "Save preset"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            {PRESET_COPY[preview].title}
            {changed ? " (preview)" : ""}: what each actor may do
          </CardTitle>
          <CardDescription>
            <strong>auto</strong> applies at once, <strong>review</strong> waits for a person,{" "}
            <strong>deny</strong> is refused.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <GateMatrixTable matrix={PRESET_MATRICES[preview] satisfies GateMatrix} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LockIcon className="size-4" aria-hidden />
            Floor
          </CardTitle>
          <CardDescription>
            Set when this CRM was deployed (APPROVAL_FLOOR). No preset can loosen these rules, and
            they can't be changed here.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {policy.data ? (
            <FloorTable floor={policy.data.floor as GateFloor} />
          ) : (
            <Skeleton className="h-10 w-full" />
          )}
        </CardContent>
      </Card>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Loosen the approval policy?</AlertDialogTitle>
            <AlertDialogDescription>
              {selected && PRESET_COPY[selected].title} lets AI and automations make more changes
              without review. The change is recorded in the audit log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void save()}>Loosen policy</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
