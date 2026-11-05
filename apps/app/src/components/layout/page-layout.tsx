// The frame of every signed-in page: a fixed header region (back link, title, live count,
// actions, then optional tabs and toolbar rows) that never scrolls away, and a body that is the
// page's only scroll region. The app shell is viewport-high (h-dvh) and the window itself never
// scrolls, so there is exactly one vertical scroller per page and no nested-scroll trap on phones.
//
//   <PageLayout title="People" count={<PageCount value={6000} />} actions={…} toolbar={…}>
//     …scrolling content…
//   </PageLayout>
//
// `scroll="none"` hands the body's height to a child that scrolls itself (DataTable, the record
// page's two panels). `footer` pins a bar under the body (a dirty form's save bar).
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import { cn } from "@relationship-os/ui/lib/utils";
import { Link, type LinkProps } from "@tanstack/react-router";
import { ChevronLeftIcon } from "lucide-react";
import { createContext, type ReactNode, type RefObject, useContext, useRef } from "react";
import { useScrollMemory } from "#/lib/scroll-memory";

const WIDTHS = {
  sm: "max-w-2xl",
  md: "max-w-3xl",
  lg: "max-w-4xl",
  xl: "max-w-5xl",
  full: "max-w-7xl",
  /** Edge to edge, for tables. */
  fluid: "",
} as const;
export type PageWidth = keyof typeof WIDTHS;

/** The element a page's content scrolls in (for virtual lists inside a scrolling body). */
const ScrollElementContext = createContext<RefObject<HTMLElement | null> | null>(null);

export function useScrollElement(): RefObject<HTMLElement | null> | null {
  return useContext(ScrollElementContext);
}

export interface PageLayoutProps {
  title: ReactNode;
  /** A live total next to the title (see PageCount). */
  count?: ReactNode;
  /** A line under the title. */
  description?: ReactNode;
  /** Elements right after the title, e.g. the saved views menu. */
  titleAddon?: ReactNode;
  /** A back link above the title. */
  back?: { to: LinkProps["to"]; label: string; search?: LinkProps["search"] };
  /** Right-aligned header actions. */
  actions?: ReactNode;
  /** A header row under the title: tabs. */
  tabs?: ReactNode;
  /** The last header row: filters, column picker, quick filters. */
  toolbar?: ReactNode;
  /** Content max width (centred). */
  width?: PageWidth;
  /** "body" (default): the body scrolls. "none": a child fills the body and scrolls itself. */
  scroll?: "body" | "none";
  /** Pinned under the body, e.g. a save bar. */
  footer?: ReactNode;
  /** Scroll memory region name (positions are kept per history entry; see useScrollMemory). */
  scrollId?: string;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

export function PageLayout({
  title,
  count,
  description,
  titleAddon,
  back,
  actions,
  toolbar,
  tabs,
  width = "full",
  scroll = "body",
  footer,
  scrollId = "page",
  className,
  bodyClassName,
  children,
}: PageLayoutProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const max = WIDTHS[width];
  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)} data-testid="page">
      <header className="z-10 shrink-0 border-b bg-background" data-testid="page-header">
        <div className={cn("mx-auto grid w-full gap-2 px-4 pt-3 pb-3 sm:px-6", max)}>
          {back && (
            <Link
              to={back.to}
              search={back.search}
              className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              <ChevronLeftIcon className="size-4" aria-hidden />
              {back.label}
            </Link>
          )}
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2">
            <h1
              className="min-w-0 truncate text-xl font-semibold tracking-tight outline-none sm:text-2xl"
              tabIndex={-1}
              data-page-title
            >
              {title}
            </h1>
            {count}
            {titleAddon}
            {actions && (
              <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{actions}</div>
            )}
          </div>
          {description && <div className="text-sm text-muted-foreground">{description}</div>}
          {tabs}
          {toolbar && (
            <div className="flex min-w-0 flex-wrap items-center gap-2" data-testid="page-toolbar">
              {toolbar}
            </div>
          )}
        </div>
      </header>
      {scroll === "body" ? (
        <ScrollingBody ref={bodyRef} id={scrollId} className={bodyClassName} max={max}>
          {children}
        </ScrollingBody>
      ) : (
        <div className={cn("flex min-h-0 flex-1 flex-col", bodyClassName)} data-testid="page-body">
          {children}
        </div>
      )}
      {footer}
    </div>
  );
}

function ScrollingBody({
  ref,
  id,
  className,
  max,
  children,
}: {
  ref: RefObject<HTMLDivElement | null>;
  id: string;
  className?: string | undefined;
  max: string;
  children: ReactNode;
}) {
  useScrollMemory(ref, id);
  return (
    <ScrollElementContext value={ref}>
      <div
        ref={ref}
        className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain [scrollbar-gutter:stable]"
        data-testid="page-body"
      >
        <div
          className={cn(
            "mx-auto grid w-full grid-cols-1 gap-4 px-4 pt-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-6",
            max,
            className,
          )}
        >
          {children}
        </div>
      </div>
    </ScrollElementContext>
  );
}

/**
 * The live total next to a page title: "6,000", "10,000+" when capped, a fixed-width skeleton
 * while counting (so the header does not shift), and nothing on error.
 */
export function PageCount({
  value,
  capped,
  isPending,
  noun,
}: {
  value: number | undefined;
  capped?: boolean | undefined;
  isPending?: boolean;
  /** For screen readers: "6,000 people". */
  noun?: string;
}) {
  if (isPending && value === undefined) {
    return <Skeleton className="h-5 w-12 rounded-full" data-testid="page-count-pending" />;
  }
  if (value === undefined) return null;
  const text = `${value.toLocaleString()}${capped ? "+" : ""}`;
  return (
    <span
      className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground tabular-nums"
      data-testid="page-count"
    >
      {text}
      {noun && <span className="sr-only"> {noun}</span>}
    </span>
  );
}

/** A sticky bar for an edited form: what changed, and Save / Discard. */
export function SaveBar({
  dirty,
  children,
  message = "You have unsaved changes",
}: {
  dirty: boolean;
  children: ReactNode;
  message?: ReactNode;
}) {
  if (!dirty) return null;
  return (
    <section
      className="shrink-0 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
      aria-label="Unsaved changes"
      data-testid="save-bar"
    >
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-2 px-4 py-3 sm:px-6">
        <span className="text-sm text-muted-foreground">{message}</span>
        <div className="ml-auto flex items-center gap-2">{children}</div>
      </div>
    </section>
  );
}
