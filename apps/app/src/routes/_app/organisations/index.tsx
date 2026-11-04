// Organisations list: DataTable over organisation.list with the filter builder, column picker,
// saved views, import/export, and bulk merge, tags/owner and delete. Filter, sort and columns
// live in the URL.
import { organisationObject } from "@crm/core/client";
import { Avatar, AvatarFallback, AvatarImage } from "@crm/ui/components/avatar";
import { Button } from "@crm/ui/components/button";
import { Kbd } from "@crm/ui/components/kbd";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Building2Icon, PlusIcon } from "lucide-react";
import { useCallback } from "react";
import { useAppCommands } from "#/components/app-commands";
import { ColumnPicker } from "#/components/data-table/column-picker";
import { DataTable, type ListPage, type ListPageRequest } from "#/components/data-table/data-table";
import { EmptyState } from "#/components/empty-state";
import { FilterBuilder } from "#/components/filter-builder/filter-builder";
import { BulkActions, ListActionsMenu } from "#/components/list/list-actions";
import {
  faviconUrl,
  ORGANISATION_COLUMNS,
  ORGANISATION_LIST_DEFAULTS,
  type OrganisationRow,
} from "#/components/organisations/config";
import { SavedViewsMenu } from "#/components/views/saved-views-menu";
import { parseViewSearch, useViewState, type ViewSearch } from "#/components/views/view-state";
import { initials } from "#/lib/format";
import { callOp } from "#/lib/operations";
import { useUserLabel } from "#/lib/users-adapter";

export const Route = createFileRoute("/_app/organisations/")({
  validateSearch: (search: Record<string, unknown>): ViewSearch =>
    parseViewSearch(organisationObject, search),
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

  const fetchPage = useCallback(
    (input: ListPageRequest): Promise<ListPage<OrganisationRow>> =>
      callOp("organisation.list", input),
    [],
  );

  return (
    <div className="mx-auto grid w-full grid-cols-1 max-w-7xl gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Organisations</h1>
        <SavedViewsMenu object="organisation" defaultLabel="All organisations" view={view} />
        <div className="flex-1" />
        <ListActionsMenu object="organisation" definition={organisationObject} view={view.state} />
        <Button onClick={() => create("organisation")} aria-keyshortcuts="c">
          <PlusIcon />
          New organisation
          <Kbd className="ml-1 hidden bg-primary-foreground/20 text-primary-foreground sm:inline-flex">
            C
          </Kbd>
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <FilterBuilder
          object={organisationObject}
          value={view.state.filter}
          onChange={view.setFilter}
        />
        <div className="flex-1" />
        <ColumnPicker
          object={organisationObject}
          available={ORGANISATION_COLUMNS}
          value={view.state.columns}
          onChange={view.setColumns}
        />
      </div>
      <DataTable<OrganisationRow>
        object={organisationObject}
        label="Organisations"
        queryKey={["op", "organisation.list", "table"]}
        fetchPage={fetchPage}
        columns={view.state.columns}
        availableColumns={ORGANISATION_COLUMNS}
        extraFields={["name", "primaryDomain", "parentId"]}
        sort={view.state.sort}
        onSortChange={view.setSort}
        filter={view.state.filter}
        onOpen={(row) => navigate({ to: "/organisations/$id", params: { id: row.id } })}
        renderCell={{
          name: (row) => (
            <Link
              to="/organisations/$id"
              params={{ id: row.id }}
              className="inline-flex items-center gap-2 font-medium hover:underline"
            >
              <Avatar className="size-6 rounded-md">
                {row.primaryDomain && (
                  <AvatarImage src={faviconUrl(row.primaryDomain) ?? undefined} alt="" />
                )}
                <AvatarFallback className="rounded-md text-[10px]">
                  {initials(row.name ?? "")}
                </AvatarFallback>
              </Avatar>
              {row.name}
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
        bulkActions={({ selected, clear }) => (
          <BulkActions object="organisation" selected={selected} onDone={clear} />
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
    </div>
  );
}
