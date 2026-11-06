// Settings → Plugins (ADR 0347): for admins. What is installed for the workspace, teams and roles,
// who can install from the marketplace, members' requests, and installing for a team.
import type { CoreOutput } from "@relationship-os/core";
import { Badge } from "@relationship-os/ui/components/badge";
import { Button } from "@relationship-os/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@relationship-os/ui/components/card";
import { Checkbox } from "@relationship-os/ui/components/checkbox";
import { Input } from "@relationship-os/ui/components/input";
import { Label } from "@relationship-os/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@relationship-os/ui/components/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@relationship-os/ui/components/select";
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import { Switch } from "@relationship-os/ui/components/switch";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState, ErrorState } from "#/components/empty-state";
import { PageLayout } from "#/components/layout/page-layout";
import { PLUGIN_INVALIDATES } from "#/components/plugins/install-dialog";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

export const Route = createFileRoute("/_app/settings/plugins")({ component: PluginSettingsPage });

type List = CoreOutput<"plugin.list">;

const MODES = [
  { value: "anyone", label: "Anyone can install", help: "" },
  { value: "approval", label: "Ask an admin first", help: "Members request, an admin approves." },
  { value: "off", label: "Off", help: "Only built-in and workspace plugins." },
] as const;

function WorkspacePlugins({ list }: { list: List }) {
  const shared = list.installed.filter((i) => i.scope !== "personal");
  if (!shared.length) {
    return <EmptyState title="Nothing installed for others" description="Install one below." />;
  }
  return (
    <div className="grid gap-2 text-sm" data-testid="workspace-plugins">
      {shared.map((copy) => (
        <div key={copy.id} className="flex flex-wrap items-center gap-2 border-b pb-2">
          <span className="font-medium">{copy.name}</span>
          <span className="text-muted-foreground">{copy.scopeLabel}</span>
          <Badge variant="outline">{copy.locked ? "Locked" : "Own copies"}</Badge>
          <span className="text-muted-foreground">{copy.version}</span>
          {copy.update.plan === "approve" || copy.update.plan === "compare" ? (
            <Button asChild size="sm" variant="outline" className="ml-auto">
              <Link to="/plugins" search={{ tab: "installed" }}>
                {copy.update.version} waiting: Review
              </Link>
            </Button>
          ) : (
            <span className="ml-auto text-muted-foreground">Automatic</span>
          )}
        </div>
      ))}
    </div>
  );
}

function Requests({ list }: { list: List }) {
  const decide = useOpMutation("plugin.decideRequest", PLUGIN_INVALIDATES);
  if (!list.requests.length) return null;
  const on = { onError: (error: Error) => toast.error(errorMessage(error)) };
  return (
    <div className="grid gap-2 text-sm">
      <h3 className="font-medium">Requests</h3>
      {list.requests.map((r) => (
        <div key={r.id} className="flex flex-wrap items-center gap-2" data-testid="plugin-request">
          <span>
            {r.requester} wants {r.name}
          </span>
          <span className="text-xs text-muted-foreground">{r.publisher}</span>
          <div className="ml-auto flex gap-2">
            <Button size="sm" onClick={() => decide.mutate({ id: r.id, approve: true }, on)}>
              Approve
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => decide.mutate({ id: r.id, approve: false }, on)}
            >
              Decline
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

function InstallForTeam({ list }: { list: List }) {
  const users = useOp("user.list", {});
  const propose = useOpMutation("plugin.propose", {});
  const install = useOpMutation("plugin.install", PLUGIN_INVALIDATES);
  const [plugin, setPlugin] = useState("");
  const [name, setName] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [locked, setLocked] = useState(true);
  const chosen = list.available.find((a) => a.id === plugin);

  async function run() {
    if (!chosen) return;
    try {
      const scope = { kind: "team" as const, name, members, locked };
      const out = await propose.mutateAsync({ plugin, source: chosen.source, scope });
      await install.mutateAsync({
        plugin,
        version: out.version,
        source: out.source,
        fingerprint: out.fingerprint,
        scope,
      });
      toast.success(`${chosen.name} installed for ${name}`);
      setPlugin("");
      setMembers([]);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <div className="grid gap-3 text-sm" data-testid="install-for-team">
      <div className="grid gap-1.5">
        <Label>Plugin</Label>
        <Select value={plugin} onValueChange={setPlugin}>
          <SelectTrigger aria-label="Plugin">
            <SelectValue placeholder="Choose a plugin" />
          </SelectTrigger>
          <SelectContent>
            {list.available.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="team-name">Team</Label>
        <Input
          id="team-name"
          placeholder="Account management team"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="grid gap-1.5">
        <Label>Members</Label>
        {users.data?.items.map((user) => (
          <div key={user.id} className="flex items-center gap-2">
            <Checkbox
              id={`member-${user.id}`}
              checked={members.includes(user.id)}
              onCheckedChange={(on) =>
                setMembers(on ? [...members, user.id] : members.filter((m) => m !== user.id))
              }
            />
            <Label htmlFor={`member-${user.id}`} className="font-normal">
              {user.name}
            </Label>
          </div>
        ))}
      </div>
      <div className="flex items-start gap-2">
        <Switch id="team-locked" checked={locked} onCheckedChange={setLocked} />
        <Label htmlFor="team-locked" className="grid gap-0.5 font-normal">
          <span>Locked</span>
          <span className="text-xs text-muted-foreground">
            Members can't change it and you handle updates. They can still make their own copy.
          </span>
        </Label>
      </div>
      <Button
        className="w-fit"
        disabled={!chosen || !name.trim() || !members.length || install.isPending}
        onClick={run}
      >
        Install for {members.length} {members.length === 1 ? "person" : "people"}
      </Button>
    </div>
  );
}

function PluginSettingsPage() {
  const list = useOp("plugin.list", {});
  const update = useOpMutation("plugin.updateSettings", PLUGIN_INVALIDATES);
  return (
    <PageLayout
      title="Plugins"
      back={{ to: "/settings", label: "Settings" }}
      description="Plugins installed for the whole workspace, teams or roles, and who can install from the marketplace."
      width="narrow"
    >
      {list.isPending && <Skeleton className="h-48 w-full" />}
      {list.isError && <ErrorState error={list.error} />}
      {list.data && (
        <div className="grid gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Workspace plugins</CardTitle>
            </CardHeader>
            <CardContent>
              <WorkspacePlugins list={list.data} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Marketplace</CardTitle>
              <CardDescription>
                {list.data.marketplaceAvailable
                  ? "Listings here are reviewed before anyone can install them."
                  : "This deployment isn't connected to the marketplace."}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <RadioGroup
                value={list.data.marketplace}
                onValueChange={(value) =>
                  update.mutate(
                    { marketplace: value as (typeof MODES)[number]["value"] },
                    { onError: (error) => toast.error(errorMessage(error)) },
                  )
                }
              >
                {MODES.map((mode) => (
                  <div key={mode.value} className="flex items-start gap-2">
                    <RadioGroupItem value={mode.value} id={`mode-${mode.value}`} />
                    <Label htmlFor={`mode-${mode.value}`} className="grid gap-0.5 font-normal">
                      <span>{mode.label}</span>
                      {mode.help && (
                        <span className="text-xs text-muted-foreground">{mode.help}</span>
                      )}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
              <Requests list={list.data} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Install for a team</CardTitle>
            </CardHeader>
            <CardContent>
              <InstallForTeam list={list.data} />
            </CardContent>
          </Card>
        </div>
      )}
    </PageLayout>
  );
}
