// The authoring API's HierarchyPicker: choosing one node of a hierarchy (the whole of it, an open
// container, or a leaf) with optional tabs, a breadcrumb, optional search and paging. As in a file
// dialog, a choice lasts while it is in view. See `HierarchyPickerProps` in
// @relationship-os/gatekeeper-configurator-ui for the behaviour this follows.
import type {
  ConfiguratorUIHierarchyAncestor as Ancestor,
  HierarchyPickerProps,
  ConfiguratorUIHierarchyItem as Item,
  ConfiguratorUIHierarchyPage as Page,
  ConfiguratorUIHierarchyTab as Tab,
} from "@relationship-os/gatekeeper-configurator-ui";
import {
  displayText,
  failureMessage,
  identifier,
  SEARCH_DEBOUNCE_MS,
} from "@relationship-os/gatekeeper-configurator-ui/options";
import { Badge } from "@relationship-os/ui/components/badge";
import { Button as UIButton } from "@relationship-os/ui/components/button";
import { Input } from "@relationship-os/ui/components/input";
import { RadioGroup, RadioGroupItem } from "@relationship-os/ui/components/radio-group";
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@relationship-os/ui/components/tabs";
import { cn } from "@relationship-os/ui/lib/utils";
import { ChevronRightIcon, FileIcon, FolderIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useField, useFrame } from "./form-context.ts";

type Location = {
  /** The open tab, when the picker has tabs. */
  tab: Tab | null;
  /** The containers opened below the tab (or the root), outermost first. */
  trail: Ancestor[];
  /** Whether where the trail starts within the tab is unknown. */
  gap: boolean;
};

type Listing =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "unavailable"; message: string }
  | {
      status: "ready";
      items: Item[];
      nextCursor: string | null;
      notice?: string;
      more: { status: "idle" } | { status: "loading" } | { status: "failed"; message: string };
    };

const text = (value: unknown) => displayText(value);

function cleanAncestor(raw: unknown): Ancestor | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const id = identifier(value.id);
  const title = text(value.title);
  if (!id || !title) return null;
  const choice =
    value.choice && typeof value.choice === "object"
      ? (value.choice as Record<string, unknown>)
      : undefined;
  return {
    id,
    title,
    selectable: value.selectable !== false,
    unselectableReason: text(value.unselectableReason),
    icon: typeof value.icon === "string" ? value.icon : undefined,
    choice: choice ? { title: text(choice.title), subtitle: text(choice.subtitle) } : undefined,
  };
}

/** A node as the gatekeeper sent it, with third-party text made safe, or null when unusable. */
export function cleanItem(raw: unknown): Item | null {
  const ancestor = cleanAncestor(raw);
  if (!ancestor) return null;
  const value = raw as Record<string, unknown>;
  return {
    ...ancestor,
    kind: value.kind === "container" ? "container" : "leaf",
    subtitle: text(value.subtitle),
    badge: text(value.badge),
    meta: text(value.meta),
    path: Array.isArray(value.path)
      ? value.path.map(cleanAncestor).filter((entry): entry is Ancestor => entry !== null)
      : undefined,
  };
}

function cleanPage(raw: unknown): Page {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    items: Array.isArray(value.items)
      ? value.items.map(cleanItem).filter((entry): entry is Item => entry !== null)
      : [],
    nextCursor: identifier(value.nextCursor) ?? null,
    notice: text(value.notice),
    unavailable: text(value.unavailable),
  };
}

/** Where `item` lives, as the picker opens it: a container opened, a leaf in its parent. */
export function locationOf(item: Item, tabs: readonly Tab[] | null, openTab: Tab | null): Location {
  const path = item.path ?? [];
  let tab = openTab;
  let rest = path;
  let gap = false;
  if (tabs) {
    const named = path[0] ? tabs.find((candidate) => candidate.id === path[0]?.id) : undefined;
    if (named) {
      tab = named;
      rest = path.slice(1);
    } else {
      gap = true;
    }
  } else if (!item.path && item.kind === "container") {
    gap = true;
  }
  const trail = item.kind === "container" ? [...rest, item] : rest;
  return { tab, trail, gap: gap && trail.length > 0 };
}

function asItem(ancestor: Ancestor | Tab): Item {
  return {
    id: ancestor.id,
    title: ancestor.title,
    kind: "container",
    icon: ancestor.icon,
    selectable: ancestor.selectable,
    unselectableReason: ancestor.unselectableReason,
    choice: ancestor.choice,
  };
}

