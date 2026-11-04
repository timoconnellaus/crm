// People list: DataTable over person.list with the filter builder, column picker, saved views
// and bulk delete. Filter, sort and columns live in the URL.
import { personObject } from "@crm/core/client";
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
import { Avatar, AvatarFallback } from "@crm/ui/components/avatar";
import { Button } from "@crm/ui/components/button";
import { Kbd } from "@crm/ui/components/kbd";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Trash2Icon, UserPlusIcon, UsersIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { useAppCommands } from "#/components/app-commands";
import { ColumnPicker } from "#/components/data-table/column-picker";
import { DataTable, type ListPage, type ListPageRequest } from "#/components/data-table/data-table";
import { EmptyState } from "#/components/empty-state";
import { FilterBuilder } from "#/components/filter-builder/filter-builder";
import { PERSON_COLUMNS, PERSON_LIST_DEFAULTS, type PersonRow } from "#/components/people/config";
import { SavedViewsMenu } from "#/components/views/saved-views-menu";
import { parseViewSearch, useViewState, type ViewSearch } from "#/components/views/view-state";
import { initials } from "#/lib/format";
import { callOp } from "#/lib/operations";
import { invalidateOps } from "#/lib/query";
import { useUserLabel } from "#/lib/users-adapter";

export const Route = createFileRoute("/_app/people/")({
  validateSearch: (search: Record<string, unknown>): ViewSearch =>
    parseViewSearch(personObject, search),
  component: PeoplePage,
});

function PeoplePage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/people/" });
  const setSearch = useCallback(
    (next: ViewSearch) => navigate({ search: next, replace: true }),
    [navigate],
  );
  const view = useViewState({
    object: personObject,
    defaults: PERSON_LIST_DEFAULTS,
    search,
    setSearch,
  });
  const { create } = useAppCommands();
  const userLabel = useUserLabel();

  const fetchPage = useCallback(
    (input: ListPageRequest): Promise<ListPage<PersonRow>> => callOp("person.list", input),
    [],
  );

  return (
    <div className="mx-auto grid w-full grid-cols-1 max-w-7xl gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">People</h1>
        <SavedViewsMenu object="person" defaultLabel="All people" view={view} />
        <div className="flex-1" />
        <Button onClick={() => create("person")} aria-keyshortcuts="c">
          <UserPlusIcon />
          New person
          <Kbd className="ml-1 hidden bg-primary-foreground/20 text-primary-foreground sm:inline-flex">
            C
          </Kbd>
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <FilterBuilder object={personObject} value={view.state.filter} onChange={view.setFilter} />
        <div className="flex-1" />
        <ColumnPicker
          object={personObject}
          available={PERSON_COLUMNS}
          value={view.state.columns}
          onChange={view.setColumns}
        />
      </div>
      <DataTable<PersonRow>
        object={personObject}
        label="People"
        queryKey={["op", "person.list", "table"]}
        fetchPage={fetchPage}
        columns={view.state.columns}
        availableColumns={PERSON_COLUMNS}
        extraFields={["displayName"]}
        sort={view.state.sort}
        onSortChange={view.setSort}
        filter={view.state.filter}
        onOpen={(row) => navigate({ to: "/people/$id", params: { id: row.id } })}
        renderCell={{
          displayName: (row) => (
            <Link
              to="/people/$id"
              params={{ id: row.id }}
              className="inline-flex items-center gap-2 font-medium hover:underline"
            >
              <Avatar className="size-6">
                <AvatarFallback className="text-[10px]">
                  {initials(row.displayName ?? "")}
                </AvatarFallback>
              </Avatar>
              {row.displayName}
            </Link>
          ),
          ownerId: (row) =>
            userLabel(row.ownerId) || <span className="text-muted-foreground">—</span>,
        }}
        bulkActions={({ selected, clear }) => <BulkDelete people={selected} onDone={clear} />}
        empty={
          <EmptyState
            icon={UsersIcon}
            title="No people yet"
            description="Add the first person to start building your CRM."
            action={
              <Button onClick={() => create("person")}>
                <UserPlusIcon />
                New person
              </Button>
            }
          />
        }
      />
    </div>
  );
}

/**
 * Deletes the selected people one by one with person.delete.
 * TODO(stage-1-wire): switch to `person.deleteMany` { ids } (one audited bulk-write) when the
 * batch operations land, and offer Undo through `person.restoreMany`.
 */
function BulkDelete({ people, onDone }: { people: PersonRow[]; onDone: () => void }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const count = people.length;
  const noun = count === 1 ? "person" : "people";

  async function run() {
    setPending(true);
    const results = await Promise.allSettled(
      people.map((person) => callOp("person.delete", { id: person.id })),
    );
    setPending(false);
    setOpen(false);
    const deleted = people.filter((_, i) => results[i]?.status === "fulfilled");
    const failed = count - deleted.length;
    await invalidateOps(client, "person.");
    onDone();
    if (deleted.length) {
      toast.success(
        `Moved ${deleted.length} ${deleted.length === 1 ? "person" : "people"} to Trash`,
        {
          action: {
            label: "Undo",
            onClick: async () => {
              await Promise.allSettled(deleted.map((p) => callOp("person.restore", { id: p.id })));
              await invalidateOps(client, "person.");
            },
          },
        },
      );
    }
    if (failed) toast.error(`${failed} could not be deleted`);
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
