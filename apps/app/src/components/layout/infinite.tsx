// Infinite scroll for lists that are not tables.
//
// - LoadMoreSentinel: put it after a short list (a record's timeline or history); it loads the
//   next page when it scrolls into view. One request at a time; after a failure it waits for
//   "Try again" instead of retrying in a loop.
// - VirtualFeed: a virtualised, variable-height list (the Activity feed, Trash, the audit log)
//   inside PageLayout's scrolling body. Rows are measured as they render (and re-measured when
//   they grow, e.g. an expanded audit entry); the next page loads when the rendered range nears
//   the end.
import { Button } from "@crm/ui/components/button";
import { Skeleton } from "@crm/ui/components/skeleton";
import { cn } from "@crm/ui/lib/utils";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { errorMessage } from "#/lib/query";
import { useScrollElement } from "./page-layout.tsx";

export interface InfiniteSource {
  hasNextPage: boolean;
  isFetching: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError?: boolean;
  error?: unknown;
  fetchNextPage: () => unknown;
}

export function LoadMoreSentinel({
  source,
  label = "more",
}: {
  source: InfiniteSource;
  /** What is loading, for screen readers: "Loading more activity…". */
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const { hasNextPage, isFetching, isFetchNextPageError, fetchNextPage } = source;

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => setVisible(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: "400px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (visible && hasNextPage && !isFetching && !isFetchNextPageError) void fetchNextPage();
  }, [visible, hasNextPage, isFetching, isFetchNextPageError, fetchNextPage]);

  if (!hasNextPage) return null;
  return (
    <div ref={ref} className="grid gap-2" data-testid="load-more">
      {isFetchNextPageError ? (
        <div className="flex items-center gap-2 text-sm" role="alert">
          <span className="text-destructive">
            Could not load {label}: {errorMessage(source.error)}
          </span>
          <Button variant="outline" size="sm" onClick={() => void fetchNextPage()}>
            Try again
          </Button>
        </div>
      ) : (
        <>
          <Skeleton className="h-12" />
          <span className="sr-only" role="status">
            {source.isFetchingNextPage ? `Loading ${label}…` : ""}
          </span>
        </>
      )}
    </div>
  );
}

export interface VirtualFeedProps<T> {
  items: readonly T[];
  getKey: (item: T) => string;
  renderItem: (item: T, index: number) => ReactNode;
  /** A first guess at an item's height in px; items are measured once rendered. */
  estimateSize?: number;
  source: InfiniteSource;
  /** Accessible name of the list. */
  label: string;
  as?: "ol" | "ul";
  className?: string;
  itemClassName?: string;
  /** data-testid on each item. */
  itemTestId?: string;
  /** Load the next page when this close to the end. */
  prefetch?: number;
}

export function VirtualFeed<T>({
  items,
  getKey,
  renderItem,
  estimateSize = 72,
  source,
  label,
  as: List = "ol",
  className,
  itemClassName,
  itemTestId,
  prefetch = 10,
}: VirtualFeedProps<T>) {
  const scrollRef = useScrollElement();
  const listRef = useRef<HTMLOListElement & HTMLUListElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  // The page's scroller, held in state. React attaches a child's layout effects before its
  // parent's ref, so when this list mounts in the same commit as PageLayout (cached data, e.g. on
  // Back) scrollRef.current is still null on first render. Picking it up in an effect re-renders
  // once it exists; otherwise the virtualizer measures a 0px viewport and renders no rows.
  const [scroller, setScroller] = useState<HTMLElement | null>(() => scrollRef?.current ?? null);
  useEffect(() => {
    const element = scrollRef?.current ?? null;
    if (element !== scroller) setScroller(element);
  });

  // Where the list starts inside the scroller (content above it: filters, a description).
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!scroller || !list) return;
    const measure = () =>
      setScrollMargin(
        list.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop,
      );
    measure();
    const observer = new ResizeObserver(measure);
    const content = scroller.firstElementChild;
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [scroller]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller,
    estimateSize: () => estimateSize,
    overscan: 6,
    scrollMargin,
    getItemKey: (index) => {
      const item = items[index];
      return item === undefined ? index : getKey(item);
    },
  });
  const virtualItems = virtualizer.getVirtualItems();
  const lastIndex = virtualItems.at(-1)?.index ?? -1;
  const { hasNextPage, isFetching, isFetchNextPageError, fetchNextPage } = source;

  useEffect(() => {
    if (lastIndex < 0 || !hasNextPage || isFetching || isFetchNextPageError) return;
    if (lastIndex >= items.length - prefetch) void fetchNextPage();
  }, [
    lastIndex,
    items.length,
    prefetch,
    hasNextPage,
    isFetching,
    isFetchNextPageError,
    fetchNextPage,
  ]);

  return (
    <div className="grid gap-3">
      <List
        ref={listRef}
        aria-label={label}
        className={cn("relative", className)}
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualItems.map((virtual) => {
          const item = items[virtual.index];
          if (item === undefined) return null;
          return (
            <li
              key={virtual.key}
              ref={virtualizer.measureElement}
              data-index={virtual.index}
              data-testid={itemTestId}
              aria-setsize={hasNextPage ? -1 : items.length}
              aria-posinset={virtual.index + 1}
              className={cn("absolute inset-x-0 top-0", itemClassName)}
              style={{ transform: `translateY(${virtual.start - scrollMargin}px)` }}
            >
              {renderItem(item, virtual.index)}
            </li>
          );
        })}
      </List>
      {hasNextPage && (
        <div className="grid gap-2" data-testid="load-more">
          {isFetchNextPageError ? (
            <div className="flex items-center gap-2 text-sm" role="alert">
              <span className="text-destructive">
                Could not load more: {errorMessage(source.error)}
              </span>
              <Button variant="outline" size="sm" onClick={() => void fetchNextPage()}>
                Try again
              </Button>
            </div>
          ) : (
            <Skeleton className="h-14" />
          )}
        </div>
      )}
    </div>
  );
}
