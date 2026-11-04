// Generic list page for an extension object (`/x/<extension>.<object>`): the same DataTable,
// FilterBuilder, ColumnPicker and saved views as core lists, driven by the field registry
// (schema.objects) and fed by record.list.
import type { ObjectDefinition } from "@crm/core/client";
import { Button } from "@crm/ui/components/button";
import { Skeleton } from "@crm/ui/components/skeleton";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { BoxIcon, PlusIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { ColumnPicker } from "#/components/data-table/column-picker";
import { DataTable, type ListPage, type ListPageRequest } from "#/components/data-table/data-table";
import { EmptyState } from "#/components/empty-state";
import { CreateRecordDialog } from "#/components/fields/create-record-dialog";
import { FieldDisplay } from "#/components/fields/field-widgets";
import { FilterBuilder } from "#/components/filter-builder/filter-builder";
import { SavedViewsMenu } from "#/components/views/saved-views-menu";
import {
  parseViewSearchLoose,
  useViewState,
  type ViewDefaults,
  type ViewSearch,
} from "#/components/views/view-state";
import { callOp } from "#/lib/operations";
import { type ObjectInfo, toObjectDefinition, useObjectInfo } from "#/lib/schema";

export const Route = createFileRoute("/_app/x/$object/")({
  validateSearch: (search: Record<string, unknown>): ViewSearch => parseViewSearchLoose(search),
  component: ExtensionListPage,
});

type Row = Record<string, unknown> & { id: string };

function ExtensionListPage() {
  const { object: name } = Route.useParams();
  const { object, isPending } = useObjectInfo(name);
  if (isPending) return <Skeleton className="mx-auto h-64 w-full max-w-7xl" />;
  if (!object) {
    return (
      <EmptyState
        icon={BoxIcon}
        title="No such object"
        description={`${name} is not an object in this CRM. Its extension may have been removed.`}
      />
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
  const titleField = definition.titleField ?? "id";

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
  return (
    <div className="mx-auto grid w-full max-w-7xl grid-cols-1 gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{plural}</h1>
        <SavedViewsMenu
          object={info.name}
          defaultLabel={`All ${plural.toLowerCase()}`}
          view={view}
        />
        <div className="flex-1" />
        <Button onClick={() => setCreating(true)}>
          <PlusIcon />
          New {info.label.toLowerCase()}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <FilterBuilder object={definition} value={view.state.filter} onChange={view.setFilter} />
        <div className="flex-1" />
        <ColumnPicker
          object={definition}
          available={available}
          value={view.state.columns}
          onChange={view.setColumns}
          required={[titleField]}
        />
      </div>
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
      <CreateRecordDialog
        object={info}
        open={creating}
        onOpenChange={setCreating}
        onCreated={(id) => {
          setCreating(false);
          navigate({ to: "/x/$object/$id", params: { object: info.name, id } });
        }}
      />
    </div>
  );
}
