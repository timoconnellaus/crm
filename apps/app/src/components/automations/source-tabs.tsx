// The automation page's Code and Versions tabs. An automation is extension code, so both come
// from its extension: the source at the installed commit (extension.read), and the extension's
// installed versions with rollback (extension.get, extension.rollback; admins, humans only).
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@relationship-os/ui/components/select";
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import { HistoryIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { EmptyState, ErrorState } from "#/components/empty-state";
import { formatDateTime } from "#/lib/format";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";
import type { AutomationDetailData } from "./hooks.ts";

/** The file most likely to hold this automation: one named after its key, else the entry. */
function defaultFile(paths: readonly string[], key: string): string | undefined {
  const lower = key.toLowerCase();
  return (
    paths.find((p) => p.toLowerCase().includes(lower)) ??
    paths.find((p) => /automation/i.test(p)) ??
    paths.find((p) => p === "index.ts") ??
    paths[0]
  );
}

export function CodeTab({ detail }: { detail: AutomationDetailData }) {
  const source = useOp(
    "extension.read",
    { id: detail.extensionId, ...(detail.commit ? { commit: detail.commit } : {}) },
    { staleTime: 5 * 60_000 },
  );
  const paths = useMemo(() => Object.keys(source.data?.files ?? {}).sort(), [source.data]);
  const [chosen, setChosen] = useState<string | null>(null);
  const path = chosen ?? defaultFile(paths, detail.key);

  if (source.isPending) return <Skeleton className="h-96" />;
  if (source.error) {
    return (
      <ErrorState
        title="Could not load the source"
        error={source.error}
        onRetry={() => void source.refetch()}
      />
    );
  }
  const text = path ? source.data.files[path] : undefined;
  return (
    <div className="grid min-w-0 gap-3" data-testid="automation-code">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Select value={path ?? ""} onValueChange={setChosen}>
          <SelectTrigger size="sm" className="w-full max-w-72" aria-label="File">
            <SelectValue placeholder="No files" />
          </SelectTrigger>
          <SelectContent>
            {paths.map((p) => (
              <SelectItem key={p} value={p}>
                {p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-muted-foreground">
          {detail.extensionLabel ?? detail.extensionId}
          {detail.commit ? (
            <>
              {" "}
              at <code className="font-mono text-xs">{detail.commit.slice(0, 8)}</code>
            </>
          ) : (
            " · working copy"
          )}
        </span>
      </div>
      <pre className="max-h-[70vh] min-w-0 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
        <code>{text ?? "No source."}</code>
      </pre>
      <p className="text-xs text-muted-foreground">
        Read-only. Changes go through the extension workflow (Claude writes, you approve).
      </p>
    </div>
  );
}

export function VersionsTab({
  detail,
  isAdmin,
}: {
  detail: AutomationDetailData;
  isAdmin: boolean;
}) {
  const ext = useOp("extension.get", { id: detail.extensionId, runs: 0 });
  const rollback = useOpMutation("extension.rollback", {
    invalidates: ["schema.", "record.", "automation.", "extension."],
  });
  const [target, setTarget] = useState<{ commit: string; version: string } | null>(null);

  async function onRollback() {
    if (!target) return;
    try {
      const result = await rollback.mutateAsync({ id: detail.extensionId, commit: target.commit });
      toast.success(`Rolled back to ${result.version}`);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setTarget(null);
    }
  }

  if (ext.isPending) return <Skeleton className="h-48" />;
  if (ext.error) {
    return (
      <ErrorState
        title="Could not load versions"
        error={ext.error}
        onRetry={() => void ext.refetch()}
      />
    );
  }
  if (!ext.data.versions.length) {
    return <EmptyState icon={HistoryIcon} title="No installed versions" />;
  }
  return (
    <div className="grid gap-3" data-testid="automation-versions">
      <p className="text-sm text-muted-foreground">
        Versions of the {detail.extensionLabel ?? detail.extensionId} extension (its git history).
        Rolling back changes every automation, object and tool in it.
        {!isAdmin && " Only admins can roll back."}
      </p>
      <ul className="divide-y rounded-lg border" aria-label="Versions">
        {ext.data.versions.map((v) => {
          const current = v.commit === (detail.commit ?? ext.data.commit);
          return (
            <li
              key={v.commit}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm"
            >
              <span className="font-medium">{v.version}</span>
              <code className="font-mono text-xs text-muted-foreground">
                {v.commit.slice(0, 8)}
              </code>
              {current && <Badge variant="secondary">Current</Badge>}
              <span className="ml-auto text-muted-foreground">{formatDateTime(v.installedAt)}</span>
              {isAdmin && !current && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={rollback.isPending}
                  onClick={() => setTarget({ commit: v.commit, version: v.version })}
                >
                  Roll back
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <AlertDialog open={Boolean(target)} onOpenChange={(open) => !open && setTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Roll back to {target?.version}?</AlertDialogTitle>
            <AlertDialogDescription>
              The whole {detail.extensionLabel ?? detail.extensionId} extension goes back to this
              version. Fields a later version added are hidden, with their data kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void onRollback()}>Roll back</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
