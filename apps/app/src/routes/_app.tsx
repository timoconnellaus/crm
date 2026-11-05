// Signed-in layout: a viewport-high (h-dvh) shell that never scrolls itself. A fixed sidebar (a
// drawer on phones), a header with search and the user menu, and the page, which brings its own
// fixed header and single scroll region (PageLayout). Plus the app-wide command palette, shortcut
// sheet and create dialogs.
import { Button } from "@relationship-os/ui/components/button";
import { Kbd } from "@relationship-os/ui/components/kbd";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@relationship-os/ui/components/sidebar";
import { createFileRoute, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { SearchIcon, SparklesIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import {
  AppCommandsProvider,
  type CreateKind,
  type CreateOptions,
  useAppCommands,
  useAppCommandsState,
} from "../components/app-commands.tsx";
import { AppSidebar } from "../components/app-sidebar.tsx";
import { AssistantPanel } from "../components/assistant/assistant-panel.tsx";
import { AssistantProvider, useAssistant } from "../components/assistant/assistant-provider.tsx";
import { CommandPalette } from "../components/command-palette.tsx";
import { NotificationBell } from "../components/notifications/notification-bell.tsx";
import { CreateOrganisationDialog } from "../components/organisations/create-organisation-dialog.tsx";
import { CreatePersonDialog } from "../components/people/create-person-dialog.tsx";
import { ShortcutSheet } from "../components/shortcut-sheet.tsx";
import { CreateTaskDialog } from "../components/tasks/create-task-dialog.tsx";
import { UserMenu } from "../components/user-menu.tsx";
import { formatDateTime } from "../lib/format.ts";
import { useHotkey } from "../lib/hotkeys.ts";
import { getSession } from "../server/session.public.ts";

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ location }) => {
    const { principal, user, signOutUrl, setupOpen, identityProvider, support } =
      await getSession();
    if (!principal || !user) {
      throw redirect({ to: "/sign-in", search: { redirect: location.href } });
    }
    // First visit after install: the admin finishes setting up first (skippable, ADR 0167).
    if (setupOpen && location.pathname !== "/setup" && !support) {
      throw redirect({ to: "/setup" });
    }
    return {
      principal,
      user,
      signOutUrl,
      identityProvider,
      support,
      isAdmin: user.role === "admin",
    };
  },
  component: AppLayout,
});

function AppLayout() {
  useFocusOnNavigate();
  return (
    <AppCommandsProvider>
      <AssistantProvider>
        <a
          href="#main"
          className="sr-only z-50 rounded-md bg-background px-3 py-2 text-sm shadow focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
        >
          Skip to content
        </a>
        <SidebarProvider className="h-dvh overflow-hidden">
          <AppSidebar />
          <SidebarInset className="min-h-0 min-w-0 overflow-hidden pr-[env(safe-area-inset-right)]">
            <SupportBanner />
            <AppHeader />
            <div
              className="min-h-0 min-w-0 flex-1 overflow-y-auto [view-transition-name:page]"
              id="main"
              tabIndex={-1}
            >
              <Outlet />
            </div>
          </SidebarInset>
        </SidebarProvider>
        <AppOverlays />
      </AssistantProvider>
    </AppCommandsProvider>
  );
}

/**
 * After a page change, moves focus to the new page's title when focus would otherwise be lost
 * (the clicked link unmounted, or nothing had focus), so keyboard and screen-reader users land
 * on the page they opened. Focus that is still somewhere sensible (a dialog, the palette) stays.
 */
function useFocusOnNavigate() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const previous = useRef(pathname);
  useEffect(() => {
    if (previous.current === pathname) return;
    previous.current = pathname;
    const frame = requestAnimationFrame(() => {
      const current = document.activeElement;
      if (current && current !== document.body && current.isConnected) return;
      document.querySelector<HTMLElement>("[data-page-title]")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [pathname]);
}

/** Opens the assistant panel (Cmd-J). */
function AssistantButton() {
  const assistant = useAssistant();
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => assistant.toggle()}
      aria-keyshortcuts="Meta+J Control+J"
      data-testid="open-assistant"
    >
      <SparklesIcon />
      <span className="hidden sm:inline">Ask AI</span>
      <Kbd className="hidden sm:inline-flex">⌘J</Kbd>
    </Button>
  );
}

