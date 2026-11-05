// Settings → Support access (admins, ADR 0212): requests from the hosted service's support team.
// Support never signs in as you: approving gives them their own support user with the requested
// role until the grant expires (at most 3 days), and everything they do is in the audit log.
// Approve, deny and revoke are support.grant.* operations (human admins only).

import type { CoreOutput } from "@relationship-os/core";
import { Badge } from "@relationship-os/ui/components/badge";
import { Button } from "@relationship-os/ui/components/button";
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import { createFileRoute } from "@tanstack/react-router";
import { LifeBuoyIcon, LockIcon } from "lucide-react";
import { toast } from "sonner";
import { EmptyState } from "#/components/empty-state";
import { PageLayout } from "#/components/layout/page-layout";
import { formatDateTime } from "#/lib/format";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

export const Route = createFileRoute("/_app/settings/support-access")({
  component: SupportAccessPage,
});

type Grant = CoreOutput<"support.grant.list">["items"][number];

function SupportAccessPage() {
  const { isAdmin, support } = Route.useRouteContext();
  return (
    <PageLayout
      title="Support access"
      width="lg"
      back={{ to: "/settings", label: "Settings" }}
      description="Requests from our support team to look at your workspace. Support never signs in as you: an approved request gets its own support user with the role shown, until it expires. Everything support does is in the audit log."
    >
      {isAdmin && !support ? (
        <GrantList />
      ) : (
        <p
          className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm"
          role="note"
        >
          <LockIcon className="size-4" aria-hidden />
          Only admins can manage support access.
        </p>
      )}
    </PageLayout>
  );
}

function GrantList() {
  const grants = useOp("support.grant.list", {});
  if (grants.isPending) return <Skeleton className="h-24" />;
  if (grants.isError) {
    return (
      <EmptyState title="Could not load support access" description={errorMessage(grants.error)} />
    );
  }
  if (!grants.data.items.length) {
    return (
      <EmptyState
        icon={LifeBuoyIcon}
        title="No support requests"
        description="When our support team asks to look at your workspace, the request appears here for you to approve or deny."
      />
    );
  }
  return (
    <ul className="grid divide-y rounded-md border" aria-label="Support access requests">
      {grants.data.items.map((grant) => (
        <GrantRow key={grant.id} grant={grant} />
      ))}
    </ul>
  );
}

function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return hours < 48
    ? `${Math.round(hours * 10) / 10} h`
    : `${Math.round((hours / 24) * 10) / 10} days`;
}

function statusLabel(grant: Grant): {
  label: string;
  variant: "default" | "secondary" | "outline";
} {
  if (grant.status === "approved") {
    return grant.active
      ? { label: "Active", variant: "default" }
      : { label: "Expired", variant: "secondary" };
  }
  if (grant.status === "requested") return { label: "Requested", variant: "outline" };
  return { label: grant.status === "denied" ? "Denied" : "Revoked", variant: "secondary" };
}

function GrantRow({ grant }: { grant: Grant }) {
  const options = { invalidates: ["support.grant."] };
  const approve = useOpMutation("support.grant.approve", options);
  const deny = useOpMutation("support.grant.deny", options);
  const revoke = useOpMutation("support.grant.revoke", options);
  const busy = approve.isPending || deny.isPending || revoke.isPending;
  const status = statusLabel(grant);

  async function run(
    mutation: typeof approve | typeof deny | typeof revoke,
    done: string,
  ): Promise<void> {
    try {
      await mutation.mutateAsync({ id: grant.id });
      toast.success(done);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <li
      className="flex flex-wrap items-start gap-3 px-3 py-3 text-sm"
      data-testid="support-grant"
      data-grant={grant.id}
    >
      <LifeBuoyIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{grant.staffEmail}</span>
          <Badge variant="outline" className="rounded-sm px-1.5 font-normal">
            {grant.role}
          </Badge>
          <Badge variant={status.variant}>{status.label}</Badge>
        </div>
        <p className="text-muted-foreground">{grant.reason}</p>
        <span className="text-xs text-muted-foreground">
          Asked for {duration(grant.requestedMinutes)} on{" "}
          <time dateTime={grant.requestedAt}>{formatDateTime(grant.requestedAt)}</time>
          {grant.expiresAt && (
            <>
              {" "}
              · {grant.active ? "expires" : "ended"}{" "}
              <time dateTime={grant.expiresAt}>{formatDateTime(grant.expiresAt)}</time>
            </>
          )}
        </span>
      </div>
      <div className="flex gap-2">
        {grant.status === "requested" && (
          <>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void run(approve, "Support access approved")}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void run(deny, "Support request denied")}
            >
              Deny
            </Button>
          </>
        )}
        {grant.status === "approved" && grant.active && (
          <Button
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() => void run(revoke, "Support access revoked")}
          >
            Revoke
          </Button>
        )}
      </div>
    </li>
  );
}
