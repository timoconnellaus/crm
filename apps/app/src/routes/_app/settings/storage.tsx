// Settings → Storage (admins): the D1 database's size against its 10 GB cap, row counts of the
// big tables (measured daily, cached), and how long audit history is kept (ADR 0090).
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@relationship-os/ui/components/card";
import { Label } from "@relationship-os/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@relationship-os/ui/components/radio-group";
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import { createFileRoute } from "@tanstack/react-router";
import { LockIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PageLayout, SaveBar } from "#/components/layout/page-layout";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

export const Route = createFileRoute("/_app/settings/storage")({ component: StoragePage });

const TABLE_LABELS: Record<string, string> = {
  core_person: "People",
  core_organisation: "Organisations",
  core_activity: "Activities",
  core_task: "Tasks",
  core_search_docs: "Search index",
  core_audit: "Audit log",
  core_audit_changes: "Audit field changes",
  core_audit_read_counts: "AI read counts (hourly)",
  core_pending_action: "Approval history",
  core_extension_runs: "Extension and automation runs",
  core_extension_proposals: "Extension proposals",
};

const RETENTION_CHOICES = [
  { value: "forever", years: null, title: "Forever", description: "Never delete audit history." },
  {
    value: "7",
    years: 7,
    title: "7 years",
    description: "Delete audit history older than 7 years.",
  },
  {
    value: "2",
    years: 2,
    title: "2 years",
    description: "Delete audit history older than 2 years.",
  },
  { value: "1", years: 1, title: "1 year", description: "Delete audit history older than 1 year." },
] as const;

