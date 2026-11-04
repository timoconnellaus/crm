// Signed-in layout: sidebar (a drawer on phones), header with search and the user menu, the
// page, and the app-wide command palette, shortcut sheet and create dialogs.
import { Button } from "@crm/ui/components/button";
import { Kbd } from "@crm/ui/components/kbd";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@crm/ui/components/sidebar";
import { createFileRoute, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { SearchIcon } from "lucide-react";
import { useEffect } from "react";
import {
  AppCommandsProvider,
  type CreateKind,
  type CreateOptions,
  useAppCommands,
  useAppCommandsState,
} from "../components/app-commands.tsx";
import { AppSidebar } from "../components/app-sidebar.tsx";
import { CommandPalette } from "../components/command-palette.tsx";
import { CreatePersonDialog } from "../components/people/create-person-dialog.tsx";
import { ShortcutSheet } from "../components/shortcut-sheet.tsx";
import { CreateTaskDialog } from "../components/tasks/create-task-dialog.tsx";
import { UserMenu } from "../components/user-menu.tsx";
import { useHotkey } from "../lib/hotkeys.ts";
import { getSession } from "../server/session.public.ts";

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ location }) => {
    const { principal, user, signOutUrl } = await getSession();
    if (!principal || !user) {
      throw redirect({ to: "/sign-in", search: { redirect: location.href } });
    }
    return { principal, user, signOutUrl, isAdmin: user.role === "admin" };
  },
  component: AppLayout,
});

function AppLayout() {
  return (
    <AppCommandsProvider>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset className="min-w-0">
          <AppHeader />
          <div className="min-w-0 flex-1 px-4 py-4 sm:px-6 sm:py-6" id="main">
            <Outlet />
          </div>
        </SidebarInset>
      </SidebarProvider>
      <AppOverlays />
    </AppCommandsProvider>
  );
}

function AppHeader() {
  const { principal, signOutUrl } = Route.useRouteContext();
  const { openPalette } = useAppCommands();
  return (
    <header className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur">
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
      <UserMenu principal={principal} signOutUrl={signOutUrl} />
    </header>
  );
}

/**
 * What `c` creates on a screen: a task on Tasks, a task about the record on a record page, a
 * person on People and elsewhere. Null where the screen owns its own create (Organisations).
 */
function createKindFor(pathname: string): { kind: CreateKind; options?: CreateOptions } | null {
  const record = /^\/(people|organisations)\/((?:per|org)_[^/]+)\/?$/.exec(pathname);
  if (record?.[2]) {
    const object = record[1] === "people" ? "person" : "organisation";
    return { kind: "task", options: { link: { object, id: record[2] } } };
  }
  if (pathname.startsWith("/tasks")) return { kind: "task" };
  // The organisation list's create dialog lives with the organisation screens.
  if (pathname.startsWith("/organisations")) return null;
  return { kind: "person" };
}

/** Dialogs controlled by AppCommands, plus the global shortcuts that open them. */
function AppOverlays() {
  const { isAdmin } = Route.useRouteContext();
  const state = useAppCommandsState();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useHotkey("mod+k", () => state.setPalette(!state.palette), { global: true });
  useHotkey("?", () => state.setShortcuts(true));
  // `c` creates in context (see createKindFor).
  useHotkey("c", () => {
    const target = createKindFor(pathname);
    if (target) state.create(target.kind, target.options);
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
      <CreatePersonDialog
        open={state.creating === "person"}
        onOpenChange={(open) => state.setCreating(open ? "person" : null)}
      />
      <CreateTaskDialog
        open={state.creating === "task"}
        onOpenChange={(open) => state.setCreating(open ? "task" : null)}
        {...(state.createOptions.link ? { link: state.createOptions.link } : {})}
      />
    </>
  );
}
