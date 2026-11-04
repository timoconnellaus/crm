// Notifications inbox (ADR 0029): the signed-in user's notifications, newest first, in a
// virtualised list that loads more as you scroll. All or Unread; Mark all read. Each opens its
// record, approval or automation run and is marked read.
import { Button } from "@crm/ui/components/button";
import { Skeleton } from "@crm/ui/components/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@crm/ui/components/tabs";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { BellIcon, CheckCheckIcon } from "lucide-react";
import { toast } from "sonner";
import { useMarkRead, useNotifications } from "#/components/automations/hooks";
import { EmptyState, ErrorState } from "#/components/empty-state";
import { VirtualFeed } from "#/components/layout/infinite";
import { PageCount, PageLayout } from "#/components/layout/page-layout";
import { NotificationEntry } from "#/components/notifications/notification-bell";
import { errorMessage } from "#/lib/query";

export const Route = createFileRoute("/_app/notifications")({
  validateSearch: (search: Record<string, unknown>): { unread?: true } =>
    search.unread === true || search.unread === "true" || search.unread === 1
      ? { unread: true }
      : {},
  component: NotificationsPage,
});

function NotificationsPage() {
  const { unread: unreadOnly = false } = Route.useSearch();
  const navigate = useNavigate({ from: "/notifications" });
  const { query, items } = useNotifications(unreadOnly, 30);
  const markRead = useMarkRead();
  const unread = query.data?.pages[0]?.unread;

  async function markAll() {
    try {
      const { updated } = await markRead.mutateAsync({ all: true });
      toast.success(
        updated === 1 ? "Marked 1 notification read" : `Marked ${updated} notifications read`,
      );
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <PageLayout
      title="Notifications"
      width="md"
      count={<PageCount value={unread} isPending={query.isPending} noun="unread" />}
      actions={
        <Button
          variant="outline"
          size="sm"
          onClick={() => void markAll()}
          disabled={!unread || markRead.isPending}
        >
          <CheckCheckIcon />
          Mark all read
        </Button>
      }
      tabs={
        <Tabs
          value={unreadOnly ? "unread" : "all"}
          onValueChange={(next) =>
            navigate({ search: next === "unread" ? { unread: true } : {}, replace: true })
          }
        >
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="unread">Unread</TabsTrigger>
          </TabsList>
        </Tabs>
      }
    >
      {query.isPending ? (
        <div className="grid gap-2" aria-busy="true">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : query.isError && !items.length ? (
        <ErrorState
          title="Could not load notifications"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      ) : !items.length ? (
        <EmptyState
          icon={BellIcon}
          title={unreadOnly ? "No unread notifications" : "No notifications yet"}
          description="Automations, approvals and the system notify you here."
        />
      ) : (
        <VirtualFeed
          as="ul"
          label="Notifications"
          items={items}
          getKey={(item) => item.id}
          estimateSize={64}
          source={query}
          className="rounded-md border"
          itemClassName="border-b last:border-b-0"
          renderItem={(item) => <NotificationEntry item={item} />}
        />
      )}
    </PageLayout>
  );
}
