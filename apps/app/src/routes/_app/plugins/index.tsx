// Plugins (ADR 0347): Marketplace to browse and install, Installed for your copies with their
// updates, Your workspace for what was made here. Each install is your own copy. In the product,
// subagents are "Agent profiles", and "routine" is fine on this page.
import type { CoreOutput } from "@relationship-os/core";
import { Badge } from "@relationship-os/ui/components/badge";
import { Button } from "@relationship-os/ui/components/button";
import { Card, CardContent } from "@relationship-os/ui/components/card";
import { Input } from "@relationship-os/ui/components/input";
import { Label } from "@relationship-os/ui/components/label";
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@relationship-os/ui/components/tabs";
import { Textarea } from "@relationship-os/ui/components/textarea";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { LockIcon, SparklesIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useOptionalAssistant } from "#/components/assistant/assistant-provider";
import { EmptyState, ErrorState } from "#/components/empty-state";
import { PageLayout } from "#/components/layout/page-layout";
import { InstallDialog, PLUGIN_INVALIDATES } from "#/components/plugins/install-dialog";
import { formatDate } from "#/lib/format";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

const TABS = ["marketplace", "installed", "workspace"] as const;
type Tab = (typeof TABS)[number];

export const Route = createFileRoute("/_app/plugins/")({
  validateSearch: (search: Record<string, unknown>): { tab?: Tab } =>
    TABS.includes(search.tab as Tab) && search.tab !== "marketplace"
      ? { tab: search.tab as Tab }
      : {},
  component: PluginsPage,
});

type List = CoreOutput<"plugin.list">;
type Copy = List["installed"][number];
type Source = "first_party" | "workspace" | "marketplace";

interface Listing {
  id: string;
  name: string;
  publisher: string;
  description: string;
  version: string;
  adds: { kind: string; count: number }[];
  connections: string[];
  installs?: number | undefined;
  source: Source;
  installed: boolean;
}

const KIND_WORDS: Record<string, string> = {
  skill: "skill",
  workspaceSkill: "skill",
  routine: "routine",
  agentProfile: "agent profile",
  producer: "chat card",
  savedCode: "saved code",
  dashboard: "dashboard",
  sharedDashboard: "dashboard",
  savedView: "view",
  widget: "widget",
};

function addsWords(adds: Listing["adds"]) {
  return adds
    .filter((a) => a.kind !== "connectionNeed" && a.kind !== "assistantPreset")
    .map((a) => {
      const word = KIND_WORDS[a.kind] ?? a.kind;
      return `${a.count} ${word}${a.count === 1 || word === "saved code" ? "" : "s"}`;
    });
}

const SOURCE_BADGE: Record<Source, string> = {
  first_party: "Built-in",
  workspace: "Your workspace",
  marketplace: "Reviewed",
};

