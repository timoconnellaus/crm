// Settings → Automations (ADR 0028): the kill switch (human admins only, behind a confirmation),
// the timezone schedules and date-relative triggers run in, and the debounce window that
// coalesces quick successive updates of one record. Everyone can see them; admins change them.
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@relationship-os/ui/components/select";
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import { cn } from "@relationship-os/ui/lib/utils";
import { createFileRoute, Link } from "@tanstack/react-router";
import { OctagonXIcon, PowerIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { PageLayout, SaveBar } from "#/components/layout/page-layout";
import { useStageMutation, useStageOp } from "#/lib/automation-ops";
import { errorMessage } from "#/lib/query";

export const Route = createFileRoute("/_app/settings/automations")({
  component: AutomationSettingsPage,
});

const FALLBACK_ZONES = [
  "UTC",
  "Europe/London",
  "America/New_York",
  "America/Los_Angeles",
  "Australia/Sydney",
];

/** Every IANA timezone the browser knows, the current one first if missing. */
function timezones(current: string | undefined): string[] {
  let zones: string[];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = FALLBACK_ZONES;
  }
  const all = new Set(["UTC", ...zones]);
  if (current) all.add(current);
  return [...all];
}

function AutomationSettingsPage() {
  const { isAdmin } = Route.useRouteContext();
  const settings = useStageOp("automation.settings", {});
  const update = useStageMutation("automation.updateSettings", { invalidates: ["automation."] });
  const [timezone, setTimezone] = useState<string | null>(null);
  const [debounce, setDebounce] = useState<string | null>(null);
  const zones = useMemo(() => timezones(settings.data?.timezone), [settings.data?.timezone]);

  const current = settings.data;
  const debounceValue = debounce === null ? null : Number(debounce);
  const debounceValid =
    debounceValue === null ||
    (Number.isInteger(debounceValue) && debounceValue >= 0 && debounceValue <= 3600);
  const dirty =
    (timezone !== null && timezone !== current?.timezone) ||
    (debounceValue !== null && debounceValue !== current?.debounceSeconds);

  function reset() {
    setTimezone(null);
    setDebounce(null);
  }

  async function onSave() {
    if (!debounceValid) return;
    try {
      await update.mutateAsync({
        ...(timezone !== null ? { timezone } : {}),
        ...(debounceValue !== null ? { debounceSeconds: debounceValue } : {}),
      });
      toast.success("Automation settings saved");
      reset();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <PageLayout
      title="Automations"
      width="md"
      back={{ to: "/settings", label: "Settings" }}
      description={
        <>
          How every automation runs. Each automation is managed on its own page under{" "}
          <Link to="/automations" className="underline">
            Automations
          </Link>
          .
        </>
      }
      footer={
        isAdmin ? (
          <SaveBar dirty={dirty || update.isPending}>
            <Button variant="ghost" onClick={reset}>
              Cancel
            </Button>
            <Button
              onClick={() => void onSave()}
              disabled={!dirty || !debounceValid || update.isPending}
            >
              {update.isPending ? "Saving…" : "Save"}
            </Button>
          </SaveBar>
        ) : undefined
      }
    >
      {settings.isPending ? (
        <Skeleton className="h-40" />
      ) : settings.error ? (
        <p className="text-sm text-destructive" role="alert">
          {errorMessage(settings.error)}
        </p>
      ) : (
        <>
          <KillSwitchCard engaged={settings.data.killSwitch} isAdmin={isAdmin} />
          <Card>
            <CardHeader>
              <CardTitle>Schedule timezone</CardTitle>
              <CardDescription>
                Scheduled automations and date-relative triggers (e.g. “the day after the close
                date”) are evaluated in this timezone.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-1.5">
              <Label htmlFor="automation-timezone">Timezone</Label>
              <Select
                value={timezone ?? settings.data.timezone}
                onValueChange={setTimezone}
                disabled={!isAdmin}
              >
                <SelectTrigger id="automation-timezone" className="w-full sm:w-80">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {zones.map((zone) => (
                    <SelectItem key={zone} value={zone}>
                      {zone.replaceAll("_", " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Debounce window</CardTitle>
              <CardDescription>
                Updates to one record within this many seconds count as one change, so a burst of
                edits triggers an automation once.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-1.5">
              <Label htmlFor="automation-debounce">Seconds</Label>
              <Input
                id="automation-debounce"
                type="number"
                inputMode="numeric"
                min={0}
                max={3600}
                step={1}
                className="w-full sm:w-40"
                value={debounce ?? String(settings.data.debounceSeconds)}
                onChange={(event) => setDebounce(event.target.value)}
                disabled={!isAdmin}
                aria-invalid={!debounceValid || undefined}
              />
              {!debounceValid && (
                <p className="text-xs text-destructive">A whole number from 0 to 3600.</p>
              )}
              {!isAdmin && (
                <p className="text-xs text-muted-foreground">Only admins can change these.</p>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </PageLayout>
  );
}

function KillSwitchCard({ engaged, isAdmin }: { engaged: boolean; isAdmin: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const toggle = useStageMutation("automation.killSwitch", { invalidates: ["automation."] });

  async function onConfirm() {
    try {
      const result = await toggle.mutateAsync({ engaged: !engaged });
      toast.success(
        result.engaged ? "Kill switch engaged: automations are paused" : "Kill switch released",
      );
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setConfirming(false);
    }
  }

  return (
    <Card className={cn(engaged && "border-destructive/50")} data-testid="kill-switch">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <OctagonXIcon
            className={cn("size-4", engaged ? "text-destructive" : "text-muted-foreground")}
            aria-hidden
          />
          Kill switch
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-xs font-medium",
              engaged
                ? "bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300"
                : "bg-muted text-muted-foreground",
            )}
            data-testid="kill-switch-state"
          >
            {engaged ? "Engaged" : "Off"}
          </span>
        </CardTitle>
        <CardDescription>
          Pauses every automation at once and stops running ones. Only a human admin can engage or
          release it, here; assistants and automations can't.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isAdmin ? (
          <Button
            variant={engaged ? "outline" : "destructive"}
            onClick={() => setConfirming(true)}
            disabled={toggle.isPending}
          >
            <PowerIcon />
            {engaged ? "Release kill switch" : "Engage kill switch"}
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">Only admins can use the kill switch.</p>
        )}
      </CardContent>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {engaged ? "Release the kill switch?" : "Engage the kill switch?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {engaged
                ? "Automations start running again on new events. Runs stopped by the kill switch stay stopped; replay them from their pages if needed."
                : "Every automation pauses now and running ones stop. Nothing runs until an admin releases it."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void onConfirm()}
              className={cn(!engaged && "bg-destructive text-white hover:bg-destructive/90")}
            >
              {engaged ? "Release" : "Engage kill switch"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
