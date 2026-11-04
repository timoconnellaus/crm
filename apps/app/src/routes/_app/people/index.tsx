// People list: a fixed header (title, live count, saved views, actions, filter builder, column
// picker) over a virtualised, infinitely scrolling DataTable of person.list, with import/export
// and bulk merge, tags/owner and delete. Filter, sort and columns live in the URL; hovering a link
// here preloads the first page and the count.
import { personObject } from "@crm/core/client";
import { Avatar, AvatarFallback } from "@crm/ui/components/avatar";
import { Button } from "@crm/ui/components/button";
import { Kbd } from "@crm/ui/components/kbd";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { UserPlusIcon, UsersIcon } from "lucide-react";
import { useCallback } from "react";
import { useAppCommands } from "#/components/app-commands";
import { ColumnPicker } from "#/components/data-table/column-picker";
import {
  DataTable,
  type ListPage,
  type ListPageRequest,
  listFields,
  listQueryOptions,
} from "#/components/data-table/data-table";
import { EmptyState } from "#/components/empty-state";
import { FilterBuilder } from "#/components/filter-builder/filter-builder";
import { PageCount, PageLayout } from "#/components/layout/page-layout";
import { BulkActions, ListActionsMenu } from "#/components/list/list-actions";
import { PERSON_COLUMNS, PERSON_LIST_DEFAULTS, type PersonRow } from "#/components/people/config";
import { ObjectViewBody, scrollFor, ViewTypeSwitcher } from "#/components/views/object-views";
import { SavedViewsMenu } from "#/components/views/saved-views-menu";
import {
  parseViewSearch,
  searchToViewState,
  useViewState,
  type ViewSearch,
} from "#/components/views/view-state";
import { countQueryOptions, useRecordCount } from "#/lib/count";
import { initials } from "#/lib/format";
import { callOp } from "#/lib/operations";
import { useObjectInfo } from "#/lib/schema";
import { useUserLabel } from "#/lib/users-adapter";

const QUERY_KEY = ["op", "person.list", "table"] as const;
const EXTRA_FIELDS = ["displayName"] as const;
const fetchPeople = (input: ListPageRequest): Promise<ListPage<PersonRow>> =>
  callOp("person.list", input);

export const Route = createFileRoute("/_app/people/")({
  validateSearch: (search: Record<string, unknown>): ViewSearch =>
    parseViewSearch(personObject, search),
  loaderDeps: ({ search }) => ({ search }),
  // Intent preloading: warm the first page and the count (browser only; data is never fetched
  // during the server render).
  loader: ({ context, deps }) => {
    if (typeof window === "undefined") return;
    const state = searchToViewState(personObject, deps.search, PERSON_LIST_DEFAULTS);
    const { fields } = listFields(personObject, state.columns, PERSON_COLUMNS, EXTRA_FIELDS);
    void context.queryClient.ensureInfiniteQueryData(
      listQueryOptions({
        queryKey: QUERY_KEY,
        fetchPage: fetchPeople,
        filter: state.filter,
        sort: state.sort,
        fields,
      }),
    );
    void context.queryClient.ensureQueryData(countQueryOptions("person", state.filter));
  },
  component: PeoplePage,
});

function PeoplePage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/people/" });
  const setSearch = useCallback(
    (update: (current: ViewSearch) => ViewSearch) => navigate({ search: update, replace: true }),
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
  const count = useRecordCount("person", view.state.filter);
  const { object: info } = useObjectInfo("person");
  const type = view.state.type;

  return (
    <PageLayout
      title="People"
      width="fluid"
      scroll={scrollFor(type)}
      count={
        <PageCount
          value={count.data?.count}
          capped={count.data?.capped}
          isPending={count.isPending}
          noun="people"
        />
      }
      titleAddon={<SavedViewsMenu object="person" defaultLabel="All people" view={view} />}
      actions={
        <>
          <ListActionsMenu object="person" definition={personObject} view={view.state} />
          <Button onClick={() => create("person")} aria-keyshortcuts="c">
            <UserPlusIcon />
            <span className="max-sm:sr-only">New person</span>
            <Kbd className="ml-1 hidden bg-primary-foreground/20 text-primary-foreground sm:inline-flex">
              C
            </Kbd>
          </Button>
        </>
      }
      toolbar={
        <>
          <FilterBuilder
            object={personObject}
            value={view.state.filter}
            onChange={view.setFilter}
          />
          <div className="flex-1" />
          {info && <ViewTypeSwitcher info={info} view={view} />}
          {type === "table" && (
            <ColumnPicker
              object={personObject}
              available={PERSON_COLUMNS}
              value={view.state.columns}
              onChange={view.setColumns}
            />
          )}
        </>
      }
    >
      {type !== "table" ? (
        info && <ObjectViewBody info={info} view={view} />
      ) : (
        <DataTable<PersonRow>
          object={personObject}
          label="People"
          queryKey={QUERY_KEY}
          fetchPage={fetchPeople}
          columns={view.state.columns}
          availableColumns={PERSON_COLUMNS}
          extraFields={EXTRA_FIELDS}
          sort={view.state.sort}
          onSortChange={view.setSort}
          filter={view.state.filter}
          total={count.data}
          pendingObject="person"
          onOpen={(row) => navigate({ to: "/people/$id", params: { id: row.id } })}
          renderCell={{
            displayName: (row) => (
              <Link
                to="/people/$id"
                params={{ id: row.id }}
                className="inline-flex min-w-0 items-center gap-2 font-medium hover:underline"
              >
                <Avatar className="size-6">
                  <AvatarFallback className="text-[10px]">
                    {initials(row.displayName ?? "")}
                  </AvatarFallback>
                </Avatar>
                <span className="truncate">{row.displayName}</span>
              </Link>
            ),
            ownerId: (row) =>
              userLabel(row.ownerId) || <span className="text-muted-foreground">—</span>,
          }}
          bulkActions={({ ids, clear }) => (
            <BulkActions object="person" selected={ids.map((id) => ({ id }))} onDone={clear} />
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
      )}
    </PageLayout>
  );
}
