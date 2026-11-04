// Generic list page for an extension object (`/x/<extension>.<object>`): the same fixed header,
// live count, virtualised DataTable, FilterBuilder, ColumnPicker and saved views as core lists,
// driven by the field registry (schema.objects) and fed by record.list.
import type { ObjectDefinition } from "@crm/core/client";
import { Button } from "@crm/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@crm/ui/components/dropdown-menu";
import { Skeleton } from "@crm/ui/components/skeleton";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { BoxIcon, DownloadIcon, EllipsisIcon, PlusIcon, UploadIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { useManualAutomations } from "#/components/automations/hooks";
import { AutomationBulkActions } from "#/components/automations/record-automations";
import { ColumnPicker } from "#/components/data-table/column-picker";
import { DataTable, type ListPage, type ListPageRequest } from "#/components/data-table/data-table";
import { EmptyState } from "#/components/empty-state";
import { CreateRecordDialog } from "#/components/fields/create-record-dialog";
import { FieldDisplay } from "#/components/fields/field-widgets";
import { FilterBuilder } from "#/components/filter-builder/filter-builder";
import { RecordImportDialog } from "#/components/import/record-import-dialog";
import { PageCount, PageLayout } from "#/components/layout/page-layout";
import { exportListCsv } from "#/components/list/export-csv";
import { ObjectViewBody, scrollFor, ViewTypeSwitcher } from "#/components/views/object-views";
import { SavedViewsMenu } from "#/components/views/saved-views-menu";
import {
  parseViewSearchLoose,
  useViewState,
  type ViewDefaults,
  type ViewSearch,
} from "#/components/views/view-state";
import { useRecordCount } from "#/lib/count";
import { callOp } from "#/lib/operations";
import { errorMessage } from "#/lib/query";
import { type ObjectInfo, toObjectDefinition, useObjectInfo } from "#/lib/schema";

export const Route = createFileRoute("/_app/x/$object/")({
  validateSearch: (search: Record<string, unknown>): ViewSearch => parseViewSearchLoose(search),
  component: ExtensionListPage,
});

type Row = Record<string, unknown> & { id: string };

function ExtensionListPage() {
  const { object: name } = Route.useParams();
  const { object, isPending } = useObjectInfo(name);
  if (isPending) {
    return (
      <PageLayout title={<Skeleton className="h-7 w-40" />}>
        <Skeleton className="h-64 w-full" />
      </PageLayout>
    );
  }
  if (!object) {
    return (
      <PageLayout title="Not found">
        <EmptyState
          icon={BoxIcon}
          title="No such object"
          description={`${name} is not an object in this CRM. Its extension may have been removed.`}
        />
      </PageLayout>
    );
  }
  return <ObjectList key={object.name} info={object} />;
}

function ObjectList({ info }: { info: ObjectInfo }) {
  const definition: ObjectDefinition = useMemo(() => toObjectDefinition(info), [info]);
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/x/$object/" });
  const setSearch = useCallback(
    (update: (current: ViewSearch) => ViewSearch) => navigate({ search: update, replace: true }),
    [navigate],
  );
  const available = useMemo(
    () => [
      ...definition.fields.filter((f) => f.extension).map((f) => f.name),
      "createdAt",
      "updatedAt",
    ],
    [definition],
  );
  const defaults: ViewDefaults = useMemo(
    () => ({ sort: definition.defaultSort, columns: available.slice(0, 6) }),
    [definition, available],
  );
  const view = useViewState({ object: definition, defaults, search, setSearch });
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  // Selection (and bulk actions) only when the object has a bulk manual automation.
  const bulkAutomations = useManualAutomations(info.name, "bulk");
  const titleField = definition.titleField ?? "id";

  async function onExport() {
    setExporting(true);
    try {
      const { rowCount, truncated } = await exportListCsv({
        object: definition,
        filter: view.state.filter,
        sort: view.state.sort,
        columns: view.state.columns,
      });
      const noun = (rowCount === 1 ? info.label : (info.plural ?? info.label)).toLowerCase();
      if (truncated) toast.warning(`Exported the first ${rowCount} ${noun}`);
      else toast.success(`Exported ${rowCount} ${noun}`);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setExporting(false);
    }
  }

  const fetchPage = useCallback(
    async (input: ListPageRequest): Promise<ListPage<Row>> => {
      const fields = input.fields.filter((f) => !["createdAt", "updatedAt", "id"].includes(f));
      const page = await callOp("record.list", { ...input, fields, object: info.name });
      return {
        items: page.items.map((r) => ({
          ...r.values,
          id: r.id,
          title: r.title,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        })),
        nextCursor: page.nextCursor,
      };
    },
    [info.name],
  );

  const renderCell = useMemo(() => {
    const cells: Record<string, (row: Row) => React.ReactNode> = {};
    for (const field of info.fields) {
      if (!field.extension) continue;
      cells[field.name] = (row) => <FieldDisplay field={field} value={row[field.name]} />;
    }
    cells[titleField] = (row) => (
      <Link
        to="/x/$object/$id"
        params={{ object: info.name, id: row.id }}
        className="font-medium hover:underline"
      >
        {String(row[titleField] ?? row.title ?? "(untitled)")}
      </Link>
    );
    return cells;
  }, [info, titleField]);

  const plural = info.plural ?? info.label;
  const count = useRecordCount(info.name, view.state.filter);
  const type = view.state.type;
  return (
    <PageLayout
      title={plural}
      width="fluid"
      scroll={scrollFor(type)}
      count={
        <PageCount
          value={count.data?.count}
          capped={count.data?.capped}
          isPending={count.isPending}
          noun={plural.toLowerCase()}
        />
      }
      titleAddon={
        <SavedViewsMenu
          object={info.name}
          defaultLabel={`All ${plural.toLowerCase()}`}
          view={view}
        />
      }
      actions={
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label="List actions" disabled={exporting}>
                <EllipsisIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setImporting(true)}>
                <UploadIcon />
                Import CSV
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void onExport()}>
                <DownloadIcon />
                Export CSV
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button onClick={() => setCreating(true)}>
            <PlusIcon />
            <span className="max-sm:sr-only">New {info.label.toLowerCase()}</span>
          </Button>
        </>
      }
      toolbar={
        <>
          <FilterBuilder object={definition} value={view.state.filter} onChange={view.setFilter} />
          <div className="flex-1" />
          <ViewTypeSwitcher info={info} view={view} />
          {type === "table" && (
            <ColumnPicker
              object={definition}
              available={available}
              value={view.state.columns}
              onChange={view.setColumns}
              required={[titleField]}
            />
          )}
        </>
      }
    >
      {type !== "table" ? (
        <ObjectViewBody info={info} view={view} />
      ) : (
        <DataTable<Row>
          object={definition}
          label={plural}
          queryKey={["op", "record.list", info.name]}
          fetchPage={fetchPage}
          columns={view.state.columns}
          availableColumns={available}
          extraFields={[titleField]}
          sort={view.state.sort}
          onSortChange={view.setSort}
          filter={view.state.filter}
          total={count.data}
          {...(bulkAutomations.length
            ? {
                bulkActions: ({ ids, clear }: { ids: string[]; clear: () => void }) => (
                  <AutomationBulkActions object={info.name} ids={ids} onDone={clear} />
                ),
              }
            : {})}
          onOpen={(row) =>
            navigate({ to: "/x/$object/$id", params: { object: info.name, id: row.id } })
          }
          renderCell={renderCell}
          empty={
            <EmptyState
              icon={BoxIcon}
              title={`No ${plural.toLowerCase()} yet`}
              description={info.description ?? undefined}
              action={
                <Button onClick={() => setCreating(true)}>
                  <PlusIcon />
                  New {info.label.toLowerCase()}
                </Button>
              }
            />
          }
        />
      )}
      <RecordImportDialog object={info} open={importing} onOpenChange={setImporting} />
      <CreateRecordDialog
        object={info}
        open={creating}
        onOpenChange={setCreating}
        onCreated={(id) => {
          setCreating(false);
          navigate({ to: "/x/$object/$id", params: { object: info.name, id } });
        }}
      />
    </PageLayout>
  );
}
