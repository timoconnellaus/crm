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
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@relationship-os/ui/components/sidebar";
import { Link } from "@tanstack/react-router";
import {
  ActivitySquareIcon,
  BoxIcon,
  BriefcaseIcon,
  FolderKanbanIcon,
  HandshakeIcon,
  type LucideIcon,
  TargetIcon,
} from "lucide-react";
import { MAIN_NAV, type NavItem, SETTINGS_NAV } from "#/lib/nav";
import { useExtensionObjects } from "#/lib/schema";
import { usePendingCount } from "./approvals/hooks.ts";
import { useThreadUnread } from "./assistant/thread-provider.tsx";
import { useDuplicateCount } from "./duplicates/hooks.ts";

function NavLink({
  item,
  badge,
  badgeLabel = "waiting for review",
  badgeTestId = "approvals-count",
}: {
  item: NavItem;
  badge?: number | undefined;
  badgeLabel?: string;
  badgeTestId?: string;
}) {
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
      {badge ? (
        <SidebarMenuBadge
          className="rounded-full bg-primary text-primary-foreground peer-hover/menu-button:text-primary-foreground peer-data-[active=true]/menu-button:text-primary-foreground"
          aria-label={`${badge} ${badgeLabel}`}
          data-testid={badgeTestId}
        >
          {badge > 99 ? "99+" : badge}
        </SidebarMenuBadge>
      ) : null}
    </SidebarMenuItem>
  );
}

const OBJECT_ICONS: Record<string, LucideIcon> = {
  "folder-kanban": FolderKanbanIcon,
  briefcase: BriefcaseIcon,
  handshake: HandshakeIcon,
  target: TargetIcon,
};

/** Extension objects (from the field registry), each with a generic list page. */
function ExtensionObjectsNav() {
  const { setOpenMobile } = useSidebar();
  const objects = useExtensionObjects().filter((o) => o.navigation === "main");
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
  const pendingCount = usePendingCount();
  const duplicateCount = useDuplicateCount();
  const unread = useThreadUnread().unread;
  return (
    <Sidebar
      aria-label="Main navigation"
      className="h-dvh pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
    >
      <SidebarHeader>
        <div className="px-2 py-1.5 text-lg font-semibold tracking-tight">Relationship OS</div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {MAIN_NAV.map((item) =>
                item.to === "/duplicates" ? (
                  <NavLink
                    key={item.to}
                    item={item}
                    badge={duplicateCount}
                    badgeLabel="possible duplicates to review"
                    badgeTestId="duplicates-count"
                  />
                ) : item.to === "/assistant" ? (
                  <NavLink
                    key={item.to}
                    item={item}
                    badge={unread}
                    badgeLabel="unread in your chat"
                    badgeTestId="assistant-unread-nav"
                  />
                ) : (
                  <NavLink
                    key={item.to}
                    item={item}
                    badge={item.to === "/approvals" ? pendingCount : undefined}
                  />
                ),
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <ExtensionObjectsNav />
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          {SETTINGS_NAV.filter((item) => item.to === "/settings").map((item) => (
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
