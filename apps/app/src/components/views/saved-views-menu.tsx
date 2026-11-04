// Saved views picker for a list: apply a view, save the current state as a view, update or
// delete the active one, or reset to the default. Persistence is the SavedViewsAdapter.
import { Button } from "@crm/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@crm/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@crm/ui/components/dropdown-menu";
import { Input } from "@crm/ui/components/input";
import { Label } from "@crm/ui/components/label";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, ChevronDownIcon, RotateCcwIcon, SaveIcon, Trash2Icon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "#/lib/query";
import {
  type SavedView,
  type SavedViewSpec,
  type SavedViewsAdapter,
  savedViews,
} from "./saved-views-adapter.ts";
import type { ViewStateApi } from "./view-state.ts";

export interface SavedViewsMenuProps {
  /** Registry name of the list's object, e.g. "person". */
  object: string;
  /** Label of the unsaved default view, e.g. "All people". */
  defaultLabel: string;
  /** The list's view state (from useViewState). */
  view: ViewStateApi;
  /** Persistence (default: the app's adapter). */
  adapter?: SavedViewsAdapter;
}

export function SavedViewsMenu({
  object,
  defaultLabel,
  view,
  adapter = savedViews,
}: SavedViewsMenuProps) {
  const client = useQueryClient();
  const key = ["saved-views", object];
  const { data: views = [] } = useQuery({ queryKey: key, queryFn: () => adapter.list(object) });
  const [saving, setSaving] = useState(false);
  const active = views.find((v) => v.id === view.viewId);

  const spec = (): SavedViewSpec => ({
    type: "table",
    ...(view.state.filter ? { filter: view.state.filter } : {}),
    sort: view.state.sort,
    columns: view.state.columns,
  });

  const create = useMutation({
    mutationFn: (name: string) => adapter.create({ object, name, spec: spec() }),
    onSuccess: async (created) => {
      await client.invalidateQueries({ queryKey: key });
      view.apply(view.state, created.id);
      setSaving(false);
      toast.success(`Saved view “${created.name}”`);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const update = useMutation({
    mutationFn: (target: SavedView) => adapter.update(target.id, { spec: spec() }),
    onSuccess: async (updated) => {
      await client.invalidateQueries({ queryKey: key });
      toast.success(`Updated view “${updated.name}”`);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const remove = useMutation({
    mutationFn: (target: SavedView) => adapter.remove(target.id),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: key });
      view.reset();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    if (name) create.mutate(name);
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="gap-1 font-medium" data-testid="views-menu">
            {active?.name ?? defaultLabel}
            {view.isDirty && active && <span className="text-muted-foreground">(edited)</span>}
            <ChevronDownIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          <DropdownMenuLabel>Views</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => view.reset()}>
            {!view.viewId && !view.isDirty ? <CheckIcon /> : <span className="size-4" />}
            {defaultLabel}
          </DropdownMenuItem>
          {views.map((saved) => (
            <DropdownMenuItem
              key={saved.id}
              onSelect={() =>
                view.apply(
                  {
                    filter: saved.spec.filter,
                    ...(saved.spec.sort ? { sort: saved.spec.sort } : {}),
                    ...(saved.spec.columns ? { columns: saved.spec.columns } : {}),
                  },
                  saved.id,
                )
              }
            >
              {saved.id === view.viewId ? <CheckIcon /> : <span className="size-4" />}
              {saved.name}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setSaving(true)}>
            <SaveIcon />
            Save as new view…
          </DropdownMenuItem>
          {active && (
            <DropdownMenuItem disabled={!view.isDirty} onSelect={() => update.mutate(active)}>
              <SaveIcon />
              Update “{active.name}”
            </DropdownMenuItem>
          )}
          {active && (
            <DropdownMenuItem variant="destructive" onSelect={() => remove.mutate(active)}>
              <Trash2Icon />
              Delete “{active.name}”
            </DropdownMenuItem>
          )}
          {view.isDirty && (
            <DropdownMenuItem onSelect={() => view.reset()}>
              <RotateCcwIcon />
              Reset to default
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={saving} onOpenChange={setSaving}>
        <DialogContent className="sm:max-w-sm">
          <form onSubmit={onSave} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Save view</DialogTitle>
              <DialogDescription>
                Saves the current filter, sort and columns for you.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="view-name">Name</Label>
              <Input id="view-name" name="name" required maxLength={100} autoFocus />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={create.isPending}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
