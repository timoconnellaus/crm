// Organisations list: a fixed header (title, live count, saved views, actions, filter builder,
// column picker) over a virtualised, infinitely scrolling DataTable of organisation.list, with
// import/export and bulk merge, tags/owner and delete. Filter, sort and columns live in the URL;
// hovering a link here preloads the first page and the count.
import { organisationObject } from "@crm/core/client";
import { Avatar, AvatarFallback, AvatarImage } from "@crm/ui/components/avatar";
import { Button } from "@crm/ui/components/button";
import { Kbd } from "@crm/ui/components/kbd";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Building2Icon, PlusIcon } from "lucide-react";
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
import {
  faviconUrl,
  ORGANISATION_COLUMNS,
  ORGANISATION_LIST_DEFAULTS,
  type OrganisationRow,
} from "#/components/organisations/config";
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

const QUERY_KEY = ["op", "organisation.list", "table"] as const;
const EXTRA_FIELDS = ["name", "primaryDomain", "parentId"] as const;
const fetchOrganisations = (input: ListPageRequest): Promise<ListPage<OrganisationRow>> =>
  callOp("organisation.list", input);

export const Route = createFileRoute("/_app/organisations/")({
  validateSearch: (search: Record<string, unknown>): ViewSearch =>
    parseViewSearch(organisationObject, search),
  loaderDeps: ({ search }) => ({ search }),
  // Intent preloading: warm the first page and the count (browser only).
  loader: ({ context, deps }) => {
    if (typeof window === "undefined") return;
    const state = searchToViewState(organisationObject, deps.search, ORGANISATION_LIST_DEFAULTS);
    const { fields } = listFields(
      organisationObject,
      state.columns,
      ORGANISATION_COLUMNS,
      EXTRA_FIELDS,
    );
    void context.queryClient.ensureInfiniteQueryData(
      listQueryOptions({
        queryKey: QUERY_KEY,
        fetchPage: fetchOrganisations,
        filter: state.filter,
        sort: state.sort,
        fields,
      }),
    );
    void context.queryClient.ensureQueryData(countQueryOptions("organisation", state.filter));
  },
  component: OrganisationsPage,
});

function OrganisationsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/organisations/" });
  const setSearch = useCallback(
    (update: (current: ViewSearch) => ViewSearch) => navigate({ search: update, replace: true }),
    [navigate],
  );
  const view = useViewState({
    object: organisationObject,
    defaults: ORGANISATION_LIST_DEFAULTS,
    search,
    setSearch,
  });
  const { create } = useAppCommands();
  const userLabel = useUserLabel();
  const count = useRecordCount("organisation", view.state.filter);
  const { object: info } = useObjectInfo("organisation");
  const type = view.state.type;

  return (
    <PageLayout
      title="Organisations"
      width="fluid"
      scroll={scrollFor(type)}
      count={
        <PageCount
          value={count.data?.count}
          capped={count.data?.capped}
          isPending={count.isPending}
          noun="organisations"
        />
      }
      titleAddon={
        <SavedViewsMenu object="organisation" defaultLabel="All organisations" view={view} />
      }
      actions={
        <>
          <ListActionsMenu
            object="organisation"
            definition={organisationObject}
            view={view.state}
          />
          <Button onClick={() => create("organisation")} aria-keyshortcuts="c">
            <PlusIcon />
            <span className="max-sm:sr-only">New organisation</span>
            <Kbd className="ml-1 hidden bg-primary-foreground/20 text-primary-foreground sm:inline-flex">
              C
            </Kbd>
          </Button>
        </>
      }
      toolbar={
        <>
          <FilterBuilder
            object={organisationObject}
            value={view.state.filter}
            onChange={view.setFilter}
          />
          <div className="flex-1" />
          {info && <ViewTypeSwitcher info={info} view={view} />}
          {type === "table" && (
            <ColumnPicker
              object={organisationObject}
              available={ORGANISATION_COLUMNS}
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
        <DataTable<OrganisationRow>
          object={organisationObject}
          label="Organisations"
          queryKey={QUERY_KEY}
          fetchPage={fetchOrganisations}
          columns={view.state.columns}
          availableColumns={ORGANISATION_COLUMNS}
          extraFields={EXTRA_FIELDS}
          sort={view.state.sort}
          onSortChange={view.setSort}
          filter={view.state.filter}
          total={count.data}
          pendingObject="organisation"
          onOpen={(row) => navigate({ to: "/organisations/$id", params: { id: row.id } })}
          renderCell={{
            name: (row) => (
              <Link
                to="/organisations/$id"
                params={{ id: row.id }}
                className="inline-flex min-w-0 items-center gap-2 font-medium hover:underline"
              >
                <Avatar className="size-6 rounded-md">
                  {row.primaryDomain && (
                    <AvatarImage src={faviconUrl(row.primaryDomain) ?? undefined} alt="" />
                  )}
                  <AvatarFallback className="rounded-md text-[10px]">
                    {initials(row.name ?? "")}
                  </AvatarFallback>
                </Avatar>
                <span className="truncate">{row.name}</span>
              </Link>
            ),
            parentName: (row) =>
              row.parentId ? (
                <Link
                  to="/organisations/$id"
                  params={{ id: row.parentId }}
                  className="hover:underline"
                >
                  {row.parentName ?? row.parentId}
                </Link>
              ) : (
                <span className="text-muted-foreground">—</span>
              ),
            ownerId: (row) =>
              userLabel(row.ownerId) || <span className="text-muted-foreground">—</span>,
          }}
          bulkActions={({ ids, clear }) => (
            <BulkActions
              object="organisation"
              selected={ids.map((id) => ({ id }))}
              onDone={clear}
            />
          )}
          empty={
            <EmptyState
              icon={Building2Icon}
              title="No organisations yet"
              description="Add an organisation, or import a CSV of companies."
              action={
                <Button onClick={() => create("organisation")}>
                  <PlusIcon />
                  New organisation
                </Button>
              }
            />
          }
        />
      )}
    </PageLayout>
  );
}
