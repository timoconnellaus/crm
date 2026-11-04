// Saved views picker for a list: apply a view (table, board, calendar or gallery), save the
// current state as a personal or shared view, update or delete the active one (when you may), or
// reset to the default. Persistence is the SavedViewsAdapter (view.*).
import { Badge } from "@crm/ui/components/badge";
import { Button } from "@crm/ui/components/button";
import { Checkbox } from "@crm/ui/components/checkbox";
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
import {
  CalendarIcon,
  CheckIcon,
  ChevronDownIcon,
  KanbanIcon,
  LayoutGridIcon,
  RotateCcwIcon,
  SaveIcon,
  TableIcon,
  Trash2Icon,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "#/lib/query";
import {
  type SavedView,
  type SavedViewObject,
  type SavedViewSpec,
  type SavedViewsAdapter,
  savedViews,
} from "./saved-views-adapter.ts";
import type { ViewStateApi } from "./view-state.ts";

export interface SavedViewsMenuProps {
  /** Registry name of the list's object, e.g. "person". */
  object: SavedViewObject;
  /** Label of the unsaved default view, e.g. "All people". */
  defaultLabel: string;
  /** The list's view state (from useViewState). */
  view: ViewStateApi;
  /** Persistence (default: the app's adapter). */
  adapter?: SavedViewsAdapter;
}

const TYPE_ICONS = {
  table: TableIcon,
  board: KanbanIcon,
  calendar: CalendarIcon,
  gallery: LayoutGridIcon,
} as const;

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
  const [share, setShare] = useState(false);
  const active = views.find((v) => v.id === view.viewId);

  const spec = (): SavedViewSpec => ({
    type: view.state.type,
    ...(view.state.filter ? { filter: view.state.filter } : {}),
    sort: view.state.sort,
    columns: view.state.columns,
    ...(view.state.type !== "table" ? { layout: view.state.layout } : {}),
  });

  // Optimistic: the menu shows a created, updated or deleted view at once and rolls back if the
  // write fails. Deleting offers Undo (the view is saved again).
  type Snapshot = { previous: SavedView[] | undefined };
  const snapshot = async (): Promise<Snapshot> => {
    await client.cancelQueries({ queryKey: key });
    return { previous: client.getQueryData<SavedView[]>(key) };
  };
  const rollback = (_error: unknown, _input: unknown, context: Snapshot | undefined) => {
    if (context) client.setQueryData(key, context.previous);
  };
  const settle = () => client.invalidateQueries({ queryKey: key });

  const create = useMutation({
    mutationFn: (name: string) => adapter.create({ object, name, spec: spec(), shared: share }),
    onMutate: async (name): Promise<Snapshot> => {
      const context = await snapshot();
      const draft: SavedView = {
        id: `pending:${name}`,
        name,
        object,
        spec: spec(),
        shared: share,
        canEdit: true,
      };
      client.setQueryData<SavedView[]>(key, (views = []) => [...views, draft]);
      setSaving(false);
      return context;
    },
    onSuccess: (created) => {
      client.setQueryData<SavedView[]>(key, (views = []) =>
        views.map((v) => (v.id === `pending:${created.name}` ? created : v)),
      );
      view.apply(view.state, created.id);
      toast.success(`Saved view “${created.name}”`);
    },
    onError: (error, name, context) => {
      rollback(error, name, context);
      toast.error(errorMessage(error));
    },
    onSettled: settle,
  });
  const update = useMutation({
    mutationFn: (target: SavedView) => adapter.update(target.id, { spec: spec() }),
    onMutate: async (target): Promise<Snapshot> => {
      const context = await snapshot();
      const next = spec();
      client.setQueryData<SavedView[]>(key, (views = []) =>
        views.map((v) => (v.id === target.id ? { ...v, spec: next } : v)),
      );
      return context;
    },
    onSuccess: (updated) => toast.success(`Updated view “${updated.name}”`),
    onError: (error, target, context) => {
      rollback(error, target, context);
      toast.error(errorMessage(error));
    },
    onSettled: settle,
  });
  const remove = useMutation({
    mutationFn: (target: SavedView) => adapter.remove(target.id),
    onMutate: async (target): Promise<Snapshot> => {
      const context = await snapshot();
      client.setQueryData<SavedView[]>(key, (views = []) =>
        views.filter((v) => v.id !== target.id),
      );
      view.reset();
      return context;
    },
    onSuccess: (_result, target) =>
      toast.success(`Deleted view “${target.name}”`, {
        action: {
          label: "Undo",
          onClick: () =>
            void adapter
              .create({ object, name: target.name, spec: target.spec })
              .then(() => settle())
              .catch((error: unknown) => toast.error(errorMessage(error))),
        },
      }),
    onError: (error, target, context) => {
      rollback(error, target, context);
      toast.error(errorMessage(error));
    },
    onSettled: settle,
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
          {views.map((saved) => {
            const TypeIcon = TYPE_ICONS[saved.spec.type] ?? TableIcon;
            return (
              <DropdownMenuItem
                key={saved.id}
                onSelect={() =>
                  view.apply(
                    {
                      type: saved.spec.type,
                      filter: saved.spec.filter,
                      ...(saved.spec.sort ? { sort: saved.spec.sort } : {}),
                      ...(saved.spec.columns ? { columns: saved.spec.columns } : {}),
                      ...(saved.spec.layout ? { layout: saved.spec.layout } : {}),
                    },
                    saved.id,
                  )
                }
              >
                {saved.id === view.viewId ? <CheckIcon /> : <span className="size-4" />}
                <TypeIcon className="text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{saved.name}</span>
                {saved.shared && (
                  <Badge variant="outline" className="ml-auto text-[10px]">
                    Shared
                  </Badge>
                )}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setSaving(true)}>
            <SaveIcon />
            Save as new view…
          </DropdownMenuItem>
          {active && active.canEdit !== false && (
            <DropdownMenuItem disabled={!view.isDirty} onSelect={() => update.mutate(active)}>
              <SaveIcon />
              Update “{active.name}”
            </DropdownMenuItem>
          )}
          {active && active.canEdit !== false && (
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
                Saves the current view type, filter, sort and columns.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="view-name">Name</Label>
              <Input id="view-name" name="name" required maxLength={100} autoFocus />
            </div>
            <Label className="flex items-center gap-2 font-normal">
              <Checkbox checked={share} onCheckedChange={(checked) => setShare(checked === true)} />
              Share with everyone in the org
            </Label>
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
