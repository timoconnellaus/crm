// Main navigation. On phone widths the shadcn Sidebar renders as a drawer (Sheet); following a
// link closes it.
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@crm/ui/components/sidebar";
import { Link } from "@tanstack/react-router";
import {
  ActivitySquareIcon,
  BoxIcon,
  BriefcaseIcon,
  FolderKanbanIcon,
  HandshakeIcon,
  type LucideIcon,
} from "lucide-react";
import { MAIN_NAV, type NavItem, SETTINGS_NAV } from "#/lib/nav";
import { useExtensionObjects } from "#/lib/schema";

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

const OBJECT_ICONS: Record<string, LucideIcon> = {
  "folder-kanban": FolderKanbanIcon,
  briefcase: BriefcaseIcon,
  handshake: HandshakeIcon,
};

/** Extension objects (from the field registry), each with a generic list page. */
function ExtensionObjectsNav() {
  const { setOpenMobile } = useSidebar();
  const objects = useExtensionObjects();
  if (!objects.length) return null;
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Extensions</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {objects.map((object) => {
            const Icon = (object.icon && OBJECT_ICONS[object.icon]) || BoxIcon;
            const label = object.plural ?? object.label;
            return (
              <SidebarMenuItem key={object.name}>
                <SidebarMenuButton asChild tooltip={label}>
                  <Link
                    to="/x/$object"
                    params={{ object: object.name }}
                    activeProps={{ "data-active": true, "aria-current": "page" }}
                    onClick={() => setOpenMobile(false)}
                  >
                    <Icon />
                    <span>{label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
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
        <ExtensionObjectsNav />
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