function ListingCard({ listing, onInstall }: { listing: Listing; onInstall: () => void }) {
  return (
    <Card data-testid="plugin-card" data-plugin={listing.id}>
      <CardContent className="grid gap-2">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <Link
              to="/plugins/$id"
              params={{ id: listing.id }}
              search={{ source: listing.source }}
              className="font-medium hover:underline"
            >
              {listing.name}
            </Link>
            <div className="truncate text-xs text-muted-foreground">{listing.publisher}</div>
          </div>
          <Badge variant="outline">
            {listing.installed ? "Installed" : SOURCE_BADGE[listing.source]}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">{listing.description}</p>
        <div className="flex flex-wrap gap-1">
          {addsWords(listing.adds).map((word) => (
            <Badge key={word} variant="secondary">
              {word}
            </Badge>
          ))}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {listing.connections.length
              ? `Needs ${listing.connections.join(", ")}`
              : "No connections"}
          </span>
          {!listing.installed && (
            <Button size="sm" variant="outline" onClick={onInstall}>
              Install
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Marketplace({ list }: { list: List }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | Source>("all");
  const [installing, setInstalling] = useState<Listing | null>(null);
  const remote = useOp("marketplace.search", query ? { query } : {});
  const have = new Set(list.installed.map((i) => i.plugin));
  const listings: Listing[] = [
    ...list.available,
    ...(remote.data?.listings ?? []).map((l) => ({
      ...l,
      source: "marketplace" as const,
      installed: have.has(l.id),
    })),
  ].filter(
    (l) =>
      (filter === "all" || l.source === filter) &&
      `${l.name} ${l.description} ${l.publisher}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Search plugins"
          placeholder="Search plugins"
          className="max-w-xs"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Tabs value={filter} onValueChange={(v) => setFilter(v as typeof filter)}>
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="first_party">Built-in</TabsTrigger>
            <TabsTrigger value="marketplace">Reviewed</TabsTrigger>
            <TabsTrigger value="workspace">Your workspace</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {list.marketplace === "off" && (
        <p className="text-sm text-muted-foreground">
          An admin turned the marketplace off. Built-in and workspace plugins are here.
        </p>
      )}
      {list.marketplace === "approval" && (
        <p className="text-sm text-muted-foreground">
          An admin approves marketplace plugins before they install.
        </p>
      )}
      {listings.length ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {listings.map((listing) => (
            <ListingCard
              key={`${listing.source}:${listing.id}`}
              listing={listing}
              onInstall={() => setInstalling(listing)}
            />
          ))}
        </div>
      ) : (
        <EmptyState title="No plugins found" description="Try other words." />
      )}
      {installing && (
        <InstallDialog
          plugin={installing.id}
          name={installing.name}
          source={installing.source}
          onClose={() => setInstalling(null)}
        />
      )}
    </div>
  );
}

function CopyStatus({ copy }: { copy: Copy }) {
  if (copy.locked) {
    return (
      <span>
        Installed for {copy.scopeLabel}. You can't change it, and updates are handled for everyone.
        Make your own copy if you want to change it.
      </span>
    );
  }
  if (!copy.following) {
    return (
      <span>
        Not following updates
        {copy.detachedAt ? ` since ${formatDate(copy.detachedAt)}` : ""}.{" "}
        {copy.update.version
          ? `${copy.update.version} is out. Resuming compares it with your copy first.`
          : "You won't hear about new versions. Your copy stays as it is."}
      </span>
    );
  }
  switch (copy.update.plan) {
    case "compare":
      return (
        <span>
          {copy.update.version} is out. You changed {copy.changed.length}{" "}
          {copy.changed.length === 1 ? "thing" : "things"}, so it needs a merge.
        </span>
      );
    case "approve":
      return <span>{copy.update.version} is out, and it asks for something new.</span>;
    case "auto":
      return <span>{copy.update.version} is out. It will apply by itself.</span>;
    default:
      return (
        <span>
          {copy.changed.length
            ? "Following updates. You've changed your copy, so new versions will need a merge."
            : "Following updates. Unchanged, so updates apply by themselves."}
        </span>
      );
  }
}

function widenedWords(copy: Copy) {
  const w = copy.update.widening;
  return [
    ...w.connections.map((c) => `Use ${c}`),
    ...w.operations.map((o) => `Call ${o}`),
    ...w.schema.map((s) => `Change ${s}`),
  ];
}

function CopyCard({ copy }: { copy: Copy }) {
  const navigate = useNavigate();
  const on = { onError: (error: Error) => toast.error(errorMessage(error)) };
  const detach = useOpMutation("plugin.detach", PLUGIN_INVALIDATES);
  const reattach = useOpMutation("plugin.reattach", PLUGIN_INVALIDATES);
  const update = useOpMutation("plugin.update", PLUGIN_INVALIDATES);
  const remove = useOpMutation("plugin.uninstall", PLUGIN_INVALIDATES);
  const check = useOpMutation("plugin.checkNeeds", PLUGIN_INVALIDATES);
  const accept = useOpMutation("plugin.acceptPreset", {
    invalidates: ["plugin.", "memory."],
  });
  const widened = widenedWords(copy);
  const label = copy.locked ? "Locked" : copy.changed.length ? "Your copy, changed" : "Your copy";
  return (
    <Card data-testid="plugin-copy" data-plugin={copy.plugin}>
      <CardContent className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/plugins/$id"
            params={{ id: copy.plugin }}
            search={{ source: copy.source }}
            className="font-medium hover:underline"
          >
            {copy.name}
          </Link>
          <span className="text-xs text-muted-foreground">{copy.version}</span>
          <Badge variant={copy.locked ? "secondary" : "outline"} data-testid="plugin-copy-state">
            {copy.locked && <LockIcon className="size-3" />}
            {label}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground" data-testid="plugin-copy-status">
          <CopyStatus copy={copy} />
        </p>
        {copy.update.plan === "approve" && widened.length > 0 && (
          <ul className="list-disc pl-4 text-sm" data-testid="plugin-widening">
            {widened.map((line) => (
              <li key={line}>+ {line}</li>
            ))}
          </ul>
        )}
        {copy.waiting.map((reason) => (
          <p key={reason} className="text-sm text-amber-700 dark:text-amber-300">
            Waiting: {reason}
          </p>
        ))}
        <div className="flex flex-wrap gap-2">
          {copy.update.plan === "compare" && copy.canEdit && (
            <Button
              size="sm"
              onClick={() =>
                navigate({ to: "/plugins/compare/$installId", params: { installId: copy.id } })
              }
            >
              Compare
            </Button>
          )}
          {(copy.update.plan === "approve" || copy.update.plan === "auto") && copy.canEdit && (
            <Button
              size="sm"
              onClick={() =>
                update.mutate({ id: copy.id, approveAccess: copy.update.plan === "approve" }, on)
              }
            >
              Update
            </Button>
          )}
          {copy.waiting.length > 0 && (
            <>
              <Button asChild size="sm">
                <Link to="/settings/integrations">Connect</Link>
              </Button>
              <Button size="sm" variant="outline" onClick={() => check.mutate({ id: copy.id }, on)}>
                Check again
              </Button>
            </>
          )}
          {copy.offered.map((key) => (
            <Button
              key={key}
              size="sm"
              variant="outline"
              onClick={() =>
                accept.mutate(
                  { id: copy.id, key },
                  {
                    ...on,
                    onSuccess: (out) =>
                      toast.success(
                        out.refused.length
                          ? `Saved ${out.saved.length}. Left out: ${out.refused[0]?.reason}.`
                          : "Saved to what your assistant remembers",
                      ),
                  },
                )
              }
            >
              Add the starter to my assistant
            </Button>
          ))}
          {copy.scope === "personal" && copy.following && (
            <Button size="sm" variant="ghost" onClick={() => detach.mutate({ id: copy.id }, on)}>
              Stop updates
            </Button>
          )}
          {copy.scope === "personal" && !copy.following && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (copy.update.version) {
                  navigate({
                    to: "/plugins/compare/$installId",
                    params: { installId: copy.id },
                    search: { resume: true },
                  });
                } else {
                  reattach.mutate({ id: copy.id, compared: copy.version }, on);
                }
              }}
            >
              Resume updates
            </Button>
          )}
          {copy.scope !== "personal" && !copy.canEdit && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => detach.mutate({ id: copy.id, ownCopy: true }, on)}
            >
              Make my own copy
            </Button>
          )}
          {copy.canEdit && (
            <Button size="sm" variant="ghost" onClick={() => remove.mutate({ id: copy.id }, on)}>
              Remove
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Installed({ list }: { list: List }) {
  if (!list.installed.length) {
    return (
      <EmptyState
        title="Nothing installed yet"
        description="Add skills, dashboards, views and things your assistant does for you."
      />
    );
  }
  return (
    <div className="grid gap-3" data-testid="plugins-installed">
      {list.installed.map((copy) => (
        <CopyCard key={copy.id} copy={copy} />
      ))}
    </div>
  );
}

const MARKETPLACE_WORDS: Record<string, string> = {
  in_review: "In marketplace review",
  approved: "In the marketplace",
  rejected: "Not accepted",
};

/** Adds a plugin.json to the workspace's private registry: a new plugin or a new version. */
function AddToWorkspace() {
  const publish = useOpMutation("plugin.publish", PLUGIN_INVALIDATES);
  const [text, setText] = useState("");
  function add() {
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(text) as Record<string, unknown>;
    } catch {
      toast.error("That isn't valid JSON");
      return;
    }
    publish.mutate(
      { to: "workspace", manifest },
      {
        onSuccess: (out) => {
          toast.success(`${out.plugin} ${out.version} is in your workspace`);
          setText("");
        },
        onError: (error) => toast.error(errorMessage(error)),
      },
    );
  }
  return (
    <Card>
      <CardContent className="grid gap-2">
        <Label htmlFor="plugin-json">Add a plugin.json</Label>
        <Textarea
          id="plugin-json"
          rows={4}
          className="font-mono text-xs"
          placeholder='{ "id": "partner-deals", "name": "Partner deals", "version": "1.0.0", … }'
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Button size="sm" className="w-fit" disabled={!text.trim()} onClick={add}>
          Add to your workspace
        </Button>
      </CardContent>
    </Card>
  );
}

function Workspace({ list, isAdmin }: { list: List; isAdmin: boolean }) {
  const publish = useOpMutation("plugin.publish", PLUGIN_INVALIDATES);
  return (
    <div className="grid gap-2">
      {isAdmin && <AddToWorkspace />}
      {!list.workspace.length && (
        <EmptyState
          title="Nothing made here yet"
          description='Ask your assistant to "bundle this as a plugin", then add it here.'
        />
      )}
      {list.workspace.map((p) => (
        <Card key={`${p.plugin}@${p.version}`}>
          <CardContent className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{p.name}</span>
            <span className="text-xs text-muted-foreground">{p.version}</span>
            <Badge variant="outline">
              {p.marketplaceStatus
                ? (MARKETPLACE_WORDS[p.marketplaceStatus] ?? p.marketplaceStatus)
                : "Workspace only"}
            </Badge>
            {p.marketplaceReason && (
              <span className="text-xs text-muted-foreground">{p.marketplaceReason}</span>
            )}
            {isAdmin && list.marketplaceAvailable && !p.marketplaceStatus && (
              <Button
                size="sm"
                variant="outline"
                className="ml-auto"
                onClick={() =>
                  publish.mutate(
                    { to: "marketplace", plugin: p.plugin, version: p.version },
                    {
                      onSuccess: () => toast.success("Sent for review"),
                      onError: (error) => toast.error(errorMessage(error)),
                    },
                  )
                }
              >
                Send to the marketplace
              </Button>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function PluginsPage() {
  const { isAdmin } = Route.useRouteContext();
  const { tab = "marketplace" } = Route.useSearch();
  const navigate = useNavigate({ from: "/plugins/" });
  const assistant = useOptionalAssistant();
  const list = useOp("plugin.list", {});
  return (
    <PageLayout
      title="Plugins"
      description="Add skills, dashboards, views and things your assistant does for you. Each install is your own copy."
      actions={
        assistant && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => assistant.ask({ prompt: "Help me make a plugin that " })}
          >
            <SparklesIcon />
            Make one with the assistant
          </Button>
        )
      }
      tabs={
        <Tabs
          value={tab}
          onValueChange={(value) =>
            navigate({ search: value === "marketplace" ? {} : { tab: value as Tab } })
          }
        >
          <TabsList>
            <TabsTrigger value="marketplace">Marketplace</TabsTrigger>
            <TabsTrigger value="installed">
              Installed ({list.data?.installed.length ?? 0})
            </TabsTrigger>
            <TabsTrigger value="workspace">
              Your workspace ({list.data?.workspace.length ?? 0})
            </TabsTrigger>
          </TabsList>
        </Tabs>
      }
    >
      {list.isPending && <Skeleton className="h-48 w-full" />}
      {list.isError && <ErrorState title="Could not load plugins" error={list.error} />}
      {list.data && tab === "marketplace" && <Marketplace list={list.data} />}
      {list.data && tab === "installed" && <Installed list={list.data} />}
      {list.data && tab === "workspace" && <Workspace list={list.data} isAdmin={isAdmin} />}
    </PageLayout>
  );
}
