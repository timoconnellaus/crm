// "New task" quick-add, from anywhere: `c` on Tasks, "+ Task" on a record page, the record's
// Tasks card, or the command palette. Creates via task.create, linked to the record it was
// opened from (if any), assigned to the chosen user (default: you).
import { Button } from "@relationship-os/ui/components/button";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@relationship-os/ui/components/select";
import { Textarea } from "@relationship-os/ui/components/textarea";
import { useRouteContext } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { errorMessage, useOpMutation } from "#/lib/query";
import { useUsers } from "#/lib/users-adapter";
import type { CreateLink } from "../app-commands.tsx";

export interface CreateTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The record the task is about. */
  link?: CreateLink;
}

const UNASSIGNED = "__unassigned__";

export function CreateTaskDialog({ open, onOpenChange, link }: CreateTaskDialogProps) {
  const { user } = useRouteContext({ from: "/_app" });
  const users = useUsers();
  const create = useOpMutation("task.create");
  const [error, setError] = useState<string | null>(null);
  const [assignee, setAssignee] = useState(user.id);

  useEffect(() => {
    if (open) {
      setError(null);
      setAssignee(user.id);
    }
  }, [open, user.id]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "").trim();
    try {
      const task = await create.mutateAsync({
        title: text("title"),
        dueAt: text("dueAt") || null,
        notes: text("notes") || null,
        assigneeId: assignee === UNASSIGNED ? null : assignee,
        ...(link ? { links: [{ object: link.object, id: link.id }] } : {}),
      });
      onOpenChange(false);
      toast.success(`Added task “${task.title}”`);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={onSubmit} className="grid gap-4" aria-label="New task">
          <DialogHeader>
            <DialogTitle>New task</DialogTitle>
            <DialogDescription>
              {link ? `A follow-up about ${link.title ?? "this record"}.` : "A follow-up to do."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="new-task-title">Title</Label>
            <Input id="new-task-title" name="title" required maxLength={500} autoFocus />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="new-task-due">Due date</Label>
              <Input id="new-task-due" name="dueAt" type="date" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="new-task-assignee">Assignee</Label>
              <Select value={assignee} onValueChange={setAssignee}>
                <SelectTrigger id="new-task-assignee" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                  {users.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.id === user.id ? `${u.name} (me)` : u.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="new-task-notes">Notes</Label>
            <Textarea id="new-task-notes" name="notes" maxLength={50_000} className="min-h-16" />
          </div>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? "Adding…" : "Add task"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