function NodeIcon({
  icons,
  name,
  kind,
}: {
  icons: Record<string, unknown> | undefined;
  name: string | undefined;
  kind: Item["kind"] | null;
}) {
  const custom = name && icons && Object.hasOwn(icons, name) ? icons[name] : undefined;
  if (!custom && kind === null) return null;
  return (
    <span
      aria-hidden="true"
      className="flex size-5 shrink-0 items-center justify-center text-muted-foreground [&>svg]:size-5"
    >
      {custom ? (custom as ReactNode) : kind === "container" ? <FolderIcon /> : <FileIcon />}
    </span>
  );
}

export function HierarchyPicker(props: HierarchyPickerProps) {
  const generation = useFrame().generation(props.name);
  // A new root or a new set of tabs starts the picker afresh.
  const tabIds = (props.tabs ?? []).map((tab) => tab.id).join("\u0000");
  return <Picker key={[props.name, generation, props.root.id, tabIds].join("\u0001")} {...props} />;
}

function Picker({
  value,
  root,
  tabs: givenTabs,
  loadItems,
  loadItem,
  onChange,
  icons,
  searchPlaceholder,
  disabled = false,
}: HierarchyPickerProps) {
  const field = useField();
  const base = useId();
  const tabs = givenTabs && givenTabs.length > 0 ? givenTabs : null;
  const [location, setLocation] = useState<Location>({
    tab: tabs?.[0] ?? null,
    trail: [],
    gap: false,
  });
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [listing, setListing] = useState<Listing>({ status: "loading" });
  const [reload, setReload] = useState(0);
  /** A chosen node the listing may not show (a pre-filled leaf), shown atop it. */
  const [pinned, setPinned] = useState<Item | null>(null);
  const latest = useRef({ loadItems, loadItem, onChange, value });
  latest.current = { loadItems, loadItem, onChange, value };
  const requests = useRef(0);

  const open = location.trail.at(-1) ?? location.tab ?? null;
  const parentId = open?.id ?? root.id;
  const searching = search !== "";

  /** Moving or searching lets go of the choice, except the root's, which is always in view. */
  const letGo = () => {
    const current = latest.current.value;
    if (current && current !== root.id) latest.current.onChange(null, null);
  };

  const navigate = (next: Location) => {
    letGo();
    setPinned(null);
    setQuery("");
    setSearch("");
    setLocation(next);
  };

  const commitSearch = (next: string) => {
    if (next === search) return;
    letGo();
    setPinned(null);
    setSearch(next);
  };

  // The typed search goes out once typing pauses.
  // biome-ignore lint/correctness/useExhaustiveDependencies: commitSearch reads current state.
  useEffect(() => {
    if (query === search) return;
    const timer = setTimeout(() => commitSearch(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, search]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reload` is the Retry trigger.
  useEffect(() => {
    const request = ++requests.current;
    setListing({ status: "loading" });
    Promise.resolve()
      .then(() => latest.current.loadItems({ parentId, query: search, cursor: null }))
      .then(
        (raw) => {
          if (request !== requests.current) return;
          const page = cleanPage(raw);
          setListing(
            page.unavailable
              ? { status: "unavailable", message: page.unavailable }
              : {
                  status: "ready",
                  items: page.items,
                  nextCursor: page.nextCursor ?? null,
                  notice: page.notice,
                  more: { status: "idle" },
                },
          );
        },
        (error: unknown) => {
          if (request !== requests.current) return;
          setListing({
            status: "failed",
            message: failureMessage(error, "Couldn't load this list."),
          });
        },
      );
  }, [parentId, search, reload]);

  const loadMore = () => {
    if (listing.status !== "ready" || !listing.nextCursor) return;
    const request = requests.current;
    const cursor = listing.nextCursor;
    setListing({ ...listing, more: { status: "loading" } });
    Promise.resolve()
      .then(() => latest.current.loadItems({ parentId, query: search, cursor }))
      .then(
        (raw) => {
          if (request !== requests.current) return;
          const page = cleanPage(raw);
          setListing((current) =>
            current.status !== "ready"
              ? current
              : {
                  status: "ready",
                  items: [...current.items, ...page.items],
                  nextCursor: page.nextCursor ?? null,
                  // A later page's notice replaces the last; a page without one keeps it.
                  notice: page.notice ?? current.notice,
                  more: { status: "idle" },
                },
          );
        },
        (error: unknown) => {
          if (request !== requests.current) return;
          setListing((current) =>
            current.status !== "ready"
              ? current
              : {
                  ...current,
                  more: { status: "failed", message: failureMessage(error, "Couldn't load more.") },
                },
          );
        },
      );
  };

  const items = listing.status === "ready" ? listing.items : [];
  const inView = (id: string) =>
    id === root.id ||
    (!searching && open?.id === id) ||
    pinned?.id === id ||
    items.some((item) => item.id === id);

  // A value the picker is not showing (pre-filled, or set by the module) is looked up and opened
  // where it lives; one that cannot be shown as that choice is let go of.
  const resolving = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the value or what is in view changes.
  useEffect(() => {
    if (!value) return;
    if (value === root.id) {
      if (!root.selectable) latest.current.onChange(null, null);
      return;
    }
    if (inView(value) || resolving.current === value) return;
    const lookup = latest.current.loadItem;
    if (!lookup) {
      latest.current.onChange(null, null);
      return;
    }
    resolving.current = value;
    Promise.resolve()
      .then(() => lookup(value))
      .then(cleanItem, () => null)
      .then((item) => {
        if (resolving.current === value) resolving.current = null;
        if (latest.current.value !== value) return;
        if (!item || item.id !== value || item.selectable === false) {
          latest.current.onChange(null, null);
          return;
        }
        setQuery("");
        setSearch("");
        setLocation((current) => locationOf(item, tabs, current.tab));
        setPinned(item.kind === "leaf" ? item : null);
      });
  }, [value, listing, location, pinned]);

  const choose = (id: string) => {
    if (id === root.id) {
      latest.current.onChange(root.id, {
        id: root.id,
        title: root.title,
        kind: "container",
        icon: root.icon,
      });
      return;
    }
    if (open && id === open.id) {
      latest.current.onChange(id, asItem(open));
      return;
    }
    const item = (pinned?.id === id ? pinned : null) ?? items.find((entry) => entry.id === id);
    if (item) latest.current.onChange(id, item);
  };

  const radioValue = value ?? "";
  const listName = `${base}list`;

  // ----- Above the list: the root's choice, tabs and search, breadcrumb -----

  const rootChoice = root.selectable ? (
    <RadioGroup
      value={radioValue}
      onValueChange={choose}
      disabled={disabled}
      aria-label={`All of ${root.title}`}
      className="gap-0"
    >
      <ChoiceRow
        id={`${base}root`}
        value={root.id}
        title={`All of ${root.title}`}
        subtitle={root.subtitle}
        icon={<NodeIcon icons={icons} name={root.icon} kind={null} />}
        checked={value === root.id}
      />
    </RadioGroup>
  ) : null;

  const searchBox = searchPlaceholder ? (
    <Input
      type="search"
      value={query}
      placeholder={searchPlaceholder}
      aria-label={searchPlaceholder}
      aria-controls={listName}
      disabled={disabled}
      className={cn("h-8", searching || query ? "flex-1" : tabs ? "w-48" : "w-44")}
      onChange={(event) => setQuery(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commitSearch(query);
        } else if (event.key === "Escape" && query) {
          event.preventDefault();
          event.stopPropagation();
          setQuery("");
          commitSearch("");
        }
      }}
    />
  ) : null;

  const crumbs: { key: string; title: string; to: Location | null }[] = [];
  if (tabs) {
    if (location.tab) {
      crumbs.push({
        key: location.tab.id,
        title: location.tab.title,
        to: { tab: location.tab, trail: [], gap: false },
      });
    }
  } else {
    crumbs.push({ key: root.id, title: root.title, to: { tab: null, trail: [], gap: false } });
  }
  if (location.gap) crumbs.push({ key: "\u0000gap", title: "…", to: null });
  location.trail.forEach((ancestor, index) => {
    crumbs.push({
      key: ancestor.id,
      title: ancestor.title,
      to: { tab: location.tab, trail: location.trail.slice(0, index + 1), gap: location.gap },
    });
  });
  const showCrumbs = !searching && !query && (!tabs || location.trail.length > 0);
  const breadcrumb = showCrumbs ? (
    <nav aria-label="Location" className="min-w-0 flex-1">
      <ol className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <li key={crumb.key} className="flex min-w-0 items-center gap-1">
              {index > 0 ? (
                <ChevronRightIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
              ) : null}
              {last || !crumb.to ? (
                <span
                  className={cn("truncate", last ? "font-medium" : "text-muted-foreground")}
                  aria-current={last ? "location" : undefined}
                >
                  {crumb.title}
                </span>
              ) : (
                <UIButton
                  type="button"
                  variant="link"
                  size="xs"
                  disabled={disabled}
                  className="h-auto min-w-0 truncate p-0 text-muted-foreground"
                  onClick={() => crumb.to && navigate(crumb.to)}
                >
                  {crumb.title}
                </UIButton>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  ) : null;

  // ----- The list -----

  const openChoice =
    !searching && open && (location.trail.length > 0 || location.tab?.selectable === true)
      ? open
      : null;
  const openChoiceRow = openChoice ? (
    openChoice.selectable !== false ? (
      <ChoiceRow
        id={`${base}open`}
        value={openChoice.id}
        title={openChoice.choice?.title ?? `Everything in ${openChoice.title}`}
        subtitle={openChoice.choice?.subtitle}
        icon={<NodeIcon icons={icons} name={openChoice.icon} kind="container" />}
        checked={value === openChoice.id}
      />
    ) : openChoice.unselectableReason ? (
      <p className="px-3 py-2 text-muted-foreground text-sm">{openChoice.unselectableReason}</p>
    ) : null
  ) : null;

  const pinnedRow =
    pinned && !items.some((item) => item.id === pinned.id) ? (
      <LeafRow item={pinned} base={base} icons={icons} value={value} showPath={false} />
    ) : null;

  let body: ReactNode;
  if (listing.status === "loading") {
    body = (
      <div className="grid gap-2 p-3" role="status" aria-busy="true">
        <span className="sr-only">Loading…</span>
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-5 w-4/5" />
        <Skeleton className="h-5 w-3/5" />
      </div>
    );
  } else if (listing.status === "failed" || listing.status === "unavailable") {
    body = (
      <div className="grid justify-items-start gap-2 p-3 text-sm">
        <p
          role={listing.status === "failed" ? "alert" : undefined}
          className={listing.status === "failed" ? "text-destructive" : "text-muted-foreground"}
        >
          {listing.message}
        </p>
        <UIButton
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => setReload((count) => count + 1)}
        >
          Retry
        </UIButton>
      </div>
    );
  } else {
    body = (
      <>
        {listing.notice ? (
          <p className="px-3 py-2 text-muted-foreground text-sm">{listing.notice}</p>
        ) : null}
        {listing.items.map((item) =>
          item.kind === "container" ? (
            <ContainerRow
              key={item.id}
              item={item}
              icons={icons}
              showPath={searching}
              disabled={disabled}
              onOpen={() => navigate(locationOf(item, tabs, location.tab))}
            />
          ) : (
            <LeafRow
              key={item.id}
              item={item}
              base={base}
              icons={icons}
              value={value}
              showPath={searching}
            />
          ),
        )}
        {listing.items.length === 0 && !listing.notice && !pinnedRow ? (
          <p className="px-3 py-2 text-muted-foreground text-sm">
            {searching ? "No matches." : "Nothing here."}
          </p>
        ) : null}
        {listing.more.status === "failed" ? (
          <div className="flex items-center gap-2 px-3 py-2 text-sm">
            <span role="alert" className="flex-1 text-destructive">
              {listing.more.message}
            </span>
            <UIButton type="button" variant="outline" size="sm" onClick={loadMore}>
              Retry
            </UIButton>
          </div>
        ) : listing.nextCursor ? (
          <div className="px-3 py-2">
            <UIButton
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || listing.more.status === "loading"}
              aria-busy={listing.more.status === "loading" || undefined}
              onClick={loadMore}
            >
              {listing.more.status === "loading" ? "Loading…" : "Load more"}
            </UIButton>
          </div>
        ) : null}
      </>
    );
  }

  const list = (
    <RadioGroup
      id={listName}
      value={radioValue}
      onValueChange={choose}
      disabled={disabled}
      aria-labelledby={field?.labelId}
      aria-describedby={field?.descriptionId}
      aria-busy={listing.status === "loading" || undefined}
      className="max-h-96 gap-0 divide-y overflow-y-auto"
    >
      {openChoiceRow}
      {pinnedRow}
      {body}
    </RadioGroup>
  );

  return (
    <div className="grid min-w-0 gap-2" data-configurator-picker="">
      {rootChoice ? <div className="rounded-md border">{rootChoice}</div> : null}
      <div className="min-w-0 rounded-md border">
        {tabs && location.tab ? (
          <Tabs
            value={location.tab.id}
            onValueChange={(id) => {
              const tab = tabs.find((candidate) => candidate.id === id);
              if (tab) navigate({ tab, trail: [], gap: false });
            }}
            className="gap-0"
          >
            <div className="flex min-w-0 items-center gap-2 border-b p-2">
              <TabsList className="min-w-0 overflow-x-auto">
                {tabs.map((tab) => (
                  <TabsTrigger key={tab.id} value={tab.id} disabled={disabled}>
                    <NodeIcon icons={icons} name={tab.icon} kind={null} />
                    {tab.title}
                  </TabsTrigger>
                ))}
              </TabsList>
              {searchBox}
            </div>
            {breadcrumb ? <div className="border-b px-3 py-2">{breadcrumb}</div> : null}
            <TabsContent value={location.tab.id}>{list}</TabsContent>
          </Tabs>
        ) : (
          <>
            {breadcrumb || searchBox ? (
              <div className="flex min-w-0 items-center gap-2 border-b px-3 py-2">
                {breadcrumb}
                {searchBox}
              </div>
            ) : null}
            {list}
          </>
        )}
      </div>
    </div>
  );
}

function ChoiceRow({
  id,
  value,
  title,
  subtitle,
  icon,
  checked,
}: {
  id: string;
  value: string;
  title: string;
  subtitle?: string;
  icon: ReactNode;
  checked: boolean;
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex cursor-pointer items-center gap-3 px-3 py-2 text-sm",
        checked && "bg-accent/50",
      )}
    >
      <RadioGroupItem id={id} value={value} aria-describedby={subtitle ? `${id}d` : undefined} />
      {icon}
      <span className="grid min-w-0 gap-0.5">
        <span className="truncate font-medium">{title}</span>
        {subtitle ? (
          <span id={`${id}d`} className="truncate text-muted-foreground text-xs">
            {subtitle}
          </span>
        ) : null}
      </span>
    </label>
  );
}

function pathText(item: Item): string | undefined {
  return item.path && item.path.length > 0
    ? item.path.map((ancestor) => ancestor.title).join(" › ")
    : undefined;
}

function LeafRow({
  item,
  base,
  icons,
  value,
  showPath,
}: {
  item: Item;
  base: string;
  icons: Record<string, unknown> | undefined;
  value: string | null | undefined;
  showPath: boolean;
}) {
  const id = `${base}item-${item.id}`;
  const selectable = item.selectable !== false;
  const detail = selectable ? item.subtitle : (item.unselectableReason ?? item.subtitle);
  const where = showPath ? pathText(item) : undefined;
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex items-center gap-3 px-3 py-2 text-sm",
        selectable ? "cursor-pointer" : "cursor-not-allowed text-muted-foreground",
        value === item.id && "bg-accent/50",
      )}
    >
      <RadioGroupItem
        id={id}
        value={item.id}
        disabled={!selectable}
        aria-describedby={detail || where ? `${id}d` : undefined}
      />
      <NodeIcon icons={icons} name={item.icon} kind="leaf" />
      <RowText item={item} detail={detail} where={where} detailId={`${id}d`} />
    </label>
  );
}

function ContainerRow({
  item,
  icons,
  showPath,
  disabled,
  onOpen,
}: {
  item: Item;
  icons: Record<string, unknown> | undefined;
  showPath: boolean;
  disabled: boolean;
  onOpen(): void;
}) {
  const where = showPath ? pathText(item) : undefined;
  return (
    <button
      type="button"
      disabled={disabled}
      className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm outline-none hover:bg-accent/50 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
      onClick={onOpen}
    >
      <span className="size-4 shrink-0" aria-hidden="true" />
      <NodeIcon icons={icons} name={item.icon} kind="container" />
      <RowText item={item} detail={item.subtitle} where={where} />
      <span className="sr-only">Open</span>
      <ChevronRightIcon
        className="ml-auto size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
    </button>
  );
}

function RowText({
  item,
  detail,
  where,
  detailId,
}: {
  item: Item;
  detail: string | undefined;
  where: string | undefined;
  detailId?: string;
}) {
  return (
    <span className="grid min-w-0 flex-1 gap-0.5">
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate">{item.title}</span>
        {item.badge ? (
          <Badge variant="secondary" className="shrink-0">
            {item.badge}
          </Badge>
        ) : null}
      </span>
      {detail || item.meta || where ? (
        <span id={detailId} className="flex min-w-0 gap-2 text-muted-foreground text-xs">
          <span className="truncate">{[where, detail].filter(Boolean).join(" · ")}</span>
          {item.meta ? <span className="ml-auto shrink-0">{item.meta}</span> : null}
        </span>
      ) : null}
    </span>
  );
}
