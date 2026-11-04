// Record page layout B (stage 1 interview, docs/stages/assets/01-record-page-layout-b.html): a
// compact header (avatar, name, primary title/org, actions), underline tabs (Overview, Timeline,
// Tasks, History), a main column, and a right side panel of cards.
//
// Desktop (lg and up): the header and tabs stay fixed; the main column and the side panel scroll
// independently. Narrower: one scroll for the whole page. The header scrolls away and the tab bar
// sticks to the top, showing the record's name once the header is out of view (it collapses to
// name + tabs). The side panel shows first on Overview and is hidden on the other tabs.
import { Avatar, AvatarFallback, AvatarImage } from "@crm/ui/components/avatar";
import { Skeleton } from "@crm/ui/components/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@crm/ui/components/tabs";
import { cn } from "@crm/ui/lib/utils";
import { Link, type LinkProps } from "@tanstack/react-router";
import { ChevronLeftIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { initials } from "#/lib/format";
import { useScrollMemory } from "#/lib/scroll-memory";

export interface RecordTab {
  value: string;
  label: string;
  /** Badge text after the label, e.g. a count. */
  count?: number;
  content: ReactNode;
}

export interface RecordLayoutProps {
  /** The record's name. */
  title: string;
  /** Primary title/org line under the name. */
  subtitle?: ReactNode;
  /** Shown next to the name, e.g. the pending-changes badge. */
  badge?: ReactNode;
  avatarUrl?: string | null;
  /** Square avatar (organisations, extension records). */
  squareAvatar?: boolean;
  /** The list this record belongs to, linked above the name. */
  back?: { to: LinkProps["to"]; label: string; params?: LinkProps["params"] };
  /** Header actions (buttons, menus), right-aligned. */
  actions?: ReactNode;
  /** A banner above the tabs (e.g. "In Trash"). */
  banner?: ReactNode;
  tabs: RecordTab[];
  /** Selected tab (controlled, e.g. from the URL). */
  tab: string;
  onTabChange: (tab: string) => void;
  /** Right side panel cards, shown next to the Overview tab. */
  side: ReactNode;
}

const MAX = "mx-auto w-full max-w-7xl";

export function RecordLayout({
  title,
  subtitle,
  badge,
  avatarUrl,
  squareAvatar,
  back,
  actions,
  banner,
  tabs,
  tab,
  onTabChange,
  side,
}: RecordLayoutProps) {
  const overview = tab === tabs[0]?.value;
  const pageRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const sideRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  useScrollMemory(pageRef, "record");
  useScrollMemory(mainRef, `record-main:${tab}`);
  useScrollMemory(sideRef, "record-side");

  // On narrow screens the tab bar shows the name once the header has scrolled out of view.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    const heading = titleRef.current;
    const root = pageRef.current;
    if (!heading || !root || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => setCollapsed(entry ? !entry.isIntersecting : false),
      { root, threshold: 0 },
    );
    observer.observe(heading);
    return () => observer.disconnect();
  }, []);

  return (
    <Tabs
      ref={pageRef}
      value={tab}
      onValueChange={onTabChange}
      className="h-full min-h-0 gap-0 overflow-y-auto overscroll-y-contain lg:overflow-hidden"
      data-testid="record-page"
    >
      <header className="shrink-0 bg-background" data-testid="record-header">
        <div className={cn(MAX, "grid gap-2 px-4 pt-3 pb-3 sm:px-6")}>
          {back && (
            <Link
              to={back.to}
              params={back.params}
              className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              <ChevronLeftIcon className="size-4" aria-hidden />
              {back.label}
            </Link>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Avatar className={cn("size-10 text-sm", squareAvatar && "rounded-md")}>
              {avatarUrl && <AvatarImage src={avatarUrl} alt="" />}
              <AvatarFallback className={cn(squareAvatar && "rounded-md")}>
                {initials(title)}
              </AvatarFallback>
            </Avatar>
            <div className="grid min-w-0 flex-1 gap-0.5">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <h1
                  ref={titleRef}
                  className="min-w-0 truncate text-lg font-semibold tracking-tight outline-none sm:text-xl"
                  tabIndex={-1}
                  data-page-title
                >
                  {title}
                </h1>
                {badge}
              </div>
              {subtitle && <div className="truncate text-sm text-muted-foreground">{subtitle}</div>}
            </div>
            {actions && (
              <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">{actions}</div>
            )}
          </div>
          {banner}
        </div>
      </header>
      <div
        className="sticky top-0 z-10 shrink-0 border-b bg-background/95 backdrop-blur lg:static lg:bg-background"
        data-testid="record-tabs-bar"
        data-collapsed={collapsed || undefined}
      >
        <div className={cn(MAX, "px-4 sm:px-6")}>
          {collapsed && (
            <p
              className="truncate pt-2 text-sm font-semibold lg:hidden"
              data-testid="record-compact-title"
              aria-hidden
            >
              {title}
            </p>
          )}
          <TabsList variant="line" className="h-10 w-full justify-start gap-4 overflow-x-auto p-0">
            {tabs.map((t) => (
              <TabsTrigger key={t.value} value={t.value} className="flex-none px-0">
                {t.label}
                {t.count !== undefined && t.count > 0 && (
                  <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground">
                    {t.count}
                  </span>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
      </div>
      <div
        className={cn(
          MAX,
          "flex flex-col lg:grid lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_22rem]",
        )}
      >
        <div
          ref={mainRef}
          className="min-w-0 px-4 pt-4 pb-6 sm:px-6 lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain"
          data-testid="record-main"
        >
          {tabs.map((t) => (
            <TabsContent key={t.value} value={t.value} className="mt-0 grid gap-4">
              {t.content}
            </TabsContent>
          ))}
        </div>
        <aside
          ref={sideRef}
          aria-label="Record details"
          className={cn(
            "min-w-0 gap-4 px-4 pt-4 sm:px-6 lg:grid lg:min-h-0 lg:content-start lg:overflow-y-auto lg:overscroll-contain lg:border-l lg:pb-6 lg:pl-4",
            overview ? "order-first grid lg:order-none" : "hidden lg:grid",
          )}
          data-testid="record-side"
        >
          {side}
        </aside>
      </div>
    </Tabs>
  );
}

/** The record page while the record loads: the same frame, so nothing jumps when it arrives. */
export function RecordLayoutSkeleton() {
  return (
    <div className="h-full" aria-busy="true" data-testid="record-skeleton">
      <div className={cn(MAX, "grid gap-3 px-4 pt-3 pb-3 sm:px-6")}>
        <Skeleton className="h-4 w-16" />
        <div className="flex items-center gap-3">
          <Skeleton className="size-10 rounded-full" />
          <div className="grid gap-1.5">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-4 w-32" />
          </div>
        </div>
      </div>
      <div className="border-b">
        <div className={cn(MAX, "flex h-10 items-center gap-4 px-4 sm:px-6")}>
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-12" />
          <Skeleton className="h-4 w-14" />
        </div>
      </div>
      <div className={cn(MAX, "grid gap-4 p-4 sm:px-6 lg:grid-cols-[minmax(0,1fr)_22rem]")}>
        <Skeleton className="h-64" />
        <Skeleton className="hidden h-64 lg:block" />
      </div>
    </div>
  );
}
