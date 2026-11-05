// Settings → Plan (admins, ADR 0211): the hosted plan's limits and current usage, read-only.
// Plans change only through billing on the hosted service; a self-hosted install has no limits.

import { Badge } from "@relationship-os/ui/components/badge";
import { Button } from "@relationship-os/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@relationship-os/ui/components/card";
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import { createFileRoute } from "@tanstack/react-router";
import { ExternalLinkIcon, LockIcon } from "lucide-react";
import { EmptyState } from "#/components/empty-state";
import { PageLayout } from "#/components/layout/page-layout";
import { formatDateTime } from "#/lib/format";
import { errorMessage, useOp } from "#/lib/query";

export const Route = createFileRoute("/_app/settings/plan")({ component: PlanPage });

const PLAN_NAMES: Record<string, string> = {
  free: "Free",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
};

function PlanPage() {
  const { isAdmin } = Route.useRouteContext();
  return (
    <PageLayout
      title="Plan"
      width="md"
      back={{ to: "/settings", label: "Settings" }}
      description="Your plan's limits and how much of them you use."
    >
      {isAdmin ? (
        <PlanCard />
      ) : (
        <p
          className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm"
          role="note"
        >
          <LockIcon className="size-4" aria-hidden />
          Only admins can see the plan.
        </p>
      )}
    </PageLayout>
  );
}

function Usage({ label, used, max }: { label: string; used: number; max: number | null }) {
  const percent = max ? Math.min(100, (used / max) * 100) : 0;
  return (
    <div className="grid gap-1.5" data-testid={`plan-usage-${label.toLowerCase()}`}>
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">
          {used.toLocaleString()} {max === null ? "(unlimited)" : `of ${max.toLocaleString()}`}
        </span>
      </div>
      {max !== null && (
        <div
          className="h-2 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label={`${label} used`}
          aria-valuemin={0}
          aria-valuemax={max}
          aria-valuenow={used}
        >
          <div
            className={percent >= 100 ? "h-full bg-destructive" : "h-full bg-primary"}
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
    </div>
  );
}

function PlanCard() {
  const plan = useOp("plan.get", {});
  if (plan.isPending) return <Skeleton className="h-40" />;
  if (plan.isError) {
    return <EmptyState title="Could not load the plan" description={errorMessage(plan.error)} />;
  }
  const { entitlements, usage, billingUrl } = plan.data;
  if (!entitlements) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Self-hosted</CardTitle>
          <CardDescription>
            This deployment is not on a hosted plan, so there are no limits on users, records or AI.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Usage label="Users" used={usage.users} max={null} />
          <Usage label="Records" used={usage.records} max={null} />
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="grid gap-1">
          <CardTitle className="flex items-center gap-2">
            {PLAN_NAMES[entitlements.plan] ?? entitlements.plan} plan
          </CardTitle>
          <CardDescription>
            Updated {formatDateTime(entitlements.updatedAt)}. Records are people plus organisations;
            support users never count as users.
          </CardDescription>
        </div>
        {billingUrl && (
          <Button asChild size="sm">
            <a href={billingUrl} target="_blank" rel="noreferrer">
              Upgrade or manage billing
              <ExternalLinkIcon />
            </a>
          </Button>
        )}
      </CardHeader>
      <CardContent className="grid gap-4">
        <Usage label="Users" used={usage.users} max={entitlements.maxUsers} />
        <Usage label="Records" used={usage.records} max={entitlements.maxRecords} />
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">Built-in AI</span>
          {entitlements.platformAi ? (
            <Badge>Included</Badge>
          ) : (
            <Badge variant="secondary">
              Allowance used up — your own provider key and MCP still work
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
