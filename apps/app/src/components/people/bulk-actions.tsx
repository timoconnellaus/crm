// Bulk actions for selected people: delete (person.deleteMany, with Undo restoring each one) and
// update tags / owner (person.updateMany). Selections over BATCH_SIZE go in several calls, each
// atomic on its own (ADR 0018 amendment).

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
import { Button } from "@crm/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@crm/ui/components/dialog";
import { Input } from "@crm/ui/components/input";
import { Label } from "@crm/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@crm/ui/components/select";
import { useQueryClient } from "@tanstack/react-query";
import { PencilIcon, Trash2Icon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { callOp } from "#/lib/operations";
import { errorMessage, invalidateAfterWrite } from "#/lib/query";
import { useUsers } from "#/lib/users-adapter";
import type { PersonRow } from "./config.ts";

/** person.*Many take at most this many ids per call (BATCH_MAX in @crm/core). */
export const BATCH_SIZE = 100;

function batches<T>(items: T[], size = BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const plural = (n: number) => (n === 1 ? "person" : "people");

export function BulkDelete({ people, onDone }: { people: PersonRow[]; onDone: () => void }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const count = people.length;

  async function run() {
    setPending(true);
    const deleted: string[] = [];
    let failure: unknown = null;
    for (const ids of batches(people.map((p) => p.id))) {
      try {
        await callOp("person.deleteMany", { ids });
        deleted.push(...ids);
      } catch (error) {
        failure = error;
        break;
      }
    }
    setPending(false);
    setOpen(false);
    await invalidateAfterWrite(client, "person.deleteMany");
    onDone();
    if (deleted.length) {
      toast.success(`Moved ${deleted.length} ${plural(deleted.length)} to Trash`, {
        action: {
          label: "Undo",
          onClick: async () => {
            // There is no batch restore: restore each one.
            const results = await Promise.allSettled(
              deleted.map((id) => callOp("person.restore", { id })),
            );
            await invalidateAfterWrite(client, "person.restore");
            const failed = results.filter((r) => r.status === "rejected").length;
            if (failed) toast.error(`${failed} could not be restored`);
          },
        },
      });
    }
    if (failure) {
      toast.error(`${count - deleted.length} could not be deleted: ${errorMessage(failure)}`);
    }
  }

  return (
    <>
      <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
        <Trash2Icon />
        Delete
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {count} {plural(count)}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              They move to Trash and can be restored for 30 days.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void run();
              }}
              disabled={pending}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {pending ? "Deleting…" : `Delete ${plural(count)}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

const KEEP = "__keep__";
const NONE = "__none__";

function tagList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ].slice(0, 10);
}

export function BulkUpdate({ people, onDone }: { people: PersonRow[]; onDone: () => void }) {
  const client = useQueryClient();
  const users = useUsers();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [owner, setOwner] = useState(KEEP);
  const [error, setError] = useState<string | null>(null);
  const count = people.length;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const addTags = tagList(String(form.get("addTags") ?? ""));
    const removeTags = tagList(String(form.get("removeTags") ?? ""));
    if (owner === KEEP && !addTags.length && !removeTags.length) {
      setError("Choose an owner or some tags to change");
      return;
    }
    setError(null);
    setPending(true);
    let updated = 0;
    try {
      for (const ids of batches(people.map((p) => p.id))) {
        await callOp("person.updateMany", {
          ids,
          set: owner === KEEP ? {} : { ownerId: owner === NONE ? null : owner },
          ...(addTags.length ? { addTags } : {}),
          ...(removeTags.length ? { removeTags } : {}),
        });
        updated += ids.length;
      }
      setOpen(false);
      setOwner(KEEP);
      onDone();
      toast.success(`Updated ${updated} ${plural(updated)}`);
    } catch (caught) {
      setError(
        updated ? `Updated ${updated}, then failed: ${errorMessage(caught)}` : errorMessage(caught),
      );
    } finally {
      setPending(false);
      await invalidateAfterWrite(client, "person.updateMany");
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <PencilIcon />
        Edit
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={submit} className="grid gap-4" aria-label="Edit people">
            <DialogHeader>
              <DialogTitle>
                Edit {count} {plural(count)}
              </DialogTitle>
              <DialogDescription>Fields you leave alone stay as they are.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="bulk-owner">Owner</Label>
              <Select value={owner} onValueChange={setOwner}>
                <SelectTrigger id="bulk-owner" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={KEEP}>Keep current owners</SelectItem>
                  <SelectItem value={NONE}>No owner</SelectItem>
                  {users.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bulk-add-tags">Add tags</Label>
              <Input id="bulk-add-tags" name="addTags" placeholder="VIP, Customer" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bulk-remove-tags">Remove tags</Label>
              <Input id="bulk-remove-tags" name="removeTags" placeholder="Lead" />
            </div>
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "Saving…" : "Apply"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
