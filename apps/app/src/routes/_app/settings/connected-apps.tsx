// Settings → Connected apps (ADR 0021): the external MCP clients
// a user authorized over OAuth, with their scopes, when they connected and when they were last
// used, and a revoke button. Admins also see every user's apps and can revoke any of them.
// Revoking stops the app's access and refresh tokens at once (connectedApp.revoke).

import type { CoreOutput } from "@crm/core";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@crm/ui/components/alert-dialog";
import { Badge } from "@crm/ui/components/badge";
import { Button } from "@crm/ui/components/button";
import { Checkbox } from "@crm/ui/components/checkbox";
import { Input } from "@crm/ui/components/input";
import { Label } from "@crm/ui/components/label";
import { Skeleton } from "@crm/ui/components/skeleton";
import { createFileRoute } from "@tanstack/react-router";
import { CopyIcon, PlugIcon, UnplugIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "#/components/empty-state";
import { PageLayout } from "#/components/layout/page-layout";
import { formatDate, formatDateTime, formatRelative } from "#/lib/format";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

export const Route = createFileRoute("/_app/settings/connected-apps")({
  component: ConnectedAppsPage,
});

type App = CoreOutput<"connectedApp.list">["items"][number];

function ConnectedAppsPage() {
  const { isAdmin } = Route.useRouteContext();
  const [includeRevoked, setIncludeRevoked] = useState(false);
  const mine = useOp("connectedApp.list", { includeRevoked });
  return (
    <PageLayout
      title="Connected apps"
      width="lg"
      back={{ to: "/settings", label: "Settings" }}
      description="AI apps you have let use the CRM for you over MCP. They act as you, within the scopes you granted, and risky changes still wait in Approvals."
    >
      <McpAddress />
      <section className="grid gap-3" aria-labelledby="my-apps">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="my-apps" className="text-lg font-semibold">
            Your apps
          </h2>
          <div className="flex-1" />
          <div className="flex items-center gap-2">
            <Checkbox
              id="include-revoked"
              checked={includeRevoked}
              onCheckedChange={(v) => setIncludeRevoked(v === true)}
            />
            <Label htmlFor="include-revoked" className="text-sm font-normal">
              Show disconnected
            </Label>
          </div>
        </div>
        <AppList
          query={mine}
          label="Your connected apps"
          empty="No apps connected yet. Add the address above as a custom connector in your MCP client."
          showUser={false}
        />
      </section>
      {isAdmin && <EveryonesApps includeRevoked={includeRevoked} />}
    </PageLayout>
  );
}

/** The /mcp address to paste into an MCP client's "add custom connector" setting. */
function McpAddress() {
  const [url, setUrl] = useState("");
  useEffect(() => setUrl(`${window.location.origin}/mcp`), []);
  return (
    <div className="grid gap-1.5 rounded-lg border p-3">
      <Label htmlFor="mcp-url">MCP server address</Label>
      <div className="flex gap-2">
        <Input id="mcp-url" readOnly value={url} className="font-mono text-sm" />
        <Button
          variant="outline"
          size="icon"
          aria-label="Copy address"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(url)
              .then(() => toast.success("Copied"))
              .catch(() => toast.error("Could not copy"));
          }}
        >
          <CopyIcon />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        In your MCP client, add a custom connector (remote MCP server), paste this address and sign
        in.
      </p>
    </div>
  );
}

function EveryonesApps({ includeRevoked }: { includeRevoked: boolean }) {
  const all = useOp("connectedApp.listAll", { includeRevoked });
  return (
    <section className="grid gap-3" aria-labelledby="all-apps">
      <div className="grid gap-0.5">
        <h2 id="all-apps" className="text-lg font-semibold">
          Everyone's apps
        </h2>
        <p className="text-sm text-muted-foreground">
          Admins can disconnect any user's app, for example when someone leaves.
        </p>
      </div>
      <AppList
        query={all}
        label="Every user's connected apps"
        empty="Nobody has connected an app yet."
        showUser
      />
    </section>
  );
}

function AppList({
  query,
  label,
  empty,
  showUser,
}: {
  query: ReturnType<typeof useOp<"connectedApp.list">>;
  label: string;
  empty: string;
  showUser: boolean;
}) {
  if (query.isPending) return <Skeleton className="h-24" />;
  if (query.isError) {
    return <EmptyState title="Could not load apps" description={errorMessage(query.error)} />;
  }
  if (!query.data.items.length) {
    return <EmptyState icon={PlugIcon} title="No connected apps" description={empty} />;
  }
  return (
    <ul className="grid divide-y rounded-md border" aria-label={label}>
      {query.data.items.map((app) => (
        <AppRow key={app.id} app={app} showUser={showUser} />
      ))}
    </ul>
  );
}

function AppRow({ app, showUser }: { app: App; showUser: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const revoke = useOpMutation("connectedApp.revoke", { invalidates: ["connectedApp."] });

  async function onRevoke() {
    try {
      await revoke.mutateAsync({ id: app.id });
      setConfirming(false);
      toast.success(`Disconnected ${app.clientName}`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <li
      className="flex flex-wrap items-center gap-3 px-3 py-3 text-sm"
      data-testid="connected-app"
      data-app={app.id}
    >
      <PlugIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{app.clientName}</span>
          {app.scopes.map((scope) => (
            <Badge key={scope} variant="outline" className="rounded-sm px-1.5 font-normal">
              {scope}
            </Badge>
          ))}
          {!app.active && (
            <Badge variant="secondary">
              {app.revokeReason === "replaced" ? "Replaced" : "Disconnected"}
            </Badge>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          {showUser && `${app.userName ?? app.userEmail ?? app.userId} · `}
          Connected <time dateTime={app.createdAt}>{formatDate(app.createdAt)}</time> · last used{" "}
          {app.lastUsedAt ? (
            <time dateTime={app.lastUsedAt} title={formatDateTime(app.lastUsedAt)}>
              {formatRelative(app.lastUsedAt)}
            </time>
          ) : (
            "never"
          )}
          {app.redirectHost ? ` · ${app.redirectHost}` : ""}
          {app.revokedAt && ` · disconnected ${formatDate(app.revokedAt)}`}
        </span>
      </div>
      {app.active && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setConfirming(true)}
          aria-label={`Revoke ${app.clientName}${showUser && app.userName ? ` for ${app.userName}` : ""}`}
        >
          <UnplugIcon />
          Revoke
        </Button>
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {app.clientName}?</AlertDialogTitle>
            <AlertDialogDescription>
              It stops working immediately: its access and refresh tokens are revoked and it must be
              connected again to use the CRM. Changes it queued stay in Approvals.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void onRevoke();
              }}
              disabled={revoke.isPending}
            >
              {revoke.isPending ? "Revoking…" : "Revoke"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}
