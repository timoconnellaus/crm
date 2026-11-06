// Shared list actions for People and Organisations: the list menu (import, export) and the bulk
// actions for selected rows (merge two, tag, set owner, delete), over the batch operations.
import type { ObjectDefinition } from "@relationship-os/core/client";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@relationship-os/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@relationship-os/ui/components/dropdown-menu";
import { Label } from "@relationship-os/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@relationship-os/ui/components/select";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  DownloadIcon,
  EllipsisIcon,
  MergeIcon,
  TagIcon,
  Trash2Icon,
  UploadIcon,
  UserCogIcon,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { callOp } from "#/lib/operations";
import { errorMessage, invalidateAfterWrite } from "#/lib/query";
import { useUsers } from "#/lib/users-adapter";
import { AutomationBulkActions } from "../automations/record-automations.tsx";
import { TagInput } from "../fields.tsx";
import { MergeDialog } from "../merge/merge-dialog.tsx";
import type { ViewState } from "../views/view-state.ts";
import { AssignByRules } from "./assign-by-rules.tsx";
import { exportListCsv } from "./export-csv.ts";

export type ListObject = "person" | "organisation";

const NOUNS: Record<ListObject, { one: string; many: string }> = {
  person: { one: "person", many: "people" },
  organisation: { one: "organisation", many: "organisations" },
};

/** Ids in groups the batch operations accept (BATCH_MAX = 100 per call). */
export function batches<T>(items: readonly T[], size = 100): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// --- List menu ---------------------------------------------------------------------------------

