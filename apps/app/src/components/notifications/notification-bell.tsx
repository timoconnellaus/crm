// The notification bell in the app header (ADR 0029): the unread count (notification.unreadCount,
// polled every 60 s while the tab is visible, like the approvals badge) and a popover of recent
// notifications. Clicking one marks it read and opens its link; "Mark all read"; "View all" opens
// the inbox. Fits phone widths.
import { Button } from "@crm/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@crm/ui/components/popover";
import { Skeleton } from "@crm/ui/components/skeleton";
import { cn } from "@crm/ui/lib/utils";
import { Link, useRouter } from "@tanstack/react-router";
import { BellIcon, CheckCheckIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  type NotificationData,
  useMarkRead,
  useNotifications,
  useUnreadCount,
} from "#/components/automations/hooks";
import { compactRelative, notificationHref } from "#/components/automations/model";
import { errorMessage } from "#/lib/query";

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const unread = useUnreadCount().data?.unread ?? 0;
  const label = unread ? `Notifications, ${unread} unread` : "Notifications";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative shrink-0"
          aria-label={label}
          data-testid="notification-bell"
        >
          <BellIcon />
          {unread > 0 && (
            <span
              className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] leading-4 font-medium text-primary-foreground tabular-nums"
              data-testid="notification-count"
              aria-hidden
            >
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[min(24rem,calc(100vw-1rem))] p-0"
        data-testid="notification-popover"
      >
        {open && <RecentNotifications onNavigate={() => setOpen(false)} />}
      </PopoverContent>
    </Popover>
  );
}

function RecentNotifications({ onNavigate }: { onNavigate: () => void }) {
  const { query, items } = useNotifications(false, 10);
  const markRead = useMarkRead();
  const unread = query.data?.pages[0]?.unread ?? 0;

  async function markAll() {
    try {
      await markRead.mutateAsync({ all: true });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <div className="grid">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <p className="flex-1 text-sm font-medium">Notifications</p>
        <Button
          variant="ghost"
          size="sm"
          disabled={!unread || markRead.isPending}
          onClick={() => void markAll()}
        >
          <CheckCheckIcon />
          Mark all read
        </Button>
      </div>
      {query.isPending ? (
        <div className="grid gap-2 p-3">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : query.error ? (
        <p className="p-3 text-sm text-destructive">{errorMessage(query.error)}</p>
      ) : !items.length ? (
        <p className="p-6 text-center text-sm text-muted-foreground">You're all caught up.</p>
      ) : (
        <ul className="max-h-[min(24rem,60dvh)] overflow-y-auto" aria-label="Recent notifications">
          {items.map((item) => (
            <li key={item.id} className="border-b last:border-b-0">
              <NotificationEntry item={item} onNavigate={onNavigate} />
            </li>
          ))}
        </ul>
      )}
      <div className="border-t p-1">
        <Button asChild variant="ghost" size="sm" className="w-full">
          <Link to="/notifications" onClick={onNavigate}>
            View all
          </Link>
        </Button>
      </div>
    </div>
  );
}

/** One notification: a button that marks it read and opens its link. */
export function NotificationEntry({
  item,
  onNavigate,
}: {
  item: NotificationData;
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const markRead = useMarkRead();
  const href = notificationHref(item);
  const unread = !item.readAt;

  async function onClick() {
    if (unread) markRead.mutate({ ids: [item.id] });
    if (href) {
      onNavigate?.();
      await router.navigate({ href });
    }
  }

  return (
    <button
      type="button"
      onClick={() => void onClick()}
      className={cn(
        "flex w-full items-start gap-2.5 px-3 py-2.5 text-left text-sm hover:bg-muted/60",
        !href && !unread && "cursor-default",
      )}
      data-testid="notification-item"
      data-unread={unread || undefined}
    >
      <span
        className={cn(
          "mt-1.5 size-2 shrink-0 rounded-full",
          unread ? "bg-primary" : "bg-transparent",
        )}
        aria-hidden
      />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className={cn("break-words", unread && "font-medium")}>
          {unread && <span className="sr-only">Unread: </span>}
          {item.title}
        </span>
        {item.body && (
          <span className="line-clamp-2 text-xs text-muted-foreground">{item.body}</span>
        )}
      </span>
      <time className="shrink-0 text-xs text-muted-foreground" dateTime={item.createdAt}>
        {compactRelative(item.createdAt)}
      </time>
    </button>
  );
}
