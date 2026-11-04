// People list: DataTable over person.list with the filter builder, column picker, saved views,
// import/export, and bulk merge, tags/owner and delete. Filter, sort and columns live in the URL.
import { personObject } from "@crm/core/client";
import { Avatar, AvatarFallback } from "@crm/ui/components/avatar";
import { Button } from "@crm/ui/components/button";
import { Kbd } from "@crm/ui/components/kbd";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { UserPlusIcon, UsersIcon } from "lucide-react";
import { useCallback } from "react";
import { useAppCommands } from "#/components/app-commands";
import { ColumnPicker } from "#/components/data-table/column-picker";
import { DataTable, type ListPage, type ListPageRequest } from "#/components/data-table/data-table";
import { EmptyState } from "#/components/empty-state";
import { FilterBuilder } from "#/components/filter-builder/filter-builder";
import { BulkActions, ListActionsMenu } from "#/components/list/list-actions";
import { PERSON_COLUMNS, PERSON_LIST_DEFAULTS, type PersonRow } from "#/components/people/config";
import { SavedViewsMenu } from "#/components/views/saved-views-menu";
import { parseViewSearch, useViewState, type ViewSearch } from "#/components/views/view-state";
import { initials } from "#/lib/format";
import { callOp } from "#/lib/operations";
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
        <ListActionsMenu object="person" definition={personObject} view={view.state} />
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
        bulkActions={({ selected, clear }) => (
          <BulkActions object="person" selected={selected} onDone={clear} />
        )}
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
