// Settings → My routines (ADR 0343 decision 8): what your assistant does on its own, each with its
// status and last and next run, and pause, edit, delete and test. This page and plugin pages are
// the only places the word appears; the chat talks about outcomes. Admins also set how often a
// schedule may run.
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@relationship-os/ui/components/dialog";
import { Input } from "@relationship-os/ui/components/input";
import { Label } from "@relationship-os/ui/components/label";
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { ErrorState } from "#/components/empty-state";
import { PageLayout } from "#/components/layout/page-layout";
import { formatDateTime } from "#/lib/format";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

export const Route = createFileRoute("/_app/settings/assistant-routines")({
  component: AssistantRoutinesPage,
});

type Routines = CoreOutput<"routine.list">;
type Routine = Routines["routines"][number];

const INVALIDATES = { invalidates: ["routine."] };

const STATUS: Record<
  Routine["status"],
  { label: string; variant: "default" | "secondary" | "destructive" }
> = {
  on: { label: "On", variant: "default" },
  paused: { label: "Paused", variant: "secondary" },
  failing: { label: "Failing", variant: "destructive" },
};

function EditDialog({ routine, onClose }: { routine: Routine; onClose: () => void }) {
  const [name, setName] = useState(routine.name);
  const [cron, setCron] = useState(routine.cron ?? "");
  const update = useOpMutation("routine.update", INVALIDATES);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {routine.name}</DialogTitle>
          <DialogDescription>
            To change what it sends or what it checks, ask your assistant in the chat.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="routine-name">Name</Label>
            <Input
              id="routine-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="routine-edit-name"
            />
          </div>
          {routine.cron !== null && (
            <div className="grid gap-1.5">
              <Label htmlFor="routine-cron">Schedule (cron)</Label>
              <Input
                id="routine-cron"
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                data-testid="routine-edit-cron"
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            data-testid="routine-edit-save"
            disabled={update.isPending}
            onClick={() =>
              update.mutate(
                {
                  id: routine.id,
                  name,
                  ...(routine.cron !== null && cron !== routine.cron ? { cron } : {}),
                },
                {
                  onSuccess: onClose,
                  onError: (error) => toast.error(errorMessage(error)),
                },
              )
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RoutineRow({ routine }: { routine: Routine }) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const pause = useOpMutation("routine.pause", INVALIDATES);
  const remove = useOpMutation("routine.delete", INVALIDATES);
  const test = useOpMutation("routine.test", INVALIDATES);
  const status = STATUS[routine.status];
  const paused = routine.status === "paused";
  const onError = (error: unknown) => toast.error(errorMessage(error));
  return (
    <Card data-testid="routine-row">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="min-w-0 break-words">{routine.name}</CardTitle>
          <Badge variant={status.variant} data-testid="routine-status">
            {status.label}
          </Badge>
        </div>
        <CardDescription className="break-words">
          {routine.when}, I'll {routine.what}.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {routine.statusReason && (
          <p className="break-words text-muted-foreground">{routine.statusReason}</p>
        )}
        {(routine.gates.length > 0 || routine.checks.length > 0) && (
          <ul className="grid gap-0.5 text-muted-foreground">
            {[...routine.gates, ...routine.checks].map((gate) => (
              <li key={gate} className="break-words">
                Only if: {gate}
              </li>
            ))}
          </ul>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-muted-foreground">
          <dt>Last run</dt>
          <dd data-testid="routine-last-run">
            {routine.lastRunAt ? formatDateTime(routine.lastRunAt) : "Not yet"}
          </dd>
          <dt>Next run</dt>
          <dd data-testid="routine-next-run">
            {routine.nextRunAt
              ? formatDateTime(routine.nextRunAt)
              : paused
                ? "Paused"
                : "When it happens"}
          </dd>
        </dl>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            data-testid="routine-pause"
            disabled={pause.isPending}
            onClick={() => pause.mutate({ id: routine.id, resume: paused }, { onError })}
          >
            {paused ? "Resume" : "Pause"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="routine-test"
            disabled={test.isPending}
            onClick={() =>
              test.mutate(
                { id: routine.id },
                {
                  onSuccess: (result) =>
                    result.sent
                      ? toast.success("Sent to your chat")
                      : toast.info(`Nothing sent: ${result.reason ?? "its checks did not pass"}`),
                  onError,
                },
              )
            }
          >
            Test
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDeleting(true)}>
            Delete
          </Button>
        </div>
      </CardContent>
      {editing && <EditDialog routine={routine} onClose={() => setEditing(false)} />}
      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {routine.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              It stops for good, and its run history goes with it. Messages it already sent stay in
              your chat.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              data-testid="routine-delete-confirm"
              onClick={() => remove.mutate({ id: routine.id }, { onError })}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function MinInterval({ value }: { value: number }) {
  const [minutes, setMinutes] = useState(String(value));
  const update = useOpMutation("routine.updateSettings", INVALIDATES);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Shortest schedule</CardTitle>
        <CardDescription>
          How often anyone's routine may run on a schedule, in minutes. 15 is the lowest.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-end gap-2">
        <div className="grid gap-1.5">
          <Label htmlFor="routine-min-interval">Minutes</Label>
          <Input
            id="routine-min-interval"
            type="number"
            min={15}
            max={1440}
            className="w-28"
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
          />
        </div>
        <Button
          variant="outline"
          disabled={update.isPending}
          onClick={() =>
            update.mutate(
              { minIntervalMinutes: Number(minutes) },
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

function AssistantRoutinesPage() {
  const { isAdmin } = Route.useRouteContext();
  const routines = useOp("routine.list", {});
  return (
    <PageLayout
      title="My routines"
      width="md"
      back={{ to: "/settings", label: "Settings" }}
      description="What your assistant does on its own. You turned each of these on, and only you can see them."
    >
      {routines.isPending ? (
        <Skeleton className="h-72" />
      ) : routines.isError ? (
        <ErrorState title="Could not load your routines" error={routines.error} />
      ) : (
        <div className="grid gap-4">
          {routines.data.routines.length === 0 && (
            <p className="text-sm text-muted-foreground" data-testid="routines-empty">
              Nothing yet. Ask your assistant in the chat, for example "send me a morning briefing".
            </p>
          )}
          {routines.data.routines.map((routine) => (
            <RoutineRow key={routine.id} routine={routine} />
          ))}
          {isAdmin && <MinInterval value={routines.data.minIntervalMinutes} />}
        </div>
      )}
    </PageLayout>
  );
}
