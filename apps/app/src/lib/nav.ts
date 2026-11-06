// The app's sections, shared by the sidebar and the command palette.
import {
  ActivityIcon,
  BellIcon,
  BotIcon,
  Building2Icon,
  CheckSquareIcon,
  CopyIcon,
  HomeIcon,
  InboxIcon,
  LayoutDashboardIcon,
  type LucideIcon,
  OctagonXIcon,
  PlugIcon,
  PlugZapIcon,
  PuzzleIcon,
  ScrollTextIcon,
  SettingsIcon,
  ShieldCheckIcon,
  SparklesIcon,
  Trash2Icon,
  UserCheckIcon,
  UserCogIcon,
  UserPlusIcon,
  UsersIcon,
  WorkflowIcon,
} from "lucide-react";

export interface NavItem {
  to:
    | "/"
    | "/dashboards"
    | "/assistant"
    | "/people"
    | "/organisations"
    | "/tasks"
    | "/automations"
    | "/notifications"
    | "/activity"
    | "/approvals"
    | "/suggested-contacts"
    | "/duplicates"
    | "/trash"
    | "/settings"
    | "/settings/approval-policy"
    | "/settings/users"
    | "/settings/audit"
    | "/settings/connected-apps"
    | "/settings/extensions"
    | "/settings/assignment-rules"
    | "/settings/automations"
    | "/settings/integrations"
    | "/settings/ai"
    | "/settings/duplicates";
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
    to: "/assistant",
    label: "Assistant",
    icon: BotIcon,
    keywords: ["ai", "ask", "chat", "help", "conversations"],
  },
  {
    to: "/automations",
    label: "Automations",
    icon: WorkflowIcon,
    keywords: ["workflows", "triggers", "runs", "rules"],
  },
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
  {
    to: "/duplicates",
    label: "Duplicates",
    icon: CopyIcon,
    keywords: ["merge", "dedupe", "same name", "possible duplicates", "clean up"],
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
  {
    to: "/settings/assignment-rules",
    label: "Assignment rules",
    icon: UserCheckIcon,
    keywords: ["owner", "round-robin", "territory", "fallback", "leads", "settings"],
  },
  {
    to: "/settings/automations",
    label: "Automation settings",
    icon: OctagonXIcon,
    keywords: ["kill switch", "timezone", "debounce", "schedule", "settings"],
  },
  {
    to: "/settings/ai",
    label: "AI settings",
    icon: SparklesIcon,
    keywords: ["models", "model roles", "providers", "api keys", "usage", "embeddings"],
    adminOnly: true,
  },
  {
    to: "/settings/duplicates",
    label: "Duplicate settings",
    icon: CopyIcon,
    keywords: ["merge", "dedupe", "scan", "phone", "settings"],
    adminOnly: true,
  },
];

/** Not in the sidebar (the header bell opens it), but in the command palette. */
export const NOTIFICATIONS_NAV: NavItem = {
  to: "/notifications",
  label: "Notifications",
  icon: BellIcon,
  keywords: ["inbox", "unread", "bell", "alerts"],
};
