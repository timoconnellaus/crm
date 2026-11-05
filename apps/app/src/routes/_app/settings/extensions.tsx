// Settings → Extensions: installed extensions (shipped and runtime) with version, status, declared
// permissions, run history and rollback (ADR 0025). A quarantined extension is announced at the
// top of the page and offers its last-known-good version. Extensions that declare typed settings
// (ADR 0058) show a settings form, editable by admins.

import { Badge } from "@relationship-os/ui/components/badge";
import { Button } from "@relationship-os/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@relationship-os/ui/components/card";
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertTriangleIcon, PuzzleIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "#/components/empty-state";
import { PageLayout } from "#/components/layout/page-layout";
import { ExtensionSettingsForm } from "#/components/settings/extension-settings";
import { formatDateTime } from "#/lib/format";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

export const Route = createFileRoute("/_app/settings/extensions")({ component: ExtensionsPage });

type Summary = {
  id: string;
  label: string;
  description: string | null;
  source: "shipped" | "runtime";
  status: "active" | "disabled" | "quarantined";
  statusReason: string | null;
  version: string;
  commit: string;
  lastGoodCommit: string | null;
  failureCount: number;
  permissions: { read: string[]; write: string[]; operations: string[]; modules: string[] };
  objects: string[];
  tools: string[];
};

const STATUS_VARIANT = {
  active: "secondary",
  disabled: "outline",
  quarantined: "destructive",
} as const;

function ExtensionsPage() {
  const { isAdmin } = Route.useRouteContext();
  const list = useOp("extension.list", {});
  const items = (list.data?.items ?? []) as Summary[];
  const quarantined = items.filter((i) => i.status === "quarantined");
  return (
    <PageLayout
      title="Extensions"
      width="lg"
      back={{ to: "/settings", label: "Settings" }}
      description="Objects, fields and tools added as code. Each runs in a sandbox with only the permissions it declares."
    >
      {quarantined.map((ext) => (
        <div
          key={ext.id}
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-destructive/50 bg-destructive/5 p-4 text-sm"
        >
          <AlertTriangleIcon className="mt-0.5 size-4 text-destructive" aria-hidden />
          <div className="grid gap-1">
            <p className="font-medium">{ext.label} was quarantined</p>
            <p className="text-muted-foreground">{ext.statusReason}</p>
            {ext.lastGoodCommit && (
              <p className="text-muted-foreground">
                Roll back to its last-known-good version below, or enable it again once fixed.
              </p>
            )}
          </div>
        </div>
      ))}
      {list.isPending && <Skeleton className="h-40 w-full" />}
      {list.error && <p className="text-sm text-destructive">{errorMessage(list.error)}</p>}
      {list.isSuccess && items.length === 0 && (
        <EmptyState icon={PuzzleIcon} title="No extensions installed" />
      )}
      {items.map((ext) => (
        <ExtensionCard key={ext.id} ext={ext} isAdmin={isAdmin} />
      ))}
    </PageLayout>
  );
}

function PermissionList({ label, values }: { label: string; values: string[] }) {
  if (!values.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-muted-foreground">{label}:</span>
      {values.map((v) => (
        <Badge key={v} variant="outline" className="font-mono text-xs">
          {v}
        </Badge>
      ))}
    </div>
  );
}

