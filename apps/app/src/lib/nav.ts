// The app's sections, shared by the sidebar and the command palette.
import {
  ActivityIcon,
  Building2Icon,
  CheckSquareIcon,
  HomeIcon,
  type LucideIcon,
  ScrollTextIcon,
  SettingsIcon,
  ShieldCheckIcon,
  Trash2Icon,
  UserCogIcon,
  UsersIcon,
} from "lucide-react";

export interface NavItem {
  to:
    | "/"
    | "/people"
    | "/organisations"
    | "/tasks"
    | "/activity"
    | "/trash"
    | "/settings"
    | "/settings/approval-policy"
    | "/settings/users"
    | "/settings/audit";
  label: string;
  icon: LucideIcon;
  /** Extra words the palette matches on. */
  keywords?: string[];
  adminOnly?: boolean;
}

export const MAIN_NAV: NavItem[] = [
  { to: "/", label: "Home", icon: HomeIcon },
  { to: "/people", label: "People", icon: UsersIcon, keywords: ["contacts", "persons"] },
  { to: "/organisations", label: "Organisations", icon: Building2Icon, keywords: ["companies"] },
  { to: "/tasks", label: "Tasks", icon: CheckSquareIcon, keywords: ["todo"] },
  { to: "/activity", label: "Activity", icon: ActivityIcon, keywords: ["timeline", "notes"] },
  { to: "/trash", label: "Trash", icon: Trash2Icon, keywords: ["deleted", "restore"] },
];

export const SETTINGS_NAV: NavItem[] = [
  { to: "/settings", label: "Settings", icon: SettingsIcon },
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
];
