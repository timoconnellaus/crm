// Dashboards: every dashboard you can open (the shipped Overview, shared ones and your own),
// which is your Home, and a dialog to create a new one (blank, or a copy).
import { Button } from "@relationship-os/ui/components/button";
import { Checkbox } from "@relationship-os/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@relationship-os/ui/components/dialog";
import { Input } from "@relationship-os/ui/components/input";
import { Label } from "@relationship-os/ui/components/label";
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { HomeIcon, LayoutDashboardIcon, PlusIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { SharedBadge } from "#/components/dashboards/dashboard-view";
import { EmptyState, ErrorState } from "#/components/empty-state";
import { PageCount, PageLayout } from "#/components/layout/page-layout";
import { callOp } from "#/lib/operations";
import { errorMessage, invalidateOps, useOp } from "#/lib/query";

export const Route = createFileRoute("/_app/dashboards/")({ component: DashboardsPage });

function DashboardsPage() {
  const list = useOp("dashboard.list", {});
  const [creating, setCreating] = useState(false);
  return (
    <PageLayout
      title="Dashboards"
      width="lg"
      count={
        <PageCount value={list.data?.items.length} isPending={list.isPending} noun="dashboards" />
      }
      actions={
        <Button onClick={() => setCreating(true)} data-testid="new-dashboard">
          <PlusIcon />
          <span className="max-sm:sr-only">New dashboard</span>
        </Button>
      }
    >
      {list.isPending ? (
        <div className="grid gap-2">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : list.isError ? (
        <ErrorState
          title="Could not load dashboards"
          error={list.error}
          onRetry={() => void list.refetch()}
        />
      ) : !list.data.items.length ? (
        <EmptyState icon={LayoutDashboardIcon} title="No dashboards yet" />
      ) : (
        <ul className="grid gap-2" aria-label="Dashboards">
          {list.data.items.map((d) => (
            <li key={d.id}>
              <Link
                to="/dashboards/$id"
                params={{ id: d.id }}
                className="flex items-center gap-3 rounded-lg border p-3 hover:bg-accent/50"
              >
                <LayoutDashboardIcon className="size-5 text-muted-foreground" aria-hidden />
                <span className="grid min-w-0 flex-1">
                  <span className="truncate font-medium">{d.title}</span>
                  {d.description && (
                    <span className="truncate text-sm text-muted-foreground">{d.description}</span>
                  )}
                </span>
                {d.isHome && (
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <HomeIcon className="size-3.5" /> Home
                  </span>
                )}
                <SharedBadge shared={d.shared} builtIn={d.builtIn} />
              </Link>
            </li>
          ))}
        </ul>
      )}
      {creating && <CreateDashboardDialog onClose={() => setCreating(false)} />}
    </PageLayout>
  );
}

function CreateDashboardDialog({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = String(new FormData(event.currentTarget).get("title") ?? "").trim();
    if (!title) return;
    setBusy(true);
    try {
      const created = await callOp("dashboard.create", {
        title,
        shared,
        filters: [
          { type: "dateRange", id: "date", label: "Date", default: "last_90_days" },
          { type: "user", id: "owner", label: "Owner", default: "anyone" },
        ],
        widgets: [],
      });
      await invalidateOps(client, "dashboard.");
      onClose();
      navigate({ to: "/dashboards/$id", params: { id: created.id } });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New dashboard</DialogTitle>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="dashboard-title">Title</Label>
            <Input id="dashboard-title" name="title" required maxLength={200} autoFocus />
          </div>
          <Label className="flex items-center gap-2 font-normal">
            <Checkbox checked={shared} onCheckedChange={(c) => setShared(c === true)} />
            Share with everyone in the org
          </Label>
          <DialogFooter>
            <Button type="submit" disabled={busy}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