/** Shown on every page while the signed-in user is a support user (ADR 0212). */
function SupportBanner() {
  const { support } = Route.useRouteContext();
  if (!support) return null;
  return (
    <div
      role="status"
      data-testid="support-banner"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 bg-amber-500 px-4 py-1.5 text-sm font-medium text-amber-950"
    >
      <span>
        Support session ({support.staffEmail}) — access expires at{" "}
        {formatDateTime(support.expiresAt)}
      </span>
      <a href="/support/exit" className="underline underline-offset-2">
        End session
      </a>
    </div>
  );
}

function AppHeader() {
  const { principal, signOutUrl } = Route.useRouteContext();
  const { openPalette } = useAppCommands();
  return (
    <header className="z-10 flex min-h-14 shrink-0 items-center gap-2 border-b bg-background px-4 pt-[env(safe-area-inset-top)]">
      <SidebarTrigger aria-label="Toggle navigation" />
      <Button
        variant="outline"
        className="h-9 flex-1 justify-start gap-2 px-3 text-muted-foreground sm:max-w-sm"
        onClick={openPalette}
        data-testid="open-palette"
        aria-keyshortcuts="Meta+K Control+K"
      >
        <SearchIcon />
        <span className="truncate">Search or jump to…</span>
        <Kbd className="ml-auto hidden sm:inline-flex">⌘K</Kbd>
      </Button>
      <div className="hidden flex-1 sm:block" />
      <AssistantButton />
      <NotificationBell />
      <UserMenu principal={principal} signOutUrl={signOutUrl} />
    </header>
  );
}

/**
 * What `c` creates on a screen: a task about the record on a record page, a task on Tasks, an
 * organisation on the Organisations list, and a person on People and elsewhere.
 */
function createKindFor(pathname: string): { kind: CreateKind; options?: CreateOptions } {
  const record = /^\/(people|organisations)\/((?:per|org)_[^/]+)\/?$/.exec(pathname);
  if (record?.[2]) {
    const object = record[1] === "people" ? "person" : "organisation";
    return { kind: "task", options: { link: { object, id: record[2] } } };
  }
  if (pathname.startsWith("/tasks")) return { kind: "task" };
  if (pathname.startsWith("/organisations")) return { kind: "organisation" };
  return { kind: "person" };
}

/** Dialogs controlled by AppCommands, plus the global shortcuts that open them. */
function AppOverlays() {
  const { isAdmin, user } = Route.useRouteContext();
  const state = useAppCommandsState();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useHotkey("mod+k", () => state.setPalette(!state.palette), { global: true });
  useHotkey("?", () => state.setShortcuts(true));
  // `c` creates in context (see createKindFor).
  useHotkey("c", () => {
    const target = createKindFor(pathname);
    state.create(target.kind, target.options);
  });
  // Marks the signed-in shell interactive; end-to-end tests wait for it before using shortcuts.
  useEffect(() => {
    document.documentElement.dataset.hydrated = "true";
  }, []);

  return (
    <>
      <CommandPalette
        open={state.palette}
        onOpenChange={state.setPalette}
        onCreate={state.create}
        onShowShortcuts={() => state.setShortcuts(true)}
        isAdmin={isAdmin}
      />
      <ShortcutSheet open={state.shortcuts} onOpenChange={state.setShortcuts} />
      <AssistantPanel canApprove={user.role !== "viewer"} />
      <CreatePersonDialog
        open={state.creating === "person"}
        onOpenChange={(open) => state.setCreating(open ? "person" : null)}
      />
      <CreateOrganisationDialog
        open={state.creating === "organisation"}
        onOpenChange={(open) => state.setCreating(open ? "organisation" : null)}
      />
      <CreateTaskDialog
        open={state.creating === "task"}
        onOpenChange={(open) => state.setCreating(open ? "task" : null)}
        {...(state.createOptions.link ? { link: state.createOptions.link } : {})}
      />
    </>
  );
}
