// Record page layout B (stage 1 interview): a header (avatar, name, primary title/org, actions),
// tabs under it (Overview, Timeline, Tasks, History), a main column, and a right side panel of
// cards. Below the `lg` breakpoint it collapses to one column; the side panel shows first on
// Overview and is hidden on the other tabs, which are full width.
import { Avatar, AvatarFallback, AvatarImage } from "@crm/ui/components/avatar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@crm/ui/components/tabs";
import { cn } from "@crm/ui/lib/utils";
import type { ReactNode } from "react";
import { initials } from "#/lib/format";

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
  avatarUrl?: string | null;
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

export function RecordLayout({
  title,
  subtitle,
  avatarUrl,
  actions,
  banner,
  tabs,
  tab,
  onTabChange,
  side,
}: RecordLayoutProps) {
  const overview = tab === tabs[0]?.value;
  return (
    <div className="mx-auto grid max-w-7xl gap-4">
      <header className="flex flex-wrap items-start gap-3 sm:gap-4" data-testid="record-header">
        <Avatar className="size-12 text-base sm:size-14">
          {avatarUrl && <AvatarImage src={avatarUrl} alt="" />}
          <AvatarFallback>{initials(title)}</AvatarFallback>
        </Avatar>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <h1 className="truncate text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
          {subtitle && <div className="truncate text-sm text-muted-foreground">{subtitle}</div>}
        </div>
        {actions && <div className="flex w-full items-center gap-2 sm:w-auto">{actions}</div>}
      </header>
      {banner}
      <Tabs value={tab} onValueChange={onTabChange} className="gap-4">
        <TabsList className="w-full justify-start overflow-x-auto sm:w-fit">
          {tabs.map((t) => (
            <TabsTrigger key={t.value} value={t.value} className="flex-none">
              {t.label}
              {t.count !== undefined && t.count > 0 && (
                <span className="ml-1 rounded-full bg-muted px-1.5 text-xs text-muted-foreground">
                  {t.count}
                </span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
          <div className="min-w-0">
            {tabs.map((t) => (
              <TabsContent key={t.value} value={t.value} className="mt-0 grid gap-4">
                {t.content}
              </TabsContent>
            ))}
          </div>
          <aside
            aria-label="Record details"
            className={cn(
              "grid min-w-0 gap-4",
              overview ? "order-first lg:order-none" : "hidden lg:grid",
            )}
          >
            {side}
          </aside>
        </div>
      </Tabs>
    </div>
  );
}
