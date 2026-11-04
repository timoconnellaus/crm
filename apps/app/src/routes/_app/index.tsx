// Home: the user's Home dashboard (dashboard.home), the shipped Overview until they choose
// another. Filter values live in the URL (`?filters=`), so a filtered Home is shareable.
import { Skeleton } from "@crm/ui/components/skeleton";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { DashboardPage, parseFilterValues } from "#/components/dashboards/dashboard-page";
import type { FilterValues } from "#/components/dashboards/dashboard-view";
import { ErrorState } from "#/components/empty-state";
import { PageLayout } from "#/components/layout/page-layout";
import { useOp } from "#/lib/query";

export const Route = createFileRoute("/_app/")({
  validateSearch: (search: Record<string, unknown>): { filters?: FilterValues } => {
    const filters = parseFilterValues(search.filters);
    return filters && Object.keys(filters).length ? { filters } : {};
  },
  component: Home,
});

function Home() {
  const { filters = {} } = Route.useSearch();
  const { isAdmin } = Route.useRouteContext();
  const navigate = useNavigate({ from: "/" });
  const home = useOp("dashboard.home", {});
  if (home.isPending) {
    return (
      <PageLayout title={<Skeleton className="h-7 w-40" />}>
        <div className="grid gap-4 md:grid-cols-4">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      </PageLayout>
    );
  }
  if (home.isError) {
    return (
      <PageLayout title="Home">
        <ErrorState
          title="Could not load your Home dashboard"
          error={home.error}
          onRetry={() => void home.refetch()}
        />
      </PageLayout>
    );
  }
  return (
    <DashboardPage
      key={home.data.id}
      dashboard={home.data}
      values={filters}
      onValuesChange={(next) => navigate({ search: { filters: next }, replace: true })}
      isAdmin={isAdmin}
      home
    />
  );
}
