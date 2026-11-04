// Signed-in layout: sidebar (a drawer on phones), header with search and the user menu, the
// page, and the app-wide command palette, shortcut sheet and create dialogs.
import { Button } from "@crm/ui/components/button";
import { Kbd } from "@crm/ui/components/kbd";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@crm/ui/components/sidebar";
import { createFileRoute, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { SearchIcon } from "lucide-react";
import {
  AppCommandsProvider,
  useAppCommands,
  useAppCommandsState,
} from "../components/app-commands.tsx";
import { AppSidebar } from "../components/app-sidebar.tsx";
import { CommandPalette } from "../components/command-palette.tsx";
import { CreatePersonDialog } from "../components/people/create-person-dialog.tsx";
import { ShortcutSheet } from "../components/shortcut-sheet.tsx";
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
          <main className="min-w-0 flex-1 px-4 py-4 sm:px-6 sm:py-6" id="main">
            <Outlet />
          </main>
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

/** Dialogs controlled by AppCommands, plus the global shortcuts that open them. */
function AppOverlays() {
  const { isAdmin } = Route.useRouteContext();
  const state = useAppCommandsState();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useHotkey("mod+k", () => state.setPalette(!state.palette), { global: true });
  useHotkey("?", () => state.setShortcuts(true));
  // `c` creates in context; on other screens it creates a person (the only create so far).
  useHotkey("c", () => state.create("person"), { enabled: pathname !== "/settings" });

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
    </>
  );
}