function bytes(n: number | null): string {
  if (n === null) return "unknown";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

const LEVEL: Record<string, { label: string; variant: "secondary" | "destructive" | "outline" }> = {
  ok: { label: "OK", variant: "secondary" },
  warning: { label: "Getting full", variant: "outline" },
  critical: { label: "Nearly full", variant: "destructive" },
  unknown: { label: "Size not reported", variant: "outline" },
};

function StoragePage() {
  const { isAdmin } = Route.useRouteContext();
  const form = useRetentionForm(isAdmin);
  return (
    <PageLayout
      title="Storage"
      width="md"
      back={{ to: "/settings", label: "Settings" }}
      description="How full the database is, and how long history is kept."
      footer={
        isAdmin ? (
          <SaveBar
            dirty={form.changed || form.update.isPending}
            message={
              form.choice ? `Keep audit history ${form.choice.title.toLowerCase()}?` : undefined
            }
          >
            <Button variant="ghost" onClick={form.reset}>
              Cancel
            </Button>
            <Button onClick={form.onSave} disabled={!form.changed || form.update.isPending}>
              {form.update.isPending ? "Saving…" : "Save"}
            </Button>
          </SaveBar>
        ) : undefined
      }
    >
      {isAdmin ? (
        <>
          <SizeCard />
          <RetentionCard form={form} />
        </>
      ) : (
        <p
          className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm"
          role="note"
        >
          <LockIcon className="size-4" aria-hidden />
          Only admins can see storage.
        </p>
      )}
    </PageLayout>
  );
}

function SizeCard() {
  const status = useOp("storage.status", {});
  const refresh = useOpMutation("storage.refresh");
  const data = status.data;
  const percent =
    data?.sizeBytes != null ? Math.min(100, (data.sizeBytes / data.capBytes) * 100) : 0;
  const level = LEVEL[data?.level ?? "unknown"] ?? LEVEL.unknown;

  async function onRefresh() {
    try {
      await refresh.mutateAsync({});
      await status.refetch();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="grid gap-1">
          <CardTitle>Database</CardTitle>
          <CardDescription>
            A Cloudflare D1 database holds at most 10 GB. Warnings start at 6 GB.
          </CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void onRefresh()}
          disabled={refresh.isPending}
        >
          <RefreshCwIcon className="size-4" aria-hidden />
          {refresh.isPending ? "Measuring…" : "Measure now"}
        </Button>
      </CardHeader>
      <CardContent className="grid gap-4">
        {status.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : status.isError || !data ? (
          <p className="text-sm text-destructive" role="alert">
            {errorMessage(status.error)}
          </p>
        ) : (
          <>
            <div className="grid gap-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-lg font-medium" data-testid="storage-size">
                  {bytes(data.sizeBytes)} <span className="text-muted-foreground">of 10 GB</span>
                </span>
                {level && <Badge variant={level.variant}>{level.label}</Badge>}
              </div>
              <meter
                className="sr-only"
                aria-label="Database size"
                min={0}
                max={data.capBytes}
                low={data.warnBytes}
                high={data.criticalBytes}
                value={data.sizeBytes ?? 0}
              />
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
                <div
                  className={
                    data.level === "critical"
                      ? "h-full bg-destructive"
                      : data.level === "warning"
                        ? "h-full bg-amber-500"
                        : "h-full bg-primary"
                  }
                  style={{ width: `${percent}%` }}
                />
              </div>
            </div>
            {data.tables.length ? (
              <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
                {data.tables.map((t) => (
                  <div key={t.table} className="contents">
                    <dt className="text-muted-foreground">{TABLE_LABELS[t.table] ?? t.table}</dt>
                    <dd className="text-right tabular-nums">{t.rows.toLocaleString()}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">
                Row counts are measured daily. Choose Measure now to count them today.
              </p>
            )}
            {data.measuredAt && (
              <p className="text-xs text-muted-foreground">
                Rows counted {new Date(data.measuredAt).toLocaleString()}.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function useRetentionForm(enabled: boolean) {
  const retention = useOp("audit.retention", {}, { enabled });
  const update = useOpMutation("audit.setRetention");
  const current = retention.data
    ? retention.data.years === null
      ? "forever"
      : String(retention.data.years)
    : null;
  const [selected, setSelected] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (current) setSelected(current);
  }, [current]);
  const choice = RETENTION_CHOICES.find((c) => c.value === selected);
  const changed = Boolean(current && selected && selected !== current);
  const shortens =
    choice?.years != null &&
    (retention.data?.years == null || choice.years < (retention.data?.years ?? 0));

  async function save() {
    if (!choice) return;
    try {
      await update.mutateAsync({ years: choice.years });
      toast.success(`Audit history is now kept ${choice.title.toLowerCase()}`);
      await retention.refetch();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setConfirming(false);
    }
  }

  return {
    retention,
    update,
    current,
    selected,
    setSelected,
    confirming,
    setConfirming,
    choice,
    changed,
    save,
    reset: () => setSelected(current),
    onSave: () => (shortens ? setConfirming(true) : void save()),
  };
}

function RetentionCard({ form }: { form: ReturnType<typeof useRetentionForm> }) {
  const { retention, update, current, selected, setSelected, confirming, setConfirming, choice } =
    form;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Audit history</CardTitle>
        <CardDescription>
          How long the audit log keeps every change and refusal. Older entries are deleted for good
          by the daily maintenance, which records each purge in the log.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {retention.isPending ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <RadioGroup
            value={selected ?? undefined}
            onValueChange={setSelected}
            disabled={update.isPending}
            aria-label="Keep audit history for"
            className="gap-2"
          >
            {RETENTION_CHOICES.map((c) => (
              <Label
                key={c.value}
                htmlFor={`retention-${c.value}`}
                className="flex cursor-pointer items-start gap-3 rounded-md border p-3 font-normal has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-accent/50"
              >
                <RadioGroupItem id={`retention-${c.value}`} value={c.value} className="mt-0.5" />
                <span className="grid gap-1">
                  <span className="flex items-center gap-2 font-medium">
                    {c.title}
                    {c.value === current && <Badge variant="secondary">Current</Badge>}
                  </span>
                  <span className="text-sm text-muted-foreground">{c.description}</span>
                </span>
              </Label>
            ))}
          </RadioGroup>
        )}
        <p className="text-sm text-muted-foreground">
          Also kept short automatically: reads by AI and automations are counted per hour rather
          than logged one by one; extension and automation runs are kept 30 days (failures 90);
          decided approvals keep their full detail for 30 days, then a summary.
        </p>
      </CardContent>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete older audit history?</AlertDialogTitle>
            <AlertDialogDescription>
              Audit entries older than {choice?.title.toLowerCase()} will be deleted permanently at
              the next daily maintenance. This can't be undone. The change is recorded in the audit
              log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void form.save()}>
              Delete older history
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