function ExtensionCard({ ext, isAdmin }: { ext: Summary; isAdmin: boolean }) {
  const [open, setOpen] = useState(false);
  const disable = useOpMutation("extension.disable", { invalidates: ["schema.", "record."] });
  const enable = useOpMutation("extension.enable", { invalidates: ["schema.", "record."] });

  async function toggle() {
    try {
      if (ext.status === "active") await disable.mutateAsync({ id: ext.id });
      else await enable.mutateAsync({ id: ext.id });
      toast.success(ext.status === "active" ? `${ext.label} disabled` : `${ext.label} enabled`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <Card data-testid={`extension-${ext.id}`}>
      <CardHeader className="flex flex-row flex-wrap items-start gap-3">
        <div className="grid min-w-0 flex-1 gap-1">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            {ext.label}
            <Badge variant={STATUS_VARIANT[ext.status]}>{ext.status}</Badge>
            <Badge variant="outline">{ext.source}</Badge>
          </CardTitle>
          <CardDescription>
            {ext.id} · v{ext.version} · <span className="font-mono">{ext.commit.slice(0, 8)}</span>
            {ext.failureCount > 0 && ` · ${ext.failureCount} recent failure(s)`}
          </CardDescription>
          {ext.description && <p className="text-sm">{ext.description}</p>}
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setOpen((o) => !o)}>
            {open ? "Hide details" : "Details"}
          </Button>
          {isAdmin && (
            <Button variant="outline" size="sm" onClick={toggle}>
              {ext.status === "active" ? "Disable" : "Enable"}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="grid gap-2 text-sm">
        {ext.status === "active" && <ExtensionSettingsForm extension={ext.id} canEdit={isAdmin} />}
        <PermissionList label="Reads" values={ext.permissions.read} />
        <PermissionList label="Writes" values={ext.permissions.write} />
        <PermissionList label="Operations" values={ext.permissions.operations} />
        <PermissionList label="Host modules" values={ext.permissions.modules} />
        {ext.objects.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">Objects:</span>
            {ext.objects.map((o) => (
              <Link key={o} to="/x/$object" params={{ object: o }} className="hover:underline">
                {o}
              </Link>
            ))}
          </div>
        )}
        <PermissionList label="Tools" values={ext.tools} />
        {open && <ExtensionDetail ext={ext} isAdmin={isAdmin} />}
      </CardContent>
    </Card>
  );
}

function ExtensionDetail({ ext, isAdmin }: { ext: Summary; isAdmin: boolean }) {
  const detail = useOp("extension.get", { id: ext.id, runs: 20 });
  const rollback = useOpMutation("extension.rollback", { invalidates: ["schema.", "record."] });
  if (detail.isPending) return <Skeleton className="h-24 w-full" />;
  if (detail.error || !detail.data)
    return <p className="text-destructive">{errorMessage(detail.error)}</p>;
  const data = detail.data;

  async function rollTo(commit: string) {
    try {
      const result = await rollback.mutateAsync({ id: ext.id, commit });
      toast.success(`${ext.label} rolled back to v${result.version}`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <div className="mt-2 grid gap-4">
      <section className="grid gap-1">
        <h3 className="font-medium">Versions</h3>
        <ul className="grid gap-1">
          {data.versions.map((v) => (
            <li key={v.commit} className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">{v.commit.slice(0, 8)}</span>
              <span>v{v.version}</span>
              <span className="text-muted-foreground">{formatDateTime(v.installedAt)}</span>
              {v.commit === data.commit && <Badge variant="secondary">current</Badge>}
              {v.commit === data.lastGoodCommit && <Badge variant="outline">last known good</Badge>}
              {isAdmin && v.commit !== data.commit && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => rollTo(v.commit)}
                  disabled={rollback.isPending}
                >
                  Roll back
                </Button>
              )}
            </li>
          ))}
        </ul>
      </section>
      {data.hidden.length > 0 && (
        <section className="grid gap-1">
          <h3 className="font-medium">Removed fields (data kept)</h3>
          <ul className="grid gap-1 text-muted-foreground">
            {data.hidden.map((h) => (
              <li key={`${h.object}.${h.field ?? ""}`}>
                {h.field ? `${h.object}.${h.field}` : h.object} — droppable after{" "}
                {formatDateTime(h.droppableAt)}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="grid gap-1">
        <h3 className="font-medium">Run history</h3>
        {data.runs.length === 0 ? (
          <p className="text-muted-foreground">No runs yet.</p>
        ) : (
          <ul className="grid gap-1">
            {data.runs.map((run) => (
              <li key={run.id} className="grid gap-0.5 rounded border p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={run.outcome === "ok" ? "secondary" : "destructive"}>
                    {run.outcome}
                  </Badge>
                  <span className="font-medium">{run.name ?? run.kind}</span>
                  <span className="text-muted-foreground">
                    {formatDateTime(run.startedAt)} · {run.durationMs} ms · {run.operations.length}{" "}
                    operation(s)
                  </span>
                </div>
                {run.error !== null && (
                  <p className="text-destructive">
                    {String((run.error as { message?: string }).message ?? "")}
                  </p>
                )}
                {(run.logs as { level: string; message: string }[]).map((log, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: logs are append-only and unkeyed.
                  <p key={i} className="font-mono text-xs text-muted-foreground">
                    [{log.level}] {log.message}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
