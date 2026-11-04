// A dashboard page (Home at `/`, and `/dashboards/$id`): the fixed header (title, ownership,
// actions: edit, add widget, set as Home, copy, share, delete), the filter bar, and the grid.
// Widget edits save at once through dashboard.update, shown optimistically and rolled back on
// failure.
import type { WidgetSpec } from "@crm/core/client";
import { Button } from "@crm/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@crm/ui/components/dropdown-menu";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckIcon,
  CopyIcon,
  HomeIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Share2Icon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PageLayout } from "#/components/layout/page-layout";
import { callOp } from "#/lib/operations";
import { errorMessage, invalidateOps } from "#/lib/query";
import {
  DashboardFilters,
  DashboardGrid,
  type FilterValues,
  SharedBadge,
} from "./dashboard-view.tsx";
import { newWidget, WidgetEditor } from "./widget-editor.tsx";

export type DashboardData = Awaited<ReturnType<typeof callOp<"dashboard.get">>>;

export function DashboardPage({
  dashboard,
  values,
  onValuesChange,
  isAdmin,
  home,
}: {
  dashboard: DashboardData;
  values: FilterValues;
  onValuesChange: (values: FilterValues) => void;
  isAdmin: boolean;
  /** Rendered as Home (`/`). */
  home?: boolean;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [editor, setEditor] = useState<{ widget: WidgetSpec; isNew: boolean } | null>(null);
  const [local, setLocal] = useState<WidgetSpec[] | null>(null);
  const widgets = local ?? dashboard.widgets;

  async function saveWidgets(next: WidgetSpec[]) {
    const before = widgets;
    setLocal(next);
    try {
      await callOp("dashboard.update", { id: dashboard.id, widgets: next });
      await invalidateOps(client, "dashboard.");
      setLocal(null);
    } catch (error) {
      setLocal(before === dashboard.widgets ? null : before);
      toast.error(errorMessage(error));
    }
  }

  async function run<T>(action: () => Promise<T>, success: string) {
    try {
      const result = await action();
      await invalidateOps(client, "dashboard.");
      toast.success(success);
      return result;
    } catch (error) {
      toast.error(errorMessage(error));
      return undefined;
    }
  }

  return (
    <PageLayout
      title={dashboard.title}
      width="full"
      titleAddon={<SharedBadge shared={dashboard.shared} builtIn={dashboard.builtIn} />}
      description={dashboard.description ?? undefined}
      actions={
        <>
          {dashboard.canEdit && editing && (
            <Button
              variant="outline"
              onClick={() => setEditor({ widget: newWidget(), isNew: true })}
              data-testid="add-widget"
            >
              <PlusIcon />
              <span className="max-sm:sr-only">Add widget</span>
            </Button>
          )}
          {dashboard.canEdit && (
            <Button
              variant={editing ? "default" : "outline"}
              onClick={() => setEditing((e) => !e)}
              data-testid="edit-dashboard"
            >
              {editing ? <CheckIcon /> : <PencilIcon />}
              <span className="max-sm:sr-only">{editing ? "Done" : "Edit"}</span>
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                aria-label="Dashboard actions"
                data-testid="dashboard-actions"
              >
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {!dashboard.isHome && (
                <DropdownMenuItem
                  onSelect={() =>
                    void run(
                      () => callOp("dashboard.setHome", { id: dashboard.id }),
                      "Set as your Home",
                    )
                  }
                >
                  <HomeIcon />
                  Set as Home
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onSelect={async () => {
                  const copy = await run(
                    () =>
                      callOp("dashboard.create", {
                        title: `${dashboard.title} (copy)`,
                        copyFrom: dashboard.id,
                      }),
                    "Dashboard copied",
                  );
                  if (copy) navigate({ to: "/dashboards/$id", params: { id: copy.id } });
                }}
              >
                <CopyIcon />
                Make a copy
              </DropdownMenuItem>
              {dashboard.canEdit && dashboard.ownerId && (
                <DropdownMenuItem
                  onSelect={() =>
                    void run(
                      () =>
                        callOp("dashboard.update", { id: dashboard.id, shared: !dashboard.shared }),
                      dashboard.shared ? "Now personal" : "Shared with the org",
                    )
                  }
                >
                  <Share2Icon />
                  {dashboard.shared ? "Make personal" : "Share with the org"}
                </DropdownMenuItem>
              )}
              {dashboard.canEdit && (
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={async () => {
                    const done = await run(
                      () => callOp("dashboard.delete", { id: dashboard.id }),
                      "Dashboard deleted",
                    );
                    if (done) navigate({ to: "/dashboards" });
                  }}
                >
                  <Trash2Icon />
                  Delete
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
      toolbar={
        dashboard.filters.length ? (
          <DashboardFilters filters={dashboard.filters} values={values} onChange={onValuesChange} />
        ) : undefined
      }
      scrollId={home ? "home" : "dashboard"}
    >
      <div className="pb-6" data-testid="dashboard">
        <DashboardGrid
          dashboard={{ ...dashboard, widgets }}
          values={values}
          isAdmin={isAdmin}
          editing={editing && dashboard.canEdit}
          onWidgetsChange={(next) => void saveWidgets(next)}
          onEditWidget={(widget) => setEditor({ widget, isNew: false })}
        />
      </div>
      {editor && (
        <WidgetEditor
          open
          initial={editor.widget}
          filters={dashboard.filters}
          values={values}
          onCancel={() => setEditor(null)}
          onSave={(widget) => {
            setEditor(null);
            void saveWidgets(
              editor.isNew
                ? [...widgets, widget]
                : widgets.map((w) => (w.id === editor.widget.id ? widget : w)),
            );
          }}
        />
      )}
    </PageLayout>
  );
}

/** Parses the `filters` search param (JSON) into filter values. */
export function parseFilterValues(raw: unknown): FilterValues | undefined {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: FilterValues = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[a-z][a-z0-9_]{0,30}$/.test(key)) continue;
    if (v === null || typeof v === "string") out[key] = v;
    else if (v && typeof v === "object" && typeof (v as { from?: unknown }).from === "string") {
      const { from, to } = v as { from: string; to: string };
      if (/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(String(to)))
        out[key] = { from, to };
    }
  }
  return out;
}
