// Main navigation. On phone widths the shadcn Sidebar renders as a drawer (Sheet); following a
// link closes it.
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@crm/ui/components/sidebar";
import { Link } from "@tanstack/react-router";
import { ActivitySquareIcon } from "lucide-react";
import { MAIN_NAV, type NavItem, SETTINGS_NAV } from "#/lib/nav";

function NavLink({ item }: { item: NavItem }) {
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild tooltip={item.label}>
        <Link
          to={item.to}
          activeOptions={{ exact: item.to === "/" }}
          activeProps={{ "data-active": true, "aria-current": "page" }}
          onClick={() => setOpenMobile(false)}
        >
          <item.icon />
          <span>{item.label}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function AppSidebar() {
  const { setOpenMobile } = useSidebar();
  return (
    <Sidebar aria-label="Main navigation">
      <SidebarHeader>
        <div className="px-2 py-1.5 text-lg font-semibold tracking-tight">CRM</div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {MAIN_NAV.map((item) => (
                <NavLink key={item.to} item={item} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          {SETTINGS_NAV.filter((item) => !item.adminOnly).map((item) => (
            <NavLink key={item.to} item={item} />
          ))}
          <SidebarMenuItem>
            <SidebarMenuButton asChild>
              <Link to="/status" onClick={() => setOpenMobile(false)}>
                <ActivitySquareIcon />
                <span>System status</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
