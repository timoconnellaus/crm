// The app's sections, shared by the sidebar and the command palette.
import {
  ActivityIcon,
  Building2Icon,
  CheckSquareIcon,
  HomeIcon,
  InboxIcon,
  LayoutDashboardIcon,
  type LucideIcon,
  PlugIcon,
  PlugZapIcon,
  PuzzleIcon,
  ScrollTextIcon,
  SettingsIcon,
  ShieldCheckIcon,
  Trash2Icon,
  UserCogIcon,
  UserPlusIcon,
  UsersIcon,
} from "lucide-react";

export interface NavItem {
  to:
    | "/"
    | "/dashboards"
    | "/people"
    | "/organisations"
    | "/tasks"
    | "/activity"
    | "/approvals"
    | "/suggested-contacts"
    | "/trash"
    | "/settings"
    | "/settings/approval-policy"
    | "/settings/users"
    | "/settings/audit"
    | "/settings/connected-apps"
    | "/settings/extensions"
    | "/settings/integrations";
  label: string;
  icon: LucideIcon;
  /** Extra words the palette matches on. */
  keywords?: string[];
  adminOnly?: boolean;
}

export const MAIN_NAV: NavItem[] = [
  { to: "/", label: "Home", icon: HomeIcon },
  {
    to: "/dashboards",
    label: "Dashboards",
    icon: LayoutDashboardIcon,
    keywords: ["charts", "reports", "widgets", "overview"],
  },
  { to: "/people", label: "People", icon: UsersIcon, keywords: ["contacts", "persons"] },
  { to: "/organisations", label: "Organisations", icon: Building2Icon, keywords: ["companies"] },
  { to: "/tasks", label: "Tasks", icon: CheckSquareIcon, keywords: ["todo"] },
  {
    to: "/approvals",
    label: "Approvals",
    icon: InboxIcon,
    keywords: ["review", "pending", "change sets", "inbox", "approve"],
  },
  {
    to: "/suggested-contacts",
    label: "Suggested contacts",
    icon: UserPlusIcon,
    keywords: ["suggestions", "email", "senders", "job changes", "inbox", "add contacts"],
  },
  { to: "/activity", label: "Activity", icon: ActivityIcon, keywords: ["timeline", "notes"] },
  { to: "/trash", label: "Trash", icon: Trash2Icon, keywords: ["deleted", "restore"] },
];

export const SETTINGS_NAV: NavItem[] = [
  { to: "/settings", label: "Settings", icon: SettingsIcon },
  {
    to: "/settings/connected-apps",
    label: "Connected apps",
    icon: PlugIcon,
    keywords: ["mcp", "claude", "oauth", "revoke", "settings"],
  },
  {
    to: "/settings/integrations",
    label: "Integrations",
    icon: PlugZapIcon,
    keywords: [
      "connections",
      "gmail",
      "google",
      "outlook",
      "microsoft",
      "slack",
      "zoominfo",
      "sync",
      "mailbox",
      "calendar",
      "gatekeeper",
      "settings",
    ],
  },
  {
    to: "/settings/approval-policy",
    label: "Approval policy",
    icon: ShieldCheckIcon,
    keywords: ["preset", "gate", "settings"],
    adminOnly: true,
  },
  {
    to: "/settings/users",
    label: "Users and roles",
    icon: UserCogIcon,
    keywords: ["members", "permissions", "admin", "settings"],
    adminOnly: true,
  },
  {
    to: "/settings/audit",
    label: "Audit log",
    icon: ScrollTextIcon,
    keywords: ["history", "changes", "log", "settings"],
    adminOnly: true,
  },
  {
    to: "/settings/extensions",
    label: "Extensions",
    icon: PuzzleIcon,
    keywords: ["objects", "fields", "tools", "quarantine", "rollback", "settings"],
    adminOnly: true,
  },
];