export function ListActionsMenu({
  object,
  definition,
  view,
}: {
  object: ListObject;
  definition: ObjectDefinition;
  view: ViewState;
}) {
  const [exporting, setExporting] = useState(false);

  async function onExport() {
    setExporting(true);
    try {
      const { rowCount, truncated } = await exportListCsv({
        object: definition,
        filter: view.filter,
        sort: view.sort,
        columns: view.columns,
      });
      const noun = rowCount === 1 ? NOUNS[object].one : NOUNS[object].many;
      if (truncated) toast.warning(`Exported the first ${rowCount} ${noun}`);
      else toast.success(`Exported ${rowCount} ${noun}`);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setExporting(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label="List actions" disabled={exporting}>
          <EllipsisIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <Link to="/import" search={{ object }}>
            <UploadIcon />
            Import CSV
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void onExport()}>
          <DownloadIcon />
          Export CSV
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// --- Bulk actions ------------------------------------------------------------------------------

export interface BulkActionsProps {
  object: ListObject;
  selected: { id: string }[];
  onDone: () => void;
}

export function BulkActions({ object, selected, onDone }: BulkActionsProps) {
  return (
    <>
      {selected.length === 2 && (
        <BulkMerge object={object} ids={selected.map((r) => r.id)} onDone={onDone} />
      )}
      <BulkTagsAndOwner object={object} ids={selected.map((r) => r.id)} onDone={onDone} />
      <AssignByRules object={object} ids={selected.map((r) => r.id)} onDone={onDone} />
      <AutomationBulkActions object={object} ids={selected.map((r) => r.id)} onDone={onDone} />
      <BulkDelete object={object} ids={selected.map((r) => r.id)} onDone={onDone} />
    </>
  );
}

function BulkMerge({
  object,
  ids,
  onDone,
}: {
  object: ListObject;
  ids: string[];
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <MergeIcon />
        Merge
      </Button>
      <MergeDialog object={object} open={open} onOpenChange={setOpen} ids={ids} onMerged={onDone} />
    </>
  );
}

const KEEP = "__keep__";
const NO_OWNER = "__none__";

function BulkTagsAndOwner({
  object,
  ids,
  onDone,
}: {
  object: ListObject;
  ids: string[];
  onDone: () => void;
}) {
  const client = useQueryClient();
  const users = useUsers();
  const [open, setOpen] = useState(false);
  const [addTags, setAddTags] = useState<string[]>([]);
  const [removeTags, setRemoveTags] = useState<string[]>([]);
  const [owner, setOwner] = useState(KEEP);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noun = ids.length === 1 ? NOUNS[object].one : NOUNS[object].many;

  function reset(next: boolean) {
    setOpen(next);
    if (!next) {
      setAddTags([]);
      setRemoveTags([]);
      setOwner(KEEP);
      setError(null);
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const set = owner === KEEP ? {} : { ownerId: owner === NO_OWNER ? null : owner };
    if (!addTags.length && !removeTags.length && owner === KEEP) {
      reset(false);
      return;
    }
    setPending(true);
    try {
      for (const part of batches(ids)) {
        const input = {
          ids: part,
          set,
          ...(addTags.length ? { addTags } : {}),
          ...(removeTags.length ? { removeTags } : {}),
        };
        if (object === "person") await callOp("person.updateMany", input);
        else await callOp("organisation.updateMany", input);
      }
      await invalidateAfterWrite(client, `${object}.updateMany`);
      toast.success(`Updated ${ids.length} ${noun}`);
      reset(false);
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
      await invalidateAfterWrite(client, `${object}.updateMany`);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <TagIcon />
        Tags & owner
      </Button>
      <Dialog open={open} onOpenChange={reset}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={onSubmit} className="grid gap-4" aria-label="Edit selected">
            <DialogHeader>
              <DialogTitle>
                Edit {ids.length} {noun}
              </DialogTitle>
              <DialogDescription>
                Changes apply to every selected {NOUNS[object].one}.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-1.5">
              <Label htmlFor="bulk-add-tags">Add tags</Label>
              <TagInput id="bulk-add-tags" value={addTags} onChange={setAddTags} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="bulk-remove-tags">Remove tags</Label>
              <TagInput id="bulk-remove-tags" value={removeTags} onChange={setRemoveTags} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="bulk-owner">
                <UserCogIcon className="size-4" aria-hidden />
                Owner
              </Label>
              <Select value={owner} onValueChange={setOwner}>
                <SelectTrigger id="bulk-owner" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={KEEP}>Leave as is</SelectItem>
                  <SelectItem value={NO_OWNER}>No owner</SelectItem>
                  {users.map((user) => (
                    <SelectItem key={user.id} value={user.id}>
                      {user.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => reset(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "Applying…" : "Apply"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function BulkDelete({
  object,
  ids,
  onDone,
}: {
  object: ListObject;
  ids: string[];
  onDone: () => void;
}) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const count = ids.length;
  const noun = count === 1 ? NOUNS[object].one : NOUNS[object].many;

  async function run() {
    setPending(true);
    const deleted: string[] = [];
    let failure: unknown = null;
    for (const part of batches(ids)) {
      try {
        if (object === "person") await callOp("person.deleteMany", { ids: part });
        else await callOp("organisation.deleteMany", { ids: part });
        deleted.push(...part);
      } catch (error) {
        failure = error;
        break;
      }
    }
    setPending(false);
    setOpen(false);
    await invalidateAfterWrite(client, `${object}.deleteMany`);
    onDone();
    if (deleted.length) {
      toast.success(
        `Moved ${deleted.length} ${deleted.length === 1 ? NOUNS[object].one : NOUNS[object].many} to Trash`,
        {
          action: {
            label: "Undo",
            onClick: async () => {
              await Promise.allSettled(
                deleted.map((id) =>
                  object === "person"
                    ? callOp("person.restore", { id })
                    : callOp("organisation.restore", { id }),
                ),
              );
              await invalidateAfterWrite(client, `${object}.restore`);
            },
          },
        },
      );
    }
    if (failure) toast.error(`${count - deleted.length} not deleted: ${errorMessage(failure)}`);
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
              Delete {count} {noun}?
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
              {pending ? "Deleting…" : `Delete ${noun}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
