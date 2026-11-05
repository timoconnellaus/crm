// Settings → Updates (ADR 0054, ADR 0164): the installed release and channel, releases available
// on the channel with their changelogs (public GitHub Releases, cached), preflight, Update and
// Roll back. With no stored update token it shows the `ros upgrade` command instead. Admins only.

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
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@relationship-os/ui/components/card";
import { Label } from "@relationship-os/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@relationship-os/ui/components/select";
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import { createFileRoute } from "@tanstack/react-router";
import { AlertTriangleIcon, CheckCircle2Icon, RefreshCwIcon, TerminalIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PageLayout } from "#/components/layout/page-layout";
import { Markdown } from "#/components/markdown";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

export const Route = createFileRoute("/_app/settings/updates")({ component: UpdatesPage });

type Preflight = CoreOutput<"update.preflight">;

function formatDate(iso: string | null) {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(iso),
    );
  } catch {
    return iso;
  }
}

function UpdatesPage() {
  const { isAdmin } = Route.useRouteContext();
  const status = useOp("update.status", {}, { enabled: isAdmin });
  const [refresh, setRefresh] = useState(false);
  const releases = useOp("update.releases", refresh ? { refresh: true } : {}, { enabled: isAdmin });
  const setChannel = useOpMutation("update.setChannel", { invalidates: ["update."] });

  if (!isAdmin) {
    return (
      <PageLayout title="Updates" width="md" back={{ to: "/settings", label: "Settings" }}>
        <p className="text-sm text-muted-foreground">Only admins can see and run updates.</p>
      </PageLayout>
    );
  }
  const s = status.data;
  const newer = releases.data?.releases.filter((r) => r.newer) ?? [];

  return (
    <PageLayout
      title="Updates"
      width="md"
      back={{ to: "/settings", label: "Settings" }}
      description="New releases of Relationship OS, read from public GitHub Releases. Nothing about this deployment is sent anywhere."
    >
      <div className="grid gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Installed</CardTitle>
            <CardDescription>
              {s ? (
                s.currentVersion ? (
                  <>
                    Version{" "}
                    <span className="font-medium text-foreground" data-testid="current-version">
                      {s.currentVersion}
                    </span>
                    {s.hostname ? ` at ${s.hostname}` : ""}
                  </>
                ) : (
                  "Deployed from source (not from a release); update it with `pnpm run deploy`."
                )
              ) : (
                <Skeleton className="h-4 w-40" />
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="update-channel">Channel</Label>
              <Select
                value={s?.channel ?? "stable"}
                onValueChange={async (channel) => {
                  try {
                    await setChannel.mutateAsync({ channel: channel as "stable" | "beta" });
                    setRefresh(true);
                    toast.success(`Channel set to ${channel}`);
                  } catch (error) {
                    toast.error(errorMessage(error));
                  }
                }}
              >
                <SelectTrigger
                  id="update-channel"
                  className="w-full sm:w-60"
                  data-testid="channel-select"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stable">Stable (recommended)</SelectItem>
                  <SelectItem value="beta">Beta (pre-releases too)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {s && !s.canUpdateInApp && (
              <div
                className="grid gap-2 rounded-lg border p-3 text-sm"
                data-testid="cli-instructions"
              >
                <div className="flex items-center gap-2 font-medium">
                  <TerminalIcon className="size-4" aria-hidden /> Update from your computer
                </div>
                <p className="text-muted-foreground">
                  This deployment has no stored update token, so it cannot update itself. Run this
                  with a Cloudflare API token (it runs the same preflight, backup and rollback):
                </p>
                <code className="rounded bg-muted px-2 py-1 break-all">{s.cliCommand}</code>
                <p className="text-muted-foreground">
                  To update from here instead, store a scoped token as the{" "}
                  <code>ROS_UPDATE_TOKEN</code> secret (see docs/deploying.md).
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-2">
            <div className="grid gap-1">
              <CardTitle>Available releases</CardTitle>
              <CardDescription>
                {releases.data?.fetchedAt
                  ? `Checked ${formatDate(releases.data.fetchedAt)}`
                  : "Not checked yet"}
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setRefresh(true);
                void releases.refetch();
              }}
            >
              <RefreshCwIcon aria-hidden /> Check now
            </Button>
          </CardHeader>
          <CardContent className="grid gap-3">
            {releases.data?.error && (
              <p className="text-sm text-destructive">{releases.data.error}</p>
            )}
            {releases.isPending && <Skeleton className="h-16 w-full" />}
            {releases.data && newer.length === 0 && (
              <p className="flex items-center gap-2 text-sm" data-testid="up-to-date">
                <CheckCircle2Icon className="size-4 text-success" aria-hidden /> You are on the
                newest {releases.data.channel} release.
              </p>
            )}
            {newer.map((release) => (
              <ReleaseRow
                key={release.version}
                release={release}
                canUpdate={Boolean(s?.canUpdateInApp)}
                cliCommand={`npx create-relationship-os upgrade --version ${release.version}`}
              />
            ))}
          </CardContent>
        </Card>

        <History />
      </div>
    </PageLayout>
  );
}

function ReleaseRow({
  release,
  canUpdate,
  cliCommand,
}: {
  release: CoreOutput<"update.releases">["releases"][number];
  canUpdate: boolean;
  cliCommand: string;
}) {
  const preflight = useOpMutation("update.preflight");
  const apply = useOpMutation("update.apply", { invalidates: ["update."] });
  const [result, setResult] = useState<Preflight | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function check() {
    try {
      setResult(await preflight.mutateAsync({ version: release.version }));
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }
  async function update() {
    setConfirming(false);
    try {
      const outcome = await apply.mutateAsync({ version: release.version });
      if (outcome.status === "succeeded") {
        toast.success(`Updated to ${outcome.to}. Reloading…`);
        setTimeout(() => window.location.reload(), 1500);
      } else {
        toast.error(`Update ${outcome.status.replace("_", " ")}: ${outcome.error ?? ""}`);
      }
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <div className="grid gap-2 rounded-lg border p-3" data-testid={`release-${release.version}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{release.version}</span>
        {release.channel === "beta" && <Badge variant="outline">beta</Badge>}
        <span className="text-xs text-muted-foreground">{formatDate(release.publishedAt)}</span>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={check} disabled={preflight.isPending}>
            {preflight.isPending ? "Checking…" : "Preflight"}
          </Button>
          {canUpdate && (
            <Button
              size="sm"
              onClick={() => setConfirming(true)}
              disabled={!result?.ok || apply.isPending}
            >
              {apply.isPending ? "Updating…" : "Update"}
            </Button>
          )}
        </div>
      </div>
      <details>
        <summary className="cursor-pointer text-sm text-muted-foreground">Changelog</summary>
        <Markdown className="mt-2 text-sm">{release.notes || "No notes."}</Markdown>
      </details>
      {result && <PreflightView result={result} />}
      {!canUpdate && (
        <code className="w-fit rounded bg-muted px-2 py-1 text-xs break-all">{cliCommand}</code>
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Update to {release.version}?</AlertDialogTitle>
            <AlertDialogDescription>
              Automations pause, the database is bookmarked, {result?.migrations.length ?? 0}{" "}
              migration(s) run and every Worker switches to {release.version}. If anything fails, it
              rolls back to the current version and restores the database. Allow a few minutes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={update}>Update</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function PreflightView({ result }: { result: Preflight }) {
  return (
    <div className="grid gap-2 rounded-md bg-muted/50 p-3 text-sm" data-testid="preflight">
      <div className="flex items-center gap-2 font-medium">
        {result.ok ? (
          <>
            <CheckCircle2Icon className="size-4 text-success" aria-hidden /> Ready to update
          </>
        ) : (
          <>
            <AlertTriangleIcon className="size-4 text-destructive" aria-hidden /> Blocked
          </>
        )}
      </div>
      {result.blockers.map((b) => (
        <p key={b.message} className="text-destructive" data-testid="preflight-blocker">
          {b.message}
        </p>
      ))}
      {result.warnings.map((w) => (
        <p key={w.message} className="text-muted-foreground">
          {w.message}
        </p>
      ))}
      <ul className="grid gap-1 text-muted-foreground">
        <li>Migrations: {result.migrations.length ? result.migrations.join(", ") : "none"}</li>
        <li>
          Runtime extensions:{" "}
          {result.extensions.length
            ? result.extensions
                .map((e) => `${e.id} (${e.compatible ? "compatible" : "incompatible"})`)
                .join(", ")
            : "none"}
        </li>
        {(result.gatekeepers.added.length > 0 ||
          result.gatekeepers.changed.length > 0 ||
          result.gatekeepers.removed.length > 0) && (
          <li>
            Gatekeepers:{" "}
            {[
              ...result.gatekeepers.added.map((g) => `${g} (new)`),
              ...result.gatekeepers.changed.map((g) => `${g} (changed)`),
              ...result.gatekeepers.removed.map((g) => `${g} (removed)`),
            ].join(", ")}
          </li>
        )}
        {result.secrets.length > 0 && (
          <li>
            Secrets:{" "}
            {result.secrets
              .map(
                (x) =>
                  `${x.name} on ${x.worker}${x.required ? " (required)" : ""}${x.set === false ? ": not set" : ""}`,
              )
              .join(", ")}
          </li>
        )}
      </ul>
    </div>
  );
}

function History() {
  const status = useOp("update.status", {});
  const rollback = useOpMutation("update.rollback", { invalidates: ["update."] });
  const [target, setTarget] = useState<string | null>(null);
  const runs = status.data?.runs ?? [];
  if (!runs.length) return null;
  const run = runs.find((r) => r.id === target);
  return (
    <Card>
      <CardHeader>
        <CardTitle>History</CardTitle>
        <CardDescription>Every update and rollback, from here or the CLI.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        {runs.map((r) => (
          <div
            key={r.id}
            className="flex flex-wrap items-center gap-2 text-sm"
            data-testid="update-run"
          >
            <span className="font-medium">
              {r.kind === "rollback" ? "Rollback" : "Update"} {r.fromVersion ?? "?"} → {r.toVersion}
            </span>
            <Badge
              variant={
                r.status === "succeeded"
                  ? "secondary"
                  : r.status === "running"
                    ? "outline"
                    : "destructive"
              }
            >
              {r.status.replace("_", " ")}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {formatDate(r.startedAt)} · {r.surface === "cli" ? "CLI" : "app"}
            </span>
            {r.error && <span className="w-full text-xs text-destructive">{r.error}</span>}
            {r.canRollBack && (
              <Button
                variant="outline"
                size="sm"
                className="ml-auto"
                onClick={() => setTarget(r.id)}
              >
                Roll back
              </Button>
            )}
          </div>
        ))}
      </CardContent>
      <AlertDialog open={Boolean(run)} onOpenChange={(open) => !open && setTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Roll back to {run?.fromVersion}?</AlertDialogTitle>
            <AlertDialogDescription>
              The previous release is redeployed and the database is restored to the bookmark taken
              before the update. Changes made since then are lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (!run) return;
                try {
                  const result = await rollback.mutateAsync({ runId: run.id });
                  toast.success(`Rolled back to ${result.version}. Reloading…`);
                  setTimeout(() => window.location.reload(), 1500);
                } catch (error) {
                  toast.error(errorMessage(error));
                }
              }}
            >
              Roll back
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
