// Signed-in layout: sidebar, header with the user menu, and the page.
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@crm/ui/components/sidebar";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AppSidebar } from "../components/app-sidebar.tsx";
import { UserMenu } from "../components/user-menu.tsx";
import { getSession } from "../server/session.public.ts";

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ location }) => {
    const { principal, signOutUrl } = await getSession();
    if (!principal) throw redirect({ to: "/sign-in", search: { redirect: location.href } });
    return { principal, signOutUrl };
  },
  component: AppLayout,
});

function AppLayout() {
  const { principal, signOutUrl } = Route.useRouteContext();
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-14 items-center gap-2 border-b px-4">
          <SidebarTrigger />
          <div className="flex-1" />
          <UserMenu principal={principal} signOutUrl={signOutUrl} />
        </header>
        <main className="flex-1 p-6">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
