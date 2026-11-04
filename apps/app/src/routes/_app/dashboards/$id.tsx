// One dashboard: /dashboards/<id>, with its filter values in the URL.
import { Skeleton } from "@crm/ui/components/skeleton";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { DashboardPage, parseFilterValues } from "#/components/dashboards/dashboard-page";
import type { FilterValues } from "#/components/dashboards/dashboard-view";
import { ErrorState } from "#/components/empty-state";
import { PageLayout } from "#/components/layout/page-layout";
import { useOp } from "#/lib/query";

export const Route = createFileRoute("/_app/dashboards/$id")({
  validateSearch: (search: Record<string, unknown>): { filters?: FilterValues } => {
    const filters = parseFilterValues(search.filters);
    return filters && Object.keys(filters).length ? { filters } : {};
  },
  component: DashboardRoute,
});

function DashboardRoute() {
  const { id } = Route.useParams();
  const { filters = {} } = Route.useSearch();
  const { isAdmin } = Route.useRouteContext();
  const navigate = useNavigate({ from: "/dashboards/$id" });
  const dashboard = useOp("dashboard.get", { id });
  if (dashboard.isPending) {
    return (
      <PageLayout title={<Skeleton className="h-7 w-40" />}>
        <Skeleton className="h-64" />
      </PageLayout>
    );
  }
  if (dashboard.isError) {
    return (
      <PageLayout title="Dashboard" back={{ to: "/dashboards", label: "Dashboards" }}>
        <ErrorState title="Could not open this dashboard" error={dashboard.error} />
      </PageLayout>
    );
  }
  return (
    <DashboardPage
      key={id}
      dashboard={dashboard.data}
      values={filters}
      onValuesChange={(next) => navigate({ search: { filters: next }, replace: true })}
      isAdmin={isAdmin}
    />
  );
}
