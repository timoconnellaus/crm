// Cmd-K command palette: global search (via the SearchAdapter), create actions, navigation and
// preferences. Commands filter locally; search hits come from the adapter as you type.
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@crm/ui/components/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@crm/ui/components/dialog";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Building2Icon,
  KeyboardIcon,
  type LucideIcon,
  MonitorIcon,
  MoonIcon,
  SunIcon,
  UploadIcon,
  UserIcon,
  UserPlusIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { MAIN_NAV, type NavItem, SETTINGS_NAV } from "#/lib/nav";
import { type SearchAdapter, searchAdapter } from "#/lib/search-adapter";
import type { CreateKind } from "./app-commands.tsx";
import { type Theme, useTheme } from "./theme.tsx";

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (kind: CreateKind) => void;
  onShowShortcuts: () => void;
  isAdmin: boolean;
  /** Search backend (default: the app's adapter). */
  search?: SearchAdapter;
}

interface PaletteCommand {
  id: string;
  label: string;
  icon: LucideIcon;
  keywords?: string[];
  shortcut?: string;
  run: () => void;
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

function matches(command: PaletteCommand, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [command.label, ...(command.keywords ?? [])].some((text) =>
    text.toLowerCase().includes(q),
  );
}

export function CommandPalette({
  open,
  onOpenChange,
  onCreate,
  onShowShortcuts,
  isAdmin,
  search = searchAdapter,
}: CommandPaletteProps) {
  const navigate = useNavigate();
  const { setTheme } = useTheme();
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query.trim(), 200);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const hits = useQuery({
    queryKey: ["search", debounced],
    queryFn: () => search.search(debounced, { limit: 8 }),
    enabled: open && debounced.length > 0,
    staleTime: 10_000,
  });

  const close = (then: () => void) => () => {
    onOpenChange(false);
    then();
  };
  const go = (item: NavItem): PaletteCommand => ({
    id: `nav:${item.to}`,
    label: item.to === "/" ? "Go to Home" : `Go to ${item.label}`,
    icon: item.icon,
    keywords: [item.label, ...(item.keywords ?? [])],
    run: close(() => navigate({ to: item.to })),
  });

  const create: PaletteCommand[] = [
    {
      id: "create:person",
      label: "New person",
      icon: UserPlusIcon,
      keywords: ["create", "add", "contact"],
      shortcut: "C",
      run: () => onCreate("person"),
    },
    {
      id: "create:organisation",
      label: "New organisation",
      icon: Building2Icon,
      keywords: ["create", "add", "company"],
      run: () => onCreate("organisation"),
    },
    {
      id: "import:csv",
      label: "Import CSV",
      icon: UploadIcon,
      keywords: ["import", "upload", "spreadsheet"],
      run: close(() => navigate({ to: "/import" })),
    },
  ];
  const nav = [...MAIN_NAV, ...SETTINGS_NAV.filter((item) => isAdmin || !item.adminOnly)].map(go);
  const themeCommand = (theme: Theme, label: string, icon: LucideIcon): PaletteCommand => ({
    id: `theme:${theme}`,
    label,
    icon,
    keywords: ["theme", "appearance", "dark", "light"],
    run: close(() => setTheme(theme)),
  });
  const prefs: PaletteCommand[] = [
    themeCommand("light", "Light theme", SunIcon),
    themeCommand("dark", "Dark theme", MoonIcon),
    themeCommand("system", "System theme", MonitorIcon),
    {
      id: "shortcuts",
      label: "Keyboard shortcuts",
      icon: KeyboardIcon,
      keywords: ["help", "keys", "hotkeys"],
      shortcut: "?",
      run: close(onShowShortcuts),
    },
  ];

  const groups: [string, PaletteCommand[]][] = [
    ["Create", create.filter((c) => matches(c, query))],
    ["Navigate", nav.filter((c) => matches(c, query))],
    ["Preferences", prefs.filter((c) => matches(c, query))],
  ];
  const searchHits = debounced ? (hits.data ?? []) : [];
  const nothing =
    groups.every(([, list]) => list.length === 0) && searchHits.length === 0 && !hits.isFetching;

  const sections: ReactNode[] = [];
  if (searchHits.length > 0) {
    sections.push(
      <CommandGroup key="search" heading="Search results">
        {searchHits.map((hit) => (
          <CommandItem
            key={`${hit.object}:${hit.id}`}
            value={`${hit.object}:${hit.id}`}
            onSelect={close(() => navigate({ href: hit.href }))}
          >
            <UserIcon />
            <span className="truncate">{hit.title}</span>
            {hit.subtitle && (
              <span className="ml-auto truncate text-xs text-muted-foreground">{hit.subtitle}</span>
            )}
          </CommandItem>
        ))}
      </CommandGroup>,
    );
  }
  for (const [heading, list] of groups) {
    if (!list.length) continue;
    if (sections.length) sections.push(<CommandSeparator key={`sep:${heading}`} />);
    sections.push(
      <CommandGroup key={heading} heading={heading}>
        {list.map((command) => (
          <CommandItem key={command.id} value={command.id} onSelect={command.run}>
            <command.icon />
            {command.label}
            {command.shortcut && <CommandShortcut>{command.shortcut}</CommandShortcut>}
          </CommandItem>
        ))}
      </CommandGroup>,
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="top-[20%] translate-y-0 overflow-hidden p-0 sm:max-w-lg"
        showCloseButton={false}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Command palette</DialogTitle>
          <DialogDescription>Search, or run a command</DialogDescription>
        </DialogHeader>
        <Command
          shouldFilter={false}
          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-2.5"
        >
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search people, or type a command…"
            aria-label="Search or run a command"
          />
          <CommandList className="max-h-[min(60svh,24rem)]">
            {nothing && <CommandEmpty>No results.</CommandEmpty>}
            {hits.isFetching && searchHits.length === 0 && (
              <div className="px-4 py-3 text-sm text-muted-foreground">Searching…</div>
            )}
            {sections}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
